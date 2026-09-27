import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { X3Camera } from '../lib/x3.js';
import { MediaCache, validCameraPath } from '../lib/media.js';
import { createMockCamera } from './mock-camera.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const opts = { skip: !hasFfmpeg && 'ffmpeg not installed' };
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-media-'));
const ffmpeg = (...args) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const probe = (file) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width',
  '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim().split('\n');
const isJpeg = (buf) => buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));

// Clips made like the X3's: H.264 Baseline + IMA ADPCM in .MOV.
const VIDEO = '/SD/Video/X3-TEST-2S.MOV';
const SHORT = '/SD/Video/X3-TEST-SHORT.MOV';
const PHOTO = '/SD/Photo/X3-TEST.JPG';
const BROKEN = '/SD/Video/X3-180103-212343F.MOV'; // mock placeholder: 1 KB of zeros

let mock, cam, server, base;
before(async () => {
  if (!hasFfmpeg) return;
  const clip = (file, secs) => ffmpeg('-f', 'lavfi', '-i', `testsrc=size=640x360:rate=30:duration=${secs}`,
    '-f', 'lavfi', '-i', `sine=duration=${secs}:sample_rate=32000`, '-c:v', 'libx264', '-profile:v', 'baseline',
    '-pix_fmt', 'yuv420p', '-c:a', 'adpcm_ima_wav', '-ac', '2', '-f', 'mov', path.join(tmp, file));
  clip('video.mov', 2);
  clip('short.mov', 0.5);
  ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=1280x720', '-frames:v', '1', path.join(tmp, 'photo.jpg'));

  mock = createMockCamera({ media: {
    [VIDEO]: path.join(tmp, 'video.mov'), [SHORT]: path.join(tmp, 'short.mov'), [PHOTO]: path.join(tmp, 'photo.jpg'),
  } });
  await new Promise((r) => mock.server.listen(0, r));
  cam = new X3Camera({ host: `localhost:${mock.server.address().port}` });

  const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  server = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), X3_HOST: cam.host, X3_CACHE_DIR: path.join(tmp, 'server-cache') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => server.stdout.once('data', r));
  base = `http://localhost:${port}`;
});
after(() => {
  server?.kill();
  mock?.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('camera paths are validated', () => {
  assert.equal(validCameraPath('/SD/Video/a.MOV'), true);
  assert.equal(validCameraPath('/etc/passwd'), false);
  assert.equal(validCameraPath('/SD/../etc/passwd'), false);
  assert.equal(validCameraPath(undefined), false);
});

test('playable copies H.264, converts audio to AAC and caches the result', opts, async () => {
  const media = new MediaCache(cam, { dir: path.join(tmp, 'play') });
  let converts = 0;
  const convert = media._convert.bind(media);
  media._convert = (...a) => { converts++; return convert(...a); };

  // Concurrent requests share one job.
  const [a, b] = await Promise.all([media.playable(VIDEO), media.playable(VIDEO)]);
  assert.equal(a, b);
  assert.equal(converts, 1);
  assert.deepEqual(probe(a), ['h264,640', 'aac']);
  assert.match(path.basename(a), /^Video_X3-TEST-2S\.MOV-\d+\.mp4$/);

  assert.equal(await media.playable(VIDEO), a);
  assert.equal(converts, 1);
  assert.deepEqual(fs.readdirSync(media.dir), [path.basename(a)]);
});

test('failed conversion rejects with 502 and leaves nothing behind', opts, async () => {
  const media = new MediaCache(cam, { dir: path.join(tmp, 'fail') });
  await assert.rejects(media.playable(BROKEN), (e) => e.status === 502 && /Could not process/.test(e.message));
  assert.deepEqual(fs.readdirSync(media.dir), []);
  await assert.rejects(media.playable('/SD/Video/NOPE.MOV'), (e) => e.status === 404);
});

test('thumbnails for videos, very short clips and photos', opts, async () => {
  const media = new MediaCache(cam, { dir: path.join(tmp, 'thumb') });
  for (const p of [VIDEO, SHORT, PHOTO]) {
    const file = await media.thumbnail(p);
    assert.ok(isJpeg(fs.readFileSync(file)), p);
    assert.deepEqual(probe(file), ['mjpeg,320'], p);
  }
});

test('GET /play serves mp4 with Range support', opts, async () => {
  const full = await fetch(`${base}/play?path=${VIDEO}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.match(full.headers.get('cache-control'), /max-age=\d{6,}/);
  const size = (await full.arrayBuffer()).byteLength;

  const part = await fetch(`${base}/play?path=${VIDEO}`, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-1023/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 1024);

  const tail = await fetch(`${base}/play?path=${VIDEO}`, { headers: { Range: 'bytes=-100' } });
  assert.equal(tail.headers.get('content-range'), `bytes ${size - 100}-${size - 1}/${size}`);
  const past = await fetch(`${base}/play?path=${VIDEO}`, { headers: { Range: `bytes=${size}-` } });
  assert.equal(past.status, 416);
});

test('GET /thumb serves a JPEG; bad paths are rejected', opts, async () => {
  const res = await fetch(`${base}/thumb?path=${PHOTO}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.ok(isJpeg(Buffer.from(await res.arrayBuffer())));

  assert.equal((await fetch(`${base}/thumb?path=/SD/../x`)).status, 400);
  assert.equal((await fetch(`${base}/play?path=/etc/passwd`)).status, 400);
  assert.equal((await fetch(`${base}/play?path=${PHOTO}`)).status, 400);
  assert.equal((await fetch(`${base}/play?path=/SD/Video/NOPE.MOV`)).status, 404);
  const broken = await fetch(`${base}/play?path=${BROKEN}`);
  assert.equal(broken.status, 502);
  assert.match((await broken.json()).error, /Could not process/);
});
