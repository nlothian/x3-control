#!/usr/bin/env node
// Command-line control for the Kaiser Baas X3. Run `node cli.js help`.

import { X3Camera, CameraError, DEFAULT_HOST } from './lib/x3.js';
import { SETTINGS, normaliseValue } from './lib/settings-meta.js';

const HELP = `
Usage: x3 [--host 192.72.1.1] <command> [args]

Status & settings
  status                      Mode and recording state
  settings                    All menu settings (Camera.Menu.*)
  preview                     Live-view settings (Camera.Preview.*)
  get <property>              Raw read, e.g. get "Camera.Menu.*"
  setting <name> <value>      Change a menu setting and wait until it sticks,
                              e.g. setting VideoRes 1080P60
  options                     List menu settings and the values they accept
  info                        Battery, space left, file count
  set <property> <value>      Raw write (note: VideoRes/ImageRes write as Videores/Imageres)
  clock                       Set the camera clock to this computer's time

Actions
  record start|stop|toggle    Start / stop video recording
  photo                       Take a photo
  live                        Print live-view stream URLs

Files
  files [--photos] [--all]    List videos (or photos): first 16, or all
  download <path>... [--dir D]  Download files; --all for every video,
                              --all --photos for every photo
  delete <path>               Delete a file on the camera

Wi-Fi
  wifi [--password [P]]       Show hotspot + client-mode config (checks slot 1 key;\n                              --password alone prompts for it)
  wifi hotspot [--ssid S] [--password P]   Change the camera's own hotspot
  wifi test-write             Safe check that Wi-Fi settings are writable
  wifi key-test               Safe check of password length / characters (uses slot 8)
  wifi client-mode --ssid S --password [P] [--enc AES|TKIP] --yes
                              EXPERIMENTAL: join your 2.4 GHz network and turn the
                              hotspot off (read the README first). Alias: join
  wifi hotspot-mode --yes     Turn the camera's own hotspot back on (leaves your network)
  wifi apply                  Restart the camera's Wi-Fi to apply changes
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const printKV = (obj) => { for (const [k, v] of Object.entries(obj)) console.log(`${k} = ${v}`); };

// Reads a line from the terminal without echoing it.
function askHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = positional;
  // "--password" with no value: prompt for it instead.
  if (flags.password === true) flags.password = await askHidden('Wi-Fi password (hidden): ');
  const cam = new X3Camera({ host: flags.host });

  switch (cmd) {
    case undefined:
    case 'help':
      console.log(HELP);
      break;

    case 'status': {
      const s = await cam.status();
      console.log(`Mode: ${s.mode}\nRecord: ${s.record}`);
      break;
    }
    case 'settings': printKV(await cam.settings()); break;
    case 'preview': printKV(await cam.preview()); break;
    case 'get': printKV(await cam.get(sub)); break;
    case 'setting':
      console.log(`OK: ${sub} = ${await cam.setSetting(sub, rest[0])}`);
      break;
    case 'options': {
      const values = await cam.settings();
      for (const [name, meta] of Object.entries(SETTINGS)) {
        if (!(name in values)) continue;
        const opts = meta.readOnly ? '(read-only)' : meta.free ? '(any value; camera validates)'
          : meta.options.map((o) => (Array.isArray(o) ? o[0] : o)).join(' | ');
        console.log(`${name.padEnd(15)} ${String(normaliseValue(name, values[name])).padEnd(10)} ${opts}`);
      }
      break;
    }
    case 'info': printKV(await cam.info()); break;
    case 'set':
      await cam.set(sub, rest[0]);
      console.log(`OK: ${sub} = ${rest[0]}`);
      break;
    case 'clock':
      await cam.syncClock();
      console.log(`Clock set to ${new Date().toLocaleString()}`);
      break;

    case 'record': {
      if (sub === 'start') console.log((await cam.startRecording()) ? 'Recording started' : 'Already recording');
      else if (sub === 'stop') console.log((await cam.stopRecording()) ? 'Recording stopped' : 'Was not recording');
      else if (sub === 'toggle') { await cam.toggleRecord(); console.log('Toggled'); }
      else throw new CameraError('Usage: record start|stop|toggle');
      break;
    }
    case 'photo':
      await cam.takePhoto();
      console.log('Photo taken');
      break;
    case 'live':
      console.log(`RTSP (VLC/ffplay): ${cam.rtspUrl}`);
      console.log('In a browser: run "npm start" and use Start live view (needs ffmpeg).');
      break;

    case 'files': {
      const type = flags.photos ? 'photo' : 'video';
      const files = flags.all ? await cam.listAllFiles({ type }) : await cam.listFiles({ type });
      for (const f of files) {
        console.log(`${f.time}  ${fmtBytes(f.size).padStart(9)}  ${(f.resolution ?? '').padEnd(9)} ${f.duration === undefined ? '     ' : `${f.duration}s`.padEnd(6)} ${f.path}`);
      }
      console.log(`${files.length} file(s)`);
      break;
    }
    case 'download': {
      const paths = flags.all
        ? (await cam.listAllFiles({ type: flags.photos ? 'photo' : 'video' })).map((f) => f.path)
        : [sub, ...rest].filter(Boolean);
      if (!paths.length) throw new CameraError('Usage: download <path>... or download --all');
      for (const p of paths) {
        const dest = await cam.download(p, flags.dir || '.', {
          onProgress: (done, total) => process.stdout.write(`\r${p}  ${fmtBytes(done)}${total ? ` / ${fmtBytes(total)}` : ''}   `),
        });
        process.stdout.write(`\r${p} -> ${dest}\n`);
      }
      break;
    }
    case 'delete':
      await cam.deleteFile(sub);
      console.log(`Deleted ${sub}`);
      break;

    case 'wifi':
      await wifiCommand(cam, sub, flags);
      break;

    default:
      throw new CameraError(`Unknown command "${cmd}". Run: node cli.js help`);
  }
}

async function wifiCommand(cam, sub, flags) {
  switch (sub) {
    case undefined: {
      const w = await cam.wifi();
      console.log(`Hotspot: "${w.hotspot.ssid}" (${w.hotspot.encType}) at ${w.hotspot.address}, ${w.hotspot.enabled ? 'on' : 'off'}`);
      console.log(`Client mode: ${w.station.enabled ? 'ON' : 'off'} (interface ${w.station.type}, switch ${w.station.switch})`);
      // These are stored defaults, not live values: in client mode the X3 uses its
      // Wi-Fi module's own MAC (00:e0:4c:…) and whatever IP the router hands out.
      console.log(`  (config says MAC ${w.station.mac}, IP ${w.station.address}; the real ones may differ)`);
      for (const p of w.station.profiles) {
        console.log(`  slot ${p.slot}: ${p.ssid ? `"${p.ssid}" ${p.encType}${p.hasKey ? ' (key set)' : ''}` : '(empty)'}`);
      }
      if (typeof flags.password === 'string') {
        // Compare without printing, to catch the camera storing the key mangled.
        const stored = w.raw['Net.WIFI_STA.AP.1.CryptoKey'] ?? '';
        console.log(stored === flags.password
          ? 'Slot 1 password: matches exactly'
          : `Slot 1 password: DOES NOT MATCH (stored ${stored.length} chars, expected ${flags.password.length}${stored.includes('%') ? ', contains % so it was probably stored URL-encoded' : ''})`);
      }
      break;
    }
    case 'hotspot':
      if (!flags.ssid && !flags.password) throw new CameraError('Give --ssid and/or --password');
      await cam.setHotspot({ ssid: flags.ssid, password: flags.password });
      console.log('Saved. Run "wifi apply" (or power-cycle the camera) to use the new hotspot settings,');
      console.log('then reconnect to the new network name / password.');
      break;
    case 'test-write': {
      // Slot 8 is an unused placeholder, so writing it changes nothing in practice.
      const before = (await cam.get('Net.WIFI_STA.AP.8.SSID'))['Net.WIFI_STA.AP.8.SSID'] ?? '';
      await cam.set('Net.WIFI_STA.AP.8.SSID', 'x3test');
      const after = (await cam.get('Net.WIFI_STA.AP.8.SSID'))['Net.WIFI_STA.AP.8.SSID'];
      await cam.set('Net.WIFI_STA.AP.8.SSID', before);
      console.log(after === 'x3test'
        ? 'PASS: camera accepts Wi-Fi setting writes (slot 8 restored).'
        : `FAIL: wrote "x3test" but read back "${after}". Wi-Fi settings may be read-only.`);
      break;
    }
    case 'key-test': {
      // Writes sample passwords into unused slot 8 and reads them back, to find
      // the max length and which characters survive. Slot 8 is cleared after.
      const prop = 'Net.WIFI_STA.AP.8.CryptoKey';
      const samples = [
        'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ01', // 64 chars, WPA2 max
        ...[...' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'].map((c) => `ab${c}cd`),
      ];
      for (const s of samples) {
        let stored;
        try {
          await cam.set(prop, s);
          stored = (await cam.get(prop))[prop] ?? '';
        } catch (err) { stored = `<error: ${err.message}>`; }
        const label = s.length > 5 ? `length ${s.length}` : `char ${JSON.stringify(s[2])}`;
        const result = stored === s ? 'OK' : `stored as ${JSON.stringify(stored)} (${stored.length} chars)`;
        console.log(`${label.padEnd(12)} ${result}`);
      }
      await cam.set(prop, '');
      console.log('Slot 8 cleared.');
      break;
    }
    case 'hotspot-mode': {
      const { hotspot, station } = await cam.wifi();
      if (hotspot.enabled && !station.enabled) { console.log(`Already in hotspot mode ("${hotspot.ssid}").`); break; }
      if (!flags.yes) {
        console.log(`This turns the camera's hotspot "${hotspot.ssid}" back on and turns client mode off.`);
        console.log(`The camera will leave the network it is on now (${cam.host}). Re-run with --yes to switch.`);
        break;
      }
      await cam.useHotspot();
      console.log('Switched to hotspot mode. The camera\'s Wi-Fi is restarting.');
      console.log(`In ~20 seconds, join the "${hotspot.ssid}" Wi-Fi network; the camera will be at ${DEFAULT_HOST}.`);
      console.log('To go back:  node cli.js wifi client-mode --ssid "YourNetwork" --password --yes');
      break;
    }
    case 'join':
    case 'client-mode': {
      if (!flags.ssid) throw new CameraError('Give --ssid, and --password (alone to be prompted)');
      const password = typeof flags.password === 'string' ? flags.password : '';
      X3Camera.checkStationPassword(password);
      if (!flags.yes) {
        console.log(`This makes the camera join "${flags.ssid}" and turns its own hotspot OFF.`);
        console.log('If it then can\'t join, you can\'t reach it until that network is available');
        console.log('(see "If the camera doesn\'t show up" in the README). The network must be 2.4 GHz.');
        console.log('Re-run with --yes to switch. Nothing has been changed.');
        break;
      }
      await cam.useClientMode({ ssid: flags.ssid, password, encType: flags.enc || 'AES' });
      console.log(`Saved and verified "${flags.ssid}". Switched to client mode; the camera's Wi-Fi is restarting.`);
      console.log('Give it ~2 minutes (power-cycle if needed), then find it in your router\'s client list.');
      console.log('Look for a MAC starting 00:e0:4c (the Wi-Fi module), not the 00:0E:53 one the config reports.');
      console.log('Then:  node cli.js --host THE_IP status');
      console.log('To go back:  node cli.js --host THE_IP wifi hotspot-mode --yes');
      break;
    }
    case 'apply':
      await cam.resetNetwork();
      console.log('Camera Wi-Fi restarting. Reconnect in ~10-20 seconds.');
      break;
    default:
      throw new CameraError(`Unknown wifi subcommand "${sub}"`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  if (err.body) console.error(`Camera said: ${err.body.trim()}`);
  process.exit(1);
});
