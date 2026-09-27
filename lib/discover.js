// Finds X3 cameras on the local network.
//
// The X3's Wi-Fi module uses a different MAC (00:e0:4c:00:00:xx, only the last
// byte changes) and so gets a new DHCP address every time it joins a network,
// and it doesn't answer SSDP. What is reliable is its own API, so this asks
// candidate addresses for Camera.Menu.FWversion:
//   1. the hotspot address and ARP entries with the module's MAC prefix (fast),
//   2. then, if nothing answered, every address on each local /24 subnet.

import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { DEFAULT_HOST } from './x3.js';

const MAC_PREFIX = /^0?0:e0:4c:0?0:0?0:/i;

// Resolves to the firmware name if host is an X3, otherwise undefined.
export function probe(host, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({
      host, port: 80, path: '/cgi-bin/Config.cgi?action=get&property=Camera.Menu.FWversion',
      timeout: timeoutMs, insecureHTTPParser: true, headers: { Connection: 'close' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve(body.match(/^Camera\.Menu\.FWversion=(.*)$/m)?.[1].trim()));
      res.on('error', () => resolve(undefined));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });
}

// IPs in the ARP cache whose MAC matches the camera's Wi-Fi module.
export function arpCandidates() {
  return new Promise((resolve) => {
    execFile('arp', ['-an'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve([]);
      const ips = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/i);
        if (m && MAC_PREFIX.test(m[2])) ips.push(m[1]);
      }
      resolve(ips);
    });
  });
}

// Every host address on the /24 of each private IPv4 interface.
export function localSubnetHosts() {
  const hosts = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || !/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address)) continue;
      const base = a.address.split('.').slice(0, 3).join('.');
      for (let i = 1; i < 255; i++) if (`${base}.${i}` !== a.address) hosts.add(`${base}.${i}`);
    }
  }
  return [...hosts];
}

async function probeAll(hosts, { concurrency = 64, timeoutMs } = {}) {
  const found = [];
  const queue = [...hosts];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const host = queue.shift();
      const firmware = await probe(host, { timeoutMs });
      if (firmware !== undefined) found.push({ host, firmware });
    }
  }));
  return found;
}

// Returns [{ host, firmware }], quickest candidates first. Set full: true to
// always sweep the subnet even if a quick candidate answered.
export async function discover({ full = false, timeoutMs = 1500 } = {}) {
  const quick = [...new Set([DEFAULT_HOST, ...(await arpCandidates())])];
  const found = await probeAll(quick, { timeoutMs });
  if (found.length && !full) return found;
  const rest = localSubnetHosts().filter((h) => !quick.includes(h));
  return [...found, ...(await probeAll(rest, { timeoutMs }))];
}

// Resolves as soon as any camera answers: { host, firmware }, or undefined.
export async function findCamera({ timeoutMs = 1500 } = {}) {
  const first = (hosts) => new Promise((resolve) => {
    const queue = [...hosts];
    let running = 0;
    let done = false;
    const next = () => {
      if (done) return;
      if (!queue.length && !running) { done = true; return resolve(undefined); }
      while (running < 64 && queue.length) {
        const host = queue.shift();
        running++;
        probe(host, { timeoutMs }).then((firmware) => {
          running--;
          if (firmware !== undefined && !done) { done = true; return resolve({ host, firmware }); }
          next();
        });
      }
    };
    next();
  });
  const quick = [...new Set([DEFAULT_HOST, ...(await arpCandidates())])];
  return (await first(quick)) ?? first(localSubnetHosts().filter((h) => !quick.includes(h)));
}
