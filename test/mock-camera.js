#!/usr/bin/env node
// Fake KB X3 for offline testing: PORT=8080 node test/mock-camera.js
// then:  X3_HOST=localhost:8080 node cli.js status
import http from 'node:http';
import fs from 'node:fs';
import { PROPERTIES, FILES, PHOTOS } from './fixtures.js';

// media: { '/SD/Video/X.MOV': '/local/file' } serves real files (with Range
// support, like the camera) in addition to the 1 KB placeholders.
export function createMockCamera({ media = {} } = {}) {
  const props = new Map(PROPERTIES.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const files = FILES.map((f) => [...f]);
  const log = [];
  const ok = (extra = '') => `0\nOK\n${extra}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // Like the real firmware: URL-decode the whole query first, then split on '&'.
    let decoded;
    try { decoded = decodeURIComponent(url.search.slice(1)); } catch { decoded = url.search.slice(1); }
    const q = Object.fromEntries(decoded.split('&').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    log.push(url.pathname + url.search);
    const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(body); };

    if (url.pathname.startsWith('/SD/')) {
      const name = decodeURIComponent(url.pathname);
      const type = name.endsWith('.JPG') ? 'image/jpeg' : 'video/quicktime';
      if (media[name]) {
        const data = fs.readFileSync(media[name]);
        const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        const start = r ? Number(r[1]) : 0;
        const end = r && r[2] ? Math.min(Number(r[2]), data.length - 1) : data.length - 1;
        res.writeHead(r ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1,
          ...(r && { 'Content-Range': `bytes ${start}-${end}/${data.length}` }) });
        return res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
      }
      const f = files.find((x) => x[0] === name);
      if (!f) return send('Not found', 404);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': 1024 });
      return res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(1024));
    }
    if (url.pathname !== '/cgi-bin/Config.cgi') return send('Not found', 404);

    if (q.action === 'get') {
      const want = q.property.endsWith('*') ? q.property.slice(0, -1) : q.property;
      const lines = [...props].filter(([k]) => (q.property.endsWith('*') ? k.startsWith(want) : k === want));
      return send(lines.length ? ok(lines.map(([k, v]) => `${k}=${v}\n`).join('')) : '703\nERROR\n');
    }
    if (q.action === 'set') {
      const rec = 'Camera.Preview.MJPEG.status.record';
      if (q.property === 'Video' && q.value === 'record') props.set(rec, props.get(rec) === 'Recording' ? 'Standby' : 'Recording');
      else if (q.property === 'Video' && q.value === 'capture') { /* photo */ }
      else if (q.property === 'Net' && q.value === 'reset') { /* wifi restart */ }
      else if (q.property === 'TimeSettings') { /* clock */ }
      else if (props.has(q.property)) props.set(q.property, q.property.endsWith('CryptoKey') ? q.value.slice(0, 35) : q.value);
      else {
        // Like the X3: some menu items have a different write name, values are
        // validated (701), and "OFF" reads back truncated to "OF".
        const menu = `Camera.Menu.${{ Videores: 'VideoRes', Imageres: 'ImageRes' }[q.property] ?? q.property}`;
        if (!props.has(menu) || ['VideoRes', 'ImageRes'].includes(q.property)) return send('703\nUnknown CGI-PARAM: Property\n');
        if (q.value === 'BOGUS') return send('701\nIllegal Parameter\n');
        props.set(menu, /(SoundIndicator|StatusLights)$/.test(menu) && q.value.toUpperCase() === 'OFF' ? 'OF' : q.value);
      }
      return send(ok());
    }
    if (q.action === 'dir' && q.property === 'Photo') {
      const from = Number(q.from || 0);
      const page = PHOTOS.slice(from, from + Number(q.count || 16));
      const xml = page.map(([name, size, bytes, when]) =>
        `<file>\n\t<name>${name}</name>\n\t<format size="${size}">jpeg</format>\n\t<size>${bytes}</size>\n\t<attr>RW</attr>\n\t<time>${when}</time>\n</file>\n`).join('');
      return send(`<?xml version="1.0" encoding="UTF-8" ?>\n<Photo>\n${xml}<amount>${page.length}</amount>\n</Photo>\n`);
    }
    if (q.action === 'dir') {
      const from = Number(q.from || 0);
      const page = files.slice(from, from + Number(q.count || 16));
      const xml = page.map(([name, size, fps, time, bytes, when]) =>
        `<file>\n<name>${name}</name>\n<format size="${size}" fps="${fps}" time="${time}">MOV</format>\n<size>${bytes}</size>\n<attr>RW</attr>\n<time>${when}</time>\n</file>\n`).join('');
      return send(`<DCIM>\n${xml}<amount>${page.length}</amount>\n</DCIM>\n`);
    }
    if (q.action === 'del') {
      const i = files.findIndex((f) => f[0] === q.property.replace(/\$/g, '/'));
      if (i < 0) return send('705\nERROR\n');
      files.splice(i, 1);
      return send(ok());
    }
    send('702\nERROR\n');
  });
  return { server, props, files, log };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  createMockCamera().server.listen(port, () => console.log(`Mock X3 on http://localhost:${port}`));
}
