import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockCamera } from './mock-camera.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-server-'));
let mock, server, base, cameraHost;

before(async () => {
  mock = createMockCamera();
  await new Promise((r) => mock.server.listen(0, r));
  cameraHost = `localhost:${mock.server.address().port}`;
  const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  server = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), X3_HOST: cameraHost, X3_CACHE_DIR: tmp },
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

const json = (method, body, headers = {}) => ({
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
});

test('raw get/set endpoints are gone', async () => {
  assert.equal((await fetch(`${base}/api/get?property=Net.*`)).status, 404);
  assert.equal((await fetch(`${base}/api/set`, json('POST', { property: 'Net.Dev.1.Start', value: '0' }))).status, 404);
});

test('writes need a JSON content type and a matching Origin', async () => {
  assert.equal((await fetch(`${base}/api/photo`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/photo`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/photo`, json('POST', {}, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await fetch(`${base}/api/photo`, json('POST', {}, { Origin: base }))).status, 200);
  assert.equal((await fetch(`${base}/api/photo`, json('POST'))).status, 200);
});

test('read-only settings stay read-only with the Camera.Menu. prefix', async () => {
  for (const name of ['FWversion', 'Camera.Menu.FWversion']) {
    const res = await fetch(`${base}/api/settings/${name}`, json('PUT', { value: 'x' }));
    assert.equal(res.status, 400);
  }
  assert.ok(!mock.log.some((l) => l.includes('action=set') && l.includes('FWversion')));
});

test('camera-host rejects bad addresses and keeps the current one', async () => {
  for (const body of [{}, { host: 'http://192.168.1.50' }, { host: 'fe80::1' }, { host: '1.2.3.4:99999' }]) {
    assert.equal((await fetch(`${base}/api/camera-host`, json('PUT', body))).status, 400);
  }
  const w = await (await fetch(`${base}/api/wifi`)).json();
  assert.equal(w.cameraHost, cameraHost);
  assert.equal(w.autoHost, false);
});
