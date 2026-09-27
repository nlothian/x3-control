#!/usr/bin/env node
// REST API + web UI for the Kaiser Baas X3.
//   PORT=3000 X3_HOST=192.72.1.1 node server.js   ->  http://localhost:3000
//   X3_CACHE_DIR sets where converted videos/thumbnails go (default ./cache).

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { X3Camera } from './lib/x3.js';
import { SETTINGS, normaliseValue } from './lib/settings-meta.js';
import { MediaCache, serveFile, validCameraPath, isPhoto } from './lib/media.js';

const PORT = Number(process.env.PORT || 3000);
const cam = new X3Camera();
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, 'public');
const media = new MediaCache(cam, { dir: process.env.X3_CACHE_DIR || path.join(rootDir, 'cache') });
// Camera file names are unique (timestamped), so converted copies never change.
const LONG_CACHE = 'private, max-age=31536000, immutable';

const readJson = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});

// [method, path regex, handler(match, body, url) -> JSON result]
const routes = [
  ['GET', /^\/api\/status$/, () => cam.status()],
  ['GET', /^\/api\/info$/, () => cam.info()],
  ['GET', /^\/api\/settings$/, () => cam.settings()],
  // Settings with labels and allowed options, for building a form.
  ['GET', /^\/api\/settings\/meta$/, async () => {
    const values = await cam.settings();
    const order = Object.keys(SETTINGS);
    const rank = (n) => (order.includes(n) ? order.indexOf(n) : order.length);
    return Object.entries(values).sort(([a], [b]) => rank(a) - rank(b)).map(([name, value]) => ({
      name, value: normaliseValue(name, value), ...(SETTINGS[name] ?? { label: name, free: true }),
    }));
  }],
  ['PUT', /^\/api\/settings\/([\w.-]+)$/, async ([, name], { value }) => {
    if (SETTINGS[name]?.readOnly) throw Object.assign(new Error(`${name} is read-only`), { status: 400 });
    return { name, value: normaliseValue(name, await cam.setSetting(name, value)) };
  }],
  ['GET', /^\/api\/preview$/, () => cam.preview()],
  ['GET', /^\/api\/get$/, (m, b, url) => cam.get(url.searchParams.get('property'))],
  ['POST', /^\/api\/set$/, async (m, { property, value }) => ({ ok: await cam.set(property, value) })],
  ['POST', /^\/api\/clock$/, async () => ({ ok: await cam.syncClock() })],
  ['POST', /^\/api\/photo$/, async () => ({ ok: await cam.takePhoto() })],
  ['POST', /^\/api\/record\/start$/, async () => ({ changed: await cam.startRecording() })],
  ['POST', /^\/api\/record\/stop$/, async () => ({ changed: await cam.stopRecording() })],
  ['POST', /^\/api\/record\/toggle$/, async () => ({ ok: await cam.toggleRecord() })],
  ['GET', /^\/api\/files$/, (m, b, url) => {
    const type = url.searchParams.get('type') === 'photo' ? 'photo' : 'video';
    return url.searchParams.has('all') ? cam.listAllFiles({ type })
      : cam.listFiles({ type, from: Number(url.searchParams.get('from') || 0), count: Number(url.searchParams.get('count') || 16) });
  }],
  ['DELETE', /^\/api\/files$/, async (m, b, url) => ({ ok: await cam.deleteFile(url.searchParams.get('path')) })],
  ['GET', /^\/api\/wifi$/, async () => { const { raw, ...w } = await cam.wifi(); return w; }],
  ['GET', /^\/api\/live$/, () => ({ rtsp: cam.rtspUrl, mjpeg: '/live.mjpeg' })],
];

// The X3 only offers live view as RTSP (H.264), which browsers can't play,
// so transcode it to multipart MJPEG with ffmpeg for an <img> tag.
function liveMjpeg(req, res) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-i', cam.rtspUrl,
    '-an', '-f', 'mpjpeg', '-q:v', '5', '-r', '15', 'pipe:1',
  ]);
  let started = false;
  let stderr = '';
  ffmpeg.stderr.on('data', (d) => (stderr += d));
  ffmpeg.stdout.once('data', () => {
    started = true;
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=ffmpeg', 'Cache-Control': 'no-store' });
  });
  ffmpeg.stdout.on('data', (chunk) => res.write(chunk));
  ffmpeg.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(err.code === 'ENOENT' ? 'Live view needs ffmpeg installed (brew install ffmpeg)' : err.message);
  });
  ffmpeg.on('close', () => {
    if (!started && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(`Could not open camera stream: ${stderr.trim() || 'no data'}`);
    }
    res.end();
  });
  req.on('close', () => ffmpeg.kill('SIGKILL'));
}

// Pipe a camera URL straight through (media files).
async function proxy(res, cameraPath, { download } = {}) {
  const upstream = await cam.openStream(cameraPath);
  const headers = { 'Content-Type': upstream.headers['content-type'] || 'application/octet-stream' };
  if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.posix.basename(cameraPath)}"`;
  // Camera file names are unique (timestamped), so let the browser cache them.
  else headers['Cache-Control'] = 'private, max-age=86400';
  res.writeHead(upstream.statusCode, headers);
  upstream.pipe(res);
  res.on('close', () => upstream.destroy());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/live.mjpeg') return liveMjpeg(req, res);
    if (['/media', '/play', '/thumb'].includes(url.pathname)) {
      const p = url.searchParams.get('path') || '';
      if (!validCameraPath(p)) { res.writeHead(400); return res.end('path must start with /SD/ and not contain ..'); }
      if (url.pathname === '/media') return await proxy(res, p, { download: url.searchParams.has('download') });
      if (url.pathname === '/thumb') {
        return serveFile(req, res, await media.thumbnail(p), { 'Content-Type': 'image/jpeg', 'Cache-Control': LONG_CACHE });
      }
      if (isPhoto(p)) { res.writeHead(400); return res.end('/play is for videos'); }
      return serveFile(req, res, await media.playable(p), { 'Content-Type': 'video/mp4', 'Cache-Control': LONG_CACHE });
    }

    for (const [method, re, handler] of routes) {
      const m = url.pathname.match(re);
      if (m && req.method === method) {
        const body = ['POST', 'PUT'].includes(method) ? await readJson(req) : {};
        const result = await handler(m, body, url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result, null, 2));
      }
    }

    if (req.method === 'GET') {
      const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);
      if (file.startsWith(publicDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    if (res.headersSent) return res.destroy();
    // 701 = the camera rejected the value; anything else is a camera/network failure.
    const status = err.status ?? (err.code === 701 ? 400 : 502);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.code === 701 ? `Camera rejected that value (${err.message})` : err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`X3 control on http://localhost:${PORT}  (camera: ${cam.host})`);
});
