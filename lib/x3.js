// Client for the Kaiser Baas X3 action camera (AIT "CarDV" firmware).
//
// Protocol: plain HTTP GET to http://<host>/cgi-bin/Config.cgi
//   action=get&property=<Name or Prefix.*>   -> "0\nOK\nKey=Value\n..."
//   action=set&property=<Name>&value=<v>     -> "0\nOK\n" on success
//   action=dir&property=DCIM&format=all&count=N&from=M -> XML file list
//   action=del&property=$SD$Video$<file>     -> delete (path uses $ for /)
// Media:  http://<host>/SD/Video/<file>
// Live:   rtsp://<host>/liveRTSP/av<Camera.Preview.RTSP.av> (H.264 640x360;
//         the X3 has no HTTP MJPEG stream)
//
// The camera's web server handles one request at a time, so every request
// goes through a single queue.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { normaliseValue } from './settings-meta.js';

export const DEFAULT_HOST = '192.72.1.1';

// Menu settings whose write name differs from the Camera.Menu.<Name> they read as.
const WRITE_NAMES = { VideoRes: 'Videores', ImageRes: 'Imageres' };
const writeName = (name) => WRITE_NAMES[name] ?? name;

// Marks errors caused by bad input rather than by the camera (HTTP 400).
const INVALID = { code: 'INVALID' };

export class CameraError extends Error {
  constructor(message, { code, body } = {}) {
    super(message);
    this.code = code;
    this.body = body;
  }
}

// Parse "0\nOK\nKey=Value..." responses.
export function parseKeyValues(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const code = Number(lines[0]?.trim());
  const status = lines[1]?.trim();
  const values = {};
  for (const line of lines.slice(2)) {
    const i = line.indexOf('=');
    if (i > 0) values[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { code, status, ok: code === 0 && status === 'OK', values };
}

// Parse the <DCIM><file>...</file><amount>N</amount></DCIM> listing.
export function parseFileList(xml) {
  const tag = (s, name) => s.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
  const files = [];
  for (const [, block] of xml.matchAll(/<file>([\s\S]*?)<\/file>/g)) {
    const fmt = block.match(/<format([^>]*)>([^<]*)<\/format>/);
    const attr = (k) => fmt?.[1].match(new RegExp(`${k}="([^"]*)"`))?.[1];
    const name = tag(block, 'name');
    files.push({
      path: name,
      name: name ? path.posix.basename(name) : undefined,
      type: fmt?.[2],
      resolution: attr('size'),
      fps: attr('fps') ? Number(attr('fps')) : undefined,
      duration: attr('time') ? Number(attr('time')) : undefined,
      size: Number(tag(block, 'size')),
      attr: tag(block, 'attr'),
      time: tag(block, 'time'),
    });
  }
  const amount = Number(tag(xml, 'amount') ?? files.length);
  return { files, amount };
}

export class X3Camera {
  constructor({ host = process.env.X3_HOST || DEFAULT_HOST, timeout = 8000 } = {}) {
    this.setHost(host);
    this.timeout = timeout;
    this._queue = Promise.resolve();
  }

  // The camera's address changes when it switches between its hotspot
  // (192.72.1.1) and your network, so it can be changed at runtime.
  setHost(host) {
    const [hostname, port] = String(host).trim().split(':');
    if (!hostname) throw new CameraError('Camera address is empty', INVALID);
    this.host = port ? `${hostname}:${port}` : hostname;
    this._target = { host: hostname, port: port ? Number(port) : 80 };
  }

  get baseUrl() { return `http://${this.host}`; }
  get rtspUrl() { return `rtsp://${this._target.host}/liveRTSP/av4`; }
  mediaUrl(filePath) { return `${this.baseUrl}${filePath}`; }

  // --- low level -----------------------------------------------------------

  // Queue a function so only one request is in flight at a time.
  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  // Raw request returning { status, headers, body } (body as string).
  _request(urlPath, { method = 'GET' } = {}) {
    return this._enqueue(() => new Promise((resolve, reject) => {
      const req = http.request({
        ...this._target,
        method,
        path: urlPath,
        timeout: this.timeout,
        // Embedded web servers often send slightly malformed HTTP.
        insecureHTTPParser: true,
        headers: { Connection: 'close' },
      }, (res) => {
        // The camera sends a body with HEAD error responses, which breaks the
        // parser, so take the headers and hang up.
        if (method === 'HEAD') {
          resolve({ status: res.statusCode, headers: res.headers, body: '' });
          return req.destroy();
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
        res.on('error', reject);
      });
      req.end();
      req.on('timeout', () => req.destroy(new CameraError(`Timed out talking to camera at ${this.host}`)));
      req.on('error', (err) => reject(err instanceof CameraError ? err
        : new CameraError(`Cannot reach camera at ${this.host}: ${err.message}`)));
    }));
  }

  async cgi(params) {
    const qs = Object.entries(params)
      // The firmware expects literal '*' and '$', so only encode what must be encoded.
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%24/g, '$').replace(/%2A/gi, '*')}`)
      .join('&');
    const res = await this._request(`/cgi-bin/Config.cgi?${qs}`);
    if (res.status !== 200) {
      throw new CameraError(`Camera returned HTTP ${res.status}`, { code: res.status, body: res.body });
    }
    return res.body;
  }

  async get(property) {
    const r = parseKeyValues(await this.cgi({ action: 'get', property }));
    if (!r.ok) throw new CameraError(`get ${property} failed (${r.code} ${r.status})`, { code: r.code });
    return r.values;
  }

  async set(property, value) {
    const body = await this.cgi({ action: 'set', property, value });
    const r = parseKeyValues(body);
    if (!r.ok) throw new CameraError(`set ${property}=${value} failed (${r.code} ${r.status ?? ''})`.trim(), { code: r.code, body });
    return true;
  }

  // --- status & settings ---------------------------------------------------

  async status() {
    const p = await this.get('Camera.Preview.MJPEG.status.*');
    return {
      mode: p['Camera.Preview.MJPEG.status.mode'],
      record: p['Camera.Preview.MJPEG.status.record'],
      // Seen: "Standby". The recording value is assumed to contain "rec".
      recording: /rec/i.test(p['Camera.Preview.MJPEG.status.record'] ?? ''),
    };
  }

  // Battery and storage figures (Camera.* outside Menu/Preview).
  async info() {
    const c = await this.get('Camera.*');
    const num = (k) => (c[k] === undefined ? undefined : Number(c[k]));
    return {
      battery: num('Camera.Battery.Level'),
      photosRemaining: num('Camera.Capture.Remaining'),
      recordRemainingSec: num('Camera.Record.Remaining'),
      fileCount: num('Camera.File.Total'),
      firmwareUpdate: c['Camera.FWupdate.Progress'],
    };
  }

  async settings() {
    const menu = await this.get('Camera.Menu.*');
    return Object.fromEntries(Object.entries(menu).map(([k, v]) => [k.replace(/^Camera\.Menu\./, ''), v]));
  }

  // Menu settings are read as Camera.Menu.<Name> but set as <Name>.
  // The camera applies changes asynchronously and a single read can return a
  // stale value, so by default this waits until the new value reads back
  // `stableReads` times in a row, and returns what the camera reports.
  async setSetting(name, value, { confirm = true, timeoutMs = 5000, stableReads = 3, pollMs = 300 } = {}) {
    name = name.replace(/^Camera\.Menu\./, '');
    await this.set(writeName(name), value);
    if (!confirm) return value;
    const prop = `Camera.Menu.${name}`;
    const want = normaliseValue(name, value).toLowerCase();
    let current;
    let streak = 0;
    for (const start = Date.now(); Date.now() - start < timeoutMs;) {
      await new Promise((r) => setTimeout(r, pollMs));
      current = (await this.get(prop))[prop];
      streak = normaliseValue(name, current).toLowerCase() === want ? streak + 1 : 0;
      if (streak >= stableReads) return current;
    }
    throw new CameraError(`${name} accepted "${value}" but reads "${current}"`);
  }

  // Finds which candidate values a setting accepts by trying each one, then
  // restores the original. The camera answers 701 for values it doesn't support.
  // Each accepted value is waited on before the next, so changes can't pile up.
  async discoverOptions(name, candidates, { restoreValue, ...confirmOpts } = {}) {
    const prop = `Camera.Menu.${name}`;
    const original = (await this.get(prop))[prop];
    const accepted = [];
    try {
      for (const value of candidates) {
        try {
          await this.setSetting(name, value, confirmOpts);
          accepted.push(value);
        } catch (err) {
          if (err.code !== 701) throw err;
        }
      }
    } finally {
      // A reported value isn't always settable (e.g. "OF" for OFF), hence restoreValue.
      await this.setSetting(name, restoreValue ?? normaliseValue(name, original), confirmOpts);
    }
    return { original, accepted };
  }

  async preview() {
    return this.get('Camera.Preview.*');
  }

  // Camera clock, e.g. syncClock(new Date()).
  syncClock(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const v = [date.getFullYear(), p(date.getMonth() + 1), p(date.getDate()),
      p(date.getHours()), p(date.getMinutes()), p(date.getSeconds())].join('$');
    return this.set('TimeSettings', v);
  }

  // --- actions -------------------------------------------------------------

  // Toggles recording on the camera.
  toggleRecord() { return this.set('Video', 'record'); }

  async startRecording() {
    if ((await this.status()).recording) return false;
    await this.toggleRecord();
    return true;
  }

  async stopRecording() {
    if (!(await this.status()).recording) return false;
    await this.toggleRecord();
    return true;
  }

  takePhoto() { return this.set('Video', 'capture'); }

  // --- files ---------------------------------------------------------------

  // type 'video' lists /SD/Video, 'photo' lists /SD/Photo. The camera's
  // property names are case-sensitive: anything but "Photo" falls back to videos.
  async listFiles({ type = 'video', from = 0, count = 16 } = {}) {
    const property = type === 'photo' ? 'Photo' : 'DCIM';
    const xml = await this.cgi({ action: 'dir', property, format: 'all', count, from });
    return parseFileList(xml).files;
  }

  async listAllFiles({ type = 'video', pageSize = 16 } = {}) {
    const all = [];
    for (let from = 0; ; from += pageSize) {
      const page = await this.listFiles({ type, from, count: pageSize });
      all.push(...page);
      if (page.length < pageSize) return all;
    }
  }

  deleteFile(filePath) {
    return this.cgi({ action: 'del', property: filePath.replace(/\//g, '$') })
      .then((body) => {
        const r = parseKeyValues(body);
        if (!r.ok) throw new CameraError(`delete ${filePath} failed`, { code: r.code, body });
        return true;
      });
  }

  // Size in bytes of a camera file (HEAD request).
  async fileSize(filePath) {
    const res = await this._request(encodeURI(filePath), { method: 'HEAD' });
    if (res.status !== 200) throw new CameraError(`${filePath}: HTTP ${res.status}`, { code: res.status });
    return Number(res.headers['content-length']);
  }

  // Streams a camera file to disk. Returns the local path.
  download(filePath, destDir = '.', { onProgress } = {}) {
    const dest = path.join(destDir, path.posix.basename(filePath));
    return this._enqueue(() => new Promise((resolve, reject) => {
      const req = http.get({ ...this._target, path: filePath, insecureHTTPParser: true }, async (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new CameraError(`Download of ${filePath} failed: HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let done = 0;
        if (onProgress) res.on('data', (c) => onProgress((done += c.length), total));
        try {
          await pipeline(res, fs.createWriteStream(dest + '.part'));
          fs.renameSync(dest + '.part', dest);
          resolve(dest);
        } catch (err) { reject(err); }
      });
      req.setTimeout(30000, () => req.destroy(new CameraError(`Download of ${filePath} stalled`)));
      req.on('error', reject);
    }));
  }

  // Raw HTTP stream of a camera path (used to proxy media files).
  // Not queued: a live stream would block every other request.
  openStream(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.get({ ...this._target, path: urlPath, insecureHTTPParser: true }, resolve);
      req.setTimeout(this.timeout, () => req.destroy(new CameraError('Stream timed out')));
      req.on('error', reject);
    });
  }

  // --- Wi-Fi ---------------------------------------------------------------

  async wifi() {
    const n = await this.get('Net.*');
    const stations = [];
    for (let i = 1; i <= Number(n['Net.WIFI_STA.AP.Totals'] || 0); i++) {
      stations.push({
        slot: i,
        ssid: n[`Net.WIFI_STA.AP.${i}.SSID`],
        encType: n[`Net.WIFI_STA.AP.${i}.EncType`],
        hasKey: Boolean(n[`Net.WIFI_STA.AP.${i}.CryptoKey`]),
      });
    }
    return {
      hotspot: {
        ssid: n['Net.WIFI_AP.SSID'],
        encType: n['Net.WIFI_AP.EncType'],
        enabled: n['Net.Dev.1.Start'] === '1',
        address: n['Net.Dev.1.IPV4.Address'],
      },
      station: {
        enabled: n['Net.Dev.2.Start'] === '1',
        type: n['Net.Dev.2.Type'],
        address: n['Net.Dev.2.IPV4.Address'],
        mac: n['Net.Dev.2.MAC'],
        switch: n['Net.WIFI_STA.AP.Switch'],
        profiles: stations,
      },
      raw: n,
    };
  }

  // Applies pending Net.* changes (restarts the camera's Wi-Fi).
  resetNetwork() { return this.set('Net', 'reset'); }

  async setHotspot({ ssid, password }) {
    if (password !== undefined && password.length < 8) throw new CameraError('Hotspot password must be at least 8 characters', INVALID);
    if (ssid) await this.set('Net.WIFI_AP.SSID', ssid);
    if (password) await this.set('Net.WIFI_AP.CryptoKey', password);
  }

  // Writes a station (client-mode) profile. Does not enable client mode.
  async setStationProfile({ slot = 1, ssid, password = '', encType = 'AES' }) {
    await this.set(`Net.WIFI_STA.AP.${slot}.SSID`, ssid);
    await this.set(`Net.WIFI_STA.AP.${slot}.CryptoKey`, password);
    await this.set(`Net.WIFI_STA.AP.${slot}.EncType`, encType);
  }

  // Writes a saved network and reads it back until it matches (the camera
  // applies writes with a lag). password undefined keeps the stored one.
  async saveStationProfile({ slot = 1, ssid, password, encType = 'AES' }) {
    if (!ssid) throw new CameraError('Network name is empty', INVALID);
    if (!['AES', 'TKIP'].includes(encType)) throw new CameraError('Security must be AES (WPA2) or TKIP (WPA)', INVALID);
    const prefix = `Net.WIFI_STA.AP.${slot}.`;
    if (password === undefined) {
      password = (await this.get(`${prefix}CryptoKey`))[`${prefix}CryptoKey`] ?? '';
    }
    X3Camera.checkStationPassword(password);
    await this.setStationProfile({ slot, ssid, password, encType });
    for (let i = 0; i < 10; i++) {
      const saved = await this.get(`${prefix}*`);
      if (saved[`${prefix}SSID`] === ssid && (saved[`${prefix}CryptoKey`] ?? '') === password
        && saved[`${prefix}EncType`] === encType) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new CameraError('The camera did not store the network name/password exactly; not switching');
  }

  // Empties a saved client-mode network slot.
  async clearStationProfile(slot) {
    await this.set(`Net.WIFI_STA.AP.${slot}.SSID`, '');
    await this.set(`Net.WIFI_STA.AP.${slot}.CryptoKey`, '');
    await this.set(`Net.WIFI_STA.AP.${slot}.EncType`, '');
  }

  // Turns the station interface on/off. Takes effect after resetNetwork().
  setStationEnabled(enabled) {
    return this.set('Net.Dev.2.Start', enabled ? '1' : '0');
  }

  // Firmware limits found on a real X3: longer keys are truncated and '&' ends
  // the value however it's encoded, either of which strands the camera.
  static checkStationPassword(password) {
    if (password.length > 35) throw new CameraError('Password is longer than 35 characters; the camera would truncate it', INVALID);
    if (password.includes('&')) throw new CameraError('Password contains "&"; the camera cuts the value there', INVALID);
  }

  // The X3's radio runs either its hotspot or client mode, never both. Both
  // switches below restart the camera's Wi-Fi, so the camera drops off the
  // network it is on now.

  // Back to the camera's own hotspot (192.72.1.1). Saved client profiles are kept.
  async useHotspot() {
    await this.set('Net.Dev.1.Start', '1');
    await this.setStationEnabled(false);
    await this.resetNetwork();
  }

  // Join a 2.4 GHz network instead of running the hotspot. The profile is
  // written and read back first: with the hotspot off, a wrong SSID or key
  // leaves no way to reach the camera, so nothing is switched unless it matches.
  async useClientMode({ ssid, password = '', encType = 'AES', slot = 1 }) {
    await this.saveStationProfile({ slot, ssid, password, encType });
    await this._switchToClient();
  }

  // Client mode using the networks already saved in the camera's slots (it
  // tries them itself). Refuses if no slot has a network name.
  async useSavedNetworks() {
    const { station } = await this.wifi();
    if (!station.profiles.some((p) => p.ssid)) throw new CameraError('No saved networks; add one first', INVALID);
    await this._switchToClient();
  }

  async _switchToClient() {
    await this.setStationEnabled(true);
    await this.set('Net.Dev.1.Start', '0');
    await this.resetNetwork();
  }
}
