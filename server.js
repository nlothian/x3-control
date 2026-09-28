#!/usr/bin/env node
// REST API + web UI for the Kaiser Baas X3.
//   PORT=3000 X3_HOST=192.72.1.1 node server.js   ->  http://localhost:3000
//   X3_CACHE_DIR sets where converted videos/thumbnails go (default ./cache).

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { X3Camera, DEFAULT_HOST } from './lib/x3.js';
import { SETTINGS, normaliseValue } from './lib/settings-meta.js';
import { MediaCache, serveFile, validCameraPath, isPhoto } from './lib/media.js';
import { discover, findCamera } from './lib/discover.js';

const PORT = Number(process.env.PORT || 3000);
// X3_HOST unset or "auto": find the camera, and look again whenever it stops
// answering. It gets a new MAC and IP each time it joins a network.
let autoHost = !process.env.X3_HOST || process.env.X3_HOST === 'auto';
const cam = new X3Camera({ host: autoHost ? DEFAULT_HOST : process.env.X3_HOST });
// The camera's last address on your network (for manual mode and messages).
let clientHost = cam.host === DEFAULT_HOST ? undefined : cam.host;

function useHost(host) {
  cam.setHost(host);
  if (cam.host !== DEFAULT_HOST) clientHost = cam.host;
}

// One search at a time, and at most every 15s, however many requests fail.
let searching = null;
let lastSearch = 0;
function rediscover({ force = false } = {}) {
  if (searching) return searching;
  if (!force && Date.now() - lastSearch < 15000) return Promise.resolve();
  lastSearch = Date.now();
  searching = findCamera().then((found) => {
    if (found && found.host !== cam.host) {
      console.log(`Camera found at ${found.host}`);
      useHost(found.host);
    }
  }).finally(() => { searching = null; });
  return searching;
}
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, 'public');
const media = new MediaCache(cam, { dir: process.env.X3_CACHE_DIR || path.join(rootDir, 'cache') });
// Camera file names are unique (timestamped), so converted copies never change.
const LONG_CACHE = 'private, max-age=31536000, immutable';

const readJson = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
});

// Other websites can send POSTs here from the user's browser. Requiring a JSON
// content type forces a CORS preflight (which this server never approves), and
// a browser-sent Origin must match the host it was sent to.
function sameOrigin(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // not sent by a browser page (curl, scripts)
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

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
  ['PUT', /^\/api\/settings\/([\w.-]+)$/, async ([, raw], { value }) => {
    const name = raw.replace(/^Camera\.Menu\./, '');
    if (SETTINGS[name]?.readOnly) throw Object.assign(new Error(`${name} is read-only`), { status: 400 });
    return { name, value: normaliseValue(name, await cam.setSetting(name, value)) };
  }],
  ['GET', /^\/api\/preview$/, () => cam.preview()],
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
  ['DELETE', /^\/api\/files$/, async (m, b, url) => {
    const p = url.searchParams.get('path');
    if (!validCameraPath(p)) throw Object.assign(new Error('path must start with /SD/ and not contain ..'), { status: 400 });
    return { ok: await cam.deleteFile(p) };
  }],
  // Wi-Fi: passwords are write-only; responses only say whether one is set.
  ['GET', /^\/api\/wifi$/, async () => {
    const { raw, ...w } = await cam.wifi();
    const mode = w.hotspot.enabled && !w.station.enabled ? 'hotspot' : !w.hotspot.enabled && w.station.enabled ? 'client' : 'mixed';
    return { ...w, hotspot: { ...w.hotspot, hasKey: Boolean(raw['Net.WIFI_AP.CryptoKey']) }, mode, cameraHost: cam.host, clientHost, autoHost };
  }],
  // "auto" goes back to finding the camera automatically.
  ['PUT', /^\/api\/camera-host$/, async (m, { host }) => {
    if (typeof host !== 'string') throw Object.assign(new Error('host must be an address or "auto"'), { status: 400 });
    if (host.trim() === 'auto') {
      autoHost = true;
      await rediscover({ force: true });
    } else {
      useHost(host); // throws on a bad address, leaving the current one in place
      autoHost = false;
    }
    return { cameraHost: cam.host, autoHost };
  }],
  // Full search of the hotspot address and local network; switches to the first camera found.
  ['POST', /^\/api\/discover$/, async () => {
    const found = await discover({ full: true });
    if (found.length) useHost(found[0].host);
    return { found, cameraHost: cam.host, autoHost };
  }],
  ['PUT', /^\/api\/wifi\/hotspot$/, async (m, { ssid, password }) => {
    if (password) X3Camera.checkStationPassword(password);
    await cam.setHotspot({ ssid: ssid || undefined, password: password || undefined });
    return { ok: true };
  }],
  ['PUT', /^\/api\/wifi\/networks\/([1-8])$/, async ([, slot], { ssid, password, encType }) => {
    await cam.saveStationProfile({ slot: Number(slot), ssid, password: password || undefined, encType });
    return { ok: true };
  }],
  ['DELETE', /^\/api\/wifi\/networks\/([1-8])$/, async ([, slot]) => ({ ok: await cam.clearStationProfile(Number(slot)) ?? true })],
  // Both switches restart the camera's Wi-Fi, so it drops off its current network.
  ['POST', /^\/api\/wifi\/hotspot-mode$/, async () => {
    const { hotspot } = await cam.wifi();
    useHost(cam.host);
    await cam.useHotspot();
    cam.setHost(DEFAULT_HOST);
    return { ok: true, hotspotName: hotspot.ssid, cameraHost: cam.host, clientHost, autoHost };
  }],
  ['POST', /^\/api\/wifi\/client-mode$/, async () => {
    await cam.useSavedNetworks();
    // It gets a new address when it joins; in auto mode the next failed
    // request starts a search, otherwise try its last known address.
    if (!autoHost && clientHost) cam.setHost(clientHost);
    return { ok: true, cameraHost: cam.host, clientHost, autoHost };
  }],
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
        if (method !== 'GET' && !sameOrigin(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Cross-site request refused' }));
        }
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
    if (autoHost && /Cannot reach|Timed out/.test(err.message)) rediscover();
    // 701 = the camera rejected the value; anything else is a camera/network failure.
    const status = err.status ?? (err.code === 701 || err.code === 'INVALID' ? 400 : 502);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.code === 701 ? `Camera rejected that value (${err.message})` : err.message }));
  }
});

server.listen(PORT, async () => {
  console.log(`X3 control on http://localhost:${PORT}`);
  if (autoHost) await rediscover({ force: true });
  console.log(`Camera: ${cam.host}${autoHost ? ' (found automatically; set X3_HOST to fix an address)' : ''}`);
});
