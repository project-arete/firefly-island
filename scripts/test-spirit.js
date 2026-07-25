#!/usr/bin/env node
// Spirit exit test: runs the island-spirit on the TEST context alongside one
// simulated player; verifies welcome (addressed), feed -> granted (addressed),
// and beacon level publication. Run from the spirit/ folder deps:
//   npm i ws && ISLAND_CTX=FireflyIslandTestCtx00 node ../scripts/test-spirit.js
// Spawns the spirit itself; kills it on exit. env: ARETE_HOST, FF_INSECURE.

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HOST = process.env.ARETE_HOST || 'bali.aretehosting.com';
const CTX = 'FireflyIslandTestCtx00';
const P_BEACON = 'padi.game.beacon';
const P_PRES = 'padi.game.presence';
if (process.env.FF_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const A = { sys: 'f1aef1e5-0001-4a01-9e01-000000000001', node: 'FireflyTestPlayerA0000', name: 'Test Firefly A' };
const SPIRIT_SYS = 'f1aef1e5-0009-4a09-9e09-000000000009';
const SPIRIT_NODE = 'FireflyIslandSpirit000';

const getType = (v) => Object.prototype.toString.call(v);
function merge(t, s) {
  for (const k in s) {
    const v = s[k]; const ty = getType(v);
    if (ty === '[object Null]') delete t[k];
    else if (ty === '[object Object]') { if (getType(t[k]) !== ty || Object.keys(v).length === 0) t[k] = {}; merge(t[k], v); }
    else t[k] = v;
  }
}
class Client {
  constructor(url) {
    this.cache = { keys: {} }; this.updates = 0; this.tx = 1; this.reqs = {};
    this.ws = new WebSocket(url, { rejectUnauthorized: process.env.FF_INSECURE !== '1' });
    this.ws.on('message', (buf) => {
      const d = JSON.parse(buf.toString());
      if (d.transaction !== undefined) { const r = this.reqs[d.transaction]; if (r) { delete this.reqs[d.transaction]; r.resolve(d); } return; }
      merge(this.cache, d); this.updates++;
    });
    this.ws.on('error', (e) => { this.err = e; });
  }
  get keys() { return this.cache.keys; }
  async waitForOpen(t = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < t) { if (this.updates > 0) return; if (this.err) throw this.err; await sleep(50); }
    throw new Error('connect timeout');
  }
  command(cmd, ...args) {
    return new Promise((resolve, reject) => {
      for (const a of args) cmd += ' "' + a + '"';
      const tr = this.tx++; this.reqs[tr] = { resolve, reject };
      this.ws.send(JSON.stringify({ transaction: tr, format: 'json', command: cmd }));
    });
  }
  put(k, v) { return this.command('put', k, v); }
  close() { try { this.ws.close(); } catch (_) {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(desc, timeout, fn) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) { console.log(`  ✓ ${desc}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return v; }
    if (Date.now() - t0 > timeout) throw new Error(`TIMEOUT: ${desc}`);
    await sleep(400);
  }
}
const aBase = (role, prof) => `cns/${A.sys}/nodes/${A.node}/contexts/${CTX}/${role}/${prof}`;
const spiritBeacon = `cns/${SPIRIT_SYS}/nodes/${SPIRIT_NODE}/contexts/${CTX}/provider/${P_BEACON}`;

(async () => {
  console.log(`Spirit exit test — realm wss://${HOST}:443, ctx ${CTX}`);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const spirit = spawn('node', [path.join(dir, '../spirit/island-spirit.js')], {
    env: { ...process.env, ISLAND_CTX: CTX, DECAY_MS: '8000' },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(dir, '../spirit'),
  });
  spirit.stdout.on('data', (d) => process.stdout.write(`  [spirit] ${d}`));
  spirit.stderr.on('data', (d) => process.stderr.write(`  [spirit!] ${d}`));
  const kill = () => { try { spirit.kill(); } catch (_) {} };
  process.on('exit', kill);

  const c = new Client(`wss://${HOST}:443`);
  await c.waitForOpen();
  await c.command('systems', A.sys, `Firefly (${A.name})`);
  await c.command('nodes', A.sys, A.node, A.name, false, null);
  await c.command('contexts', A.sys, A.node, CTX, 'Firefly Island (test)');
  for (const [role, prof, cmd] of [['provider', P_PRES, 'providers'], ['consumer', P_BEACON, 'consumers']]) {
    if (c.keys[aBase(role, prof) + '/version'] !== undefined) { console.log(`  · ${role} ${prof} exists — skip (guard)`); continue; }
    await c.command(cmd, A.sys, A.node, CTX, prof);
  }
  await c.put(`${aBase('provider', P_PRES)}/properties/name`, A.name);
  await c.put(`${aBase('provider', P_PRES)}/properties/color`, '#8ce99a');
  console.log('  ✓ player registered (presence provider + beacon consumer)');

  await until('spirit beacon level published', 30000, () => c.keys[`${spiritBeacon}/properties/level`] !== undefined);

  const presConnRe = `${aBase('provider', P_PRES)}/connections/`;
  const welcome = await until('welcome arrived ADDRESSED on presence connection', 60000, () => {
    for (const k in c.keys) if (k.startsWith(presConnRe) && k.endsWith('/properties/welcome') && c.keys[k]) return c.keys[k];
    return null;
  });
  console.log(`    "${welcome}"`);

  const beaconConnPrefix = `${aBase('consumer', P_BEACON)}/connections/`;
  const beaconConn = await until('bound to the beacon', 60000, () => {
    for (const k in c.keys) if (k.startsWith(beaconConnPrefix) && k.endsWith('/provider')) return k.slice(beaconConnPrefix.length).split('/')[0];
    return null;
  });

  const lvl0 = parseInt(c.keys[`${spiritBeacon}/properties/level`], 10);
  // monotonic tap-count (same rule as the app): current + 3 taps
  const cur = parseInt(c.keys[`${beaconConnPrefix}${beaconConn}/properties/feed`] || '0', 10) || 0;
  const n = cur + 3;
  await c.put(`${beaconConnPrefix}${beaconConn}/properties/feed`, String(n));
  await until('feed acked via ADDRESSED granted', 30000,
    () => c.keys[`${beaconConnPrefix}${beaconConn}/properties/granted`] === String(n));
  const dbg = setInterval(() => console.log(`    · player sees level=${c.keys[`${spiritBeacon}/properties/level`]}`), 3000);
  await until(`beacon level rose (${lvl0} -> higher)`, 30000,
    () => parseInt(c.keys[`${spiritBeacon}/properties/level`] || '0', 10) > lvl0);
  clearInterval(dbg);

  console.log('\nPASS — the spirit greets, drinks light, and glows.');
  c.close(); kill();
  process.exit(0);
})().catch((e) => { console.error(`\nFAIL — ${e.message || e}`); process.exit(1); });
