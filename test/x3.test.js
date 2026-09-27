import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X3Camera, parseKeyValues } from '../lib/x3.js';
import { createMockCamera } from './mock-camera.js';

let mock, cam;
before(async () => {
  mock = createMockCamera();
  await new Promise((r) => mock.server.listen(0, r));
  cam = new X3Camera({ host: `localhost:${mock.server.address().port}` });
});
after(() => mock.server.close());

test('parses key/value responses', () => {
  const r = parseKeyValues('0\nOK\nA.B=1\nA.C=x=y\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { 'A.B': '1', 'A.C': 'x=y' });
  assert.equal(parseKeyValues('703\nERROR\n').ok, false);
});

test('status and settings', async () => {
  assert.deepEqual(await cam.status(), { mode: 'Videomode', record: 'Standby', recording: false });
  const s = await cam.settings();
  assert.equal(s.VideoRes, '2.7K30');
  assert.equal(s.FWversion, 'KBX3');
});

test('wildcards are sent unencoded', async () => {
  await cam.get('Camera.Menu.*');
  assert.ok(mock.log.at(-1).includes('property=Camera.Menu.*'));
});

test('record start/stop is idempotent', async () => {
  assert.equal(await cam.startRecording(), true);
  assert.equal((await cam.status()).recording, true);
  assert.equal(await cam.startRecording(), false);
  assert.equal(await cam.stopRecording(), true);
  assert.equal((await cam.status()).recording, false);
});

test('setting a menu value uses write names and confirms', async () => {
  assert.equal(await cam.setSetting('VideoRes', '1080P30'), '1080P30');
  assert.ok(mock.log.some((l) => l.includes('property=Videores&value=1080P30')));
  assert.equal((await cam.settings()).VideoRes, '1080P30');
  // OFF reads back as "OF" but still counts as confirmed.
  assert.equal(await cam.setSetting('SoundIndicator', 'OFF'), 'OF');
  await assert.rejects(cam.setSetting('Flicker', 'BOGUS'), (e) => e.code === 701);
});

test('discoverOptions reports accepted values and restores the original', async () => {
  const r = await cam.discoverOptions('Flicker', ['60Hz', 'BOGUS', '50Hz']);
  assert.deepEqual(r, { original: '50Hz', accepted: ['60Hz', '50Hz'] });
  assert.equal((await cam.settings()).Flicker, '50Hz');
});

test('info', async () => {
  assert.deepEqual(await cam.info(), { battery: 75, photosRemaining: 2876, recordRemainingSec: 3842, fileCount: 7, firmwareUpdate: 'idle' });
});

test('clock uses $-separated value', async () => {
  await cam.syncClock(new Date(2026, 8, 27, 9, 5, 3));
  assert.ok(mock.log.at(-1).endsWith('property=TimeSettings&value=2026$09$27$09$05$03'));
});

test('file listing, paging, download and delete', async () => {
  const files = await cam.listFiles();
  assert.equal(files.length, 5);
  assert.deepEqual(files[0], {
    path: '/SD/Video/X3-180103-212343F.MOV', name: 'X3-180103-212343F.MOV', type: 'MOV',
    resolution: '2688x1520', fps: 30, duration: 7.6, size: 29884416, attr: 'RW', time: '2018-01-03 21:23:43',
  });
  assert.equal((await cam.listAllFiles({ pageSize: 2 })).length, 5);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-'));
  const dest = await cam.download(files[0].path, dir);
  assert.equal(fs.statSync(dest).size, 1024);

  await cam.deleteFile(files[4].path);
  assert.ok(mock.log.at(-1).includes('action=del&property=$SD$Video$X3-190606-180244F.MOV'));
  assert.equal((await cam.listFiles()).length, 4);
});

test('photo listing', async () => {
  const photos = await cam.listAllFiles({ type: 'photo' });
  assert.deepEqual(photos, [{
    path: '/SD/Photo/X3-260927-211002F.JPG', name: 'X3-260927-211002F.JPG', type: 'jpeg', resolution: '2704x1520',
    fps: undefined, duration: undefined, size: 1048576, attr: 'RW', time: '2026-09-27 21:10:02',
  }]);
  assert.ok(mock.log.at(-1).includes('action=dir&property=Photo'));
});

test('wifi summary and station profile', async () => {
  const w = await cam.wifi();
  assert.equal(w.hotspot.ssid, 'KB-X3');
  assert.equal(w.station.enabled, false);
  assert.equal(w.station.profiles.length, 8);

  await cam.setStationProfile({ slot: 1, ssid: 'Home Net', password: 'pa ss#word', encType: 'AES' });
  await cam.setStationEnabled(true);
  const w2 = await cam.wifi();
  assert.equal(w2.station.enabled, true);
  assert.equal(w2.station.profiles[0].ssid, 'Home Net');
  assert.equal(w2.raw['Net.WIFI_STA.AP.1.CryptoKey'], 'pa ss#word');
});

test('failed set raises', async () => {
  await assert.rejects(cam.set('NoSuchThing', '1'), (e) => e.code === 703);
});

test('requests are serialised', async () => {
  const results = await Promise.all([cam.status(), cam.settings(), cam.wifi(), cam.listFiles()]);
  assert.equal(results.length, 4);
});

test('mock mimics firmware: & truncates, keys capped at 35 chars', async () => {
  await cam.setStationProfile({ slot: 8, ssid: 'x', password: 'abcdefghijklm&nopqrstuvw' });
  assert.equal((await cam.get('Net.WIFI_STA.AP.8.CryptoKey'))['Net.WIFI_STA.AP.8.CryptoKey'], 'abcdefghijklm');
  await cam.set('Net.WIFI_STA.AP.8.CryptoKey', 'x'.repeat(64));
  assert.equal((await cam.get('Net.WIFI_STA.AP.8.CryptoKey'))['Net.WIFI_STA.AP.8.CryptoKey'].length, 35);
});
