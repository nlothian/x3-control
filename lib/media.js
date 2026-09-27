// Browser-friendly copies of camera media, made with ffmpeg and cached on disk.
//
// The X3 records H.264 video with IMA ADPCM audio in .MOV, which browsers
// won't play, and its own /thumb endpoint returns 503. So we make:
//   playable(path)  -> .mp4 (H.264 + AAC, faststart), video copied when possible
//   thumbnail(path) -> 320px-wide .jpg (videos: ~1s in; photos: scaled down)
//
// ffmpeg reads straight from the camera over HTTP. The camera serves one
// request at a time, so jobs run one after another. Results are keyed by
// camera path + size, because camera file names repeat after a clock reset.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const THUMB_WIDTH = 320;
// Give up if the camera stops sending for this long (microseconds, for ffmpeg).
const RW_TIMEOUT = String(20e6);

export const isPhoto = (p) => /\.jpe?g$/i.test(p);

// Accepts only camera paths like /SD/Video/<file>.
export function validCameraPath(p) {
  return typeof p === 'string' && p.startsWith('/SD/') && !p.includes('..');
}

// Runs a command, resolving with stdout; rejects with the stderr text.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(e.code === 'ENOENT'
      ? Object.assign(new Error(`${cmd} not found: playback and thumbnails need ffmpeg (brew install ffmpeg)`), { status: 500 })
      : e));
    child.on('close', (code) => (code === 0 ? resolve(out)
      : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `${cmd} exited with ${code}`))));
  });
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export class MediaCache {
  // camera: an X3Camera (for mediaUrl and fileSize).
  constructor(camera, { dir, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
    this.camera = camera;
    this.dir = dir;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this._jobs = new Map(); // cache file -> promise, so repeat requests share one job
    this._queue = [];
    this._busy = false;
    this._sizes = new Map(); // camera path -> { size, at }
    fs.mkdirSync(dir, { recursive: true });
    // Leftovers from a run that was killed mid-conversion. Temp names carry the
    // pid, so another server sharing this directory keeps its in-progress files.
    for (const f of fs.readdirSync(dir)) {
      const pid = Number(f.match(/\.(\d+)\.part$/)?.[1]);
      if (pid && !isAlive(pid)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }

  // Path of a playable .mp4 for a camera video, converting it if needed.
  playable(cameraPath) {
    return this._cached(cameraPath, 'mp4', (src, out) => this._convert(src, out), {});
  }

  // Path of a small .jpg for a camera video or photo.
  thumbnail(cameraPath) {
    // Thumbnails take seconds, conversions minutes, so thumbnails jump the queue.
    return this._cached(cameraPath, 'thumb.jpg', (src, out) => this._thumb(src, out, isPhoto(cameraPath)), { urgent: true });
  }

  async _cached(cameraPath, ext, make, { urgent }) {
    const size = await this._size(cameraPath);
    const name = `${cameraPath.replace(/^\/SD\//, '').replace(/[^\w.-]/g, '_')}-${size}.${ext}`;
    const file = path.join(this.dir, name);
    if (fs.existsSync(file)) return file;
    if (!this._jobs.has(file)) {
      const job = this._schedule(async () => {
        if (fs.existsSync(file)) return file; // made while this job waited (e.g. by another server)
        const part = `${file}.${process.pid}.part`;
        try {
          await make(this.camera.mediaUrl(encodeURI(cameraPath)), part);
          if (!(fs.statSync(part, { throwIfNoEntry: false })?.size > 0)) throw new Error('ffmpeg produced no output');
          fs.renameSync(part, file);
          return file;
        } catch (err) {
          fs.rmSync(part, { force: true });
          throw Object.assign(new Error(`Could not process ${cameraPath}: ${err.message}`), { status: err.status ?? 502 });
        }
      }, urgent);
      this._jobs.set(file, job);
      job.finally(() => this._jobs.delete(file)).catch(() => {});
    }
    return this._jobs.get(file);
  }

  // Remembered briefly: a browser seeking through a video sends many Range
  // requests, and each would otherwise cost a camera round trip.
  async _size(cameraPath) {
    const hit = this._sizes.get(cameraPath);
    if (hit && Date.now() - hit.at < 60_000) return hit.size;
    let size;
    try { size = await this.camera.fileSize(cameraPath); } catch (err) {
      throw Object.assign(err, { status: err.code === 404 ? 404 : 502 });
    }
    this._sizes.set(cameraPath, { size, at: Date.now() });
    return size;
  }

  // One job at a time; urgent ones go to the front of the waiting list.
  _schedule(fn, urgent) {
    return new Promise((resolve, reject) => {
      const task = () => fn().then(resolve, reject);
      if (urgent) this._queue.unshift(task); else this._queue.push(task);
      this._next();
    });
  }

  async _next() {
    if (this._busy || !this._queue.length) return;
    this._busy = true;
    try { await this._queue.shift()(); } finally {
      this._busy = false;
      this._next();
    }
  }

  async _probe(src) {
    const out = await run(this.ffprobe, ['-v', 'error', '-rw_timeout', RW_TIMEOUT,
      '-show_entries', 'stream=codec_type,codec_name,profile,pix_fmt', '-of', 'json', src]);
    return JSON.parse(out).streams ?? [];
  }

  async _convert(src, out) {
    const video = (await this._probe(src)).find((s) => s.codec_type === 'video');
    if (!video) throw new Error('no video stream');
    // The X3 already records H.264 Baseline yuv420p, so only the audio
    // needs converting. Copying is many times faster than re-encoding.
    const copy = video.codec_name === 'h264' && video.pix_fmt === 'yuv420p'
      && /^(constrained baseline|baseline|main|high)$/i.test(video.profile ?? '');
    await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-rw_timeout', RW_TIMEOUT,
      '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
      ...(copy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']),
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', '-y', out]);
  }

  async _thumb(src, out, photo) {
    const args = (seek) => ['-hide_banner', '-loglevel', 'error', '-rw_timeout', RW_TIMEOUT,
      ...(seek ? ['-ss', '1'] : []), '-i', src, '-frames:v', '1',
      '-vf', `scale='min(${THUMB_WIDTH},iw)':-2`, '-q:v', '4', '-f', 'mjpeg', '-y', out];
    if (photo) return run(this.ffmpeg, args(false));
    // Seeking past the end of a very short clip fails or writes nothing: use the first frame.
    const ok = await run(this.ffmpeg, args(true)).then(() => fs.statSync(out).size > 0, () => false);
    if (!ok) await run(this.ffmpeg, args(false));
  }
}

// Sends a local file, honouring a single-range Range header (browsers need
// this to seek, and Safari won't play an MP4 without it).
export function serveFile(req, res, file, headers = {}) {
  const size = fs.statSync(file).size;
  const base = { 'Accept-Ranges': 'bytes', ...headers };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = size - 1;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    else start = Math.max(0, size - Number(m[2])); // "bytes=-N": the last N bytes
    if (start > end || start >= size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...base, 'Content-Length': size });
  }
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.pipe(res);
  res.on('close', () => stream.destroy());
}
