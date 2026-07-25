#!/usr/bin/env node
// Island Spirit — the always-on host node for Firefly Island (FF v2).
// Runs anywhere with Node 18+ and network reach to the realm.
//
//   provider of cp:padi.game.beacon   level/pattern PROPAGATE to all players;
//                                     `granted` written ADDRESSED per connection
//   consumer of cp:padi.game.presence greets each firefly with an ADDRESSED
//                                     `welcome` on their connection
//
//   npm i ws && node island-spirit.js
//   env: ARETE_HOST   (default anto.aretehosting.com)
//        ISLAND_CTX   (default FireflyIslandPhase1Ctx — the real island)
//        FF_INSECURE=1 (self-signed TLS)
//        DECAY_MS     (default 45000 — one level point per interval)
//        FEED_BONUS   (default 3 — level points per feed tap)
//
// Semantics: players write a MONOTONIC tap-count into `feed` (addressed);
// the spirit banks the delta, acks by mirroring the count into `granted`.
// On restart the spirit baselines to current counts (missed taps are the
// fireflies' gift to the night). No .watch(); keys derived on update.

import WebSocket from 'ws';

const HOST = process.env.ARETE_HOST || 'bali.aretehosting.com';
const CTX = process.env.ISLAND_CTX || 'FireflyIslandPhase1Ctx';
const CTX_NAME = 'Firefly Island';
const DECAY_MS = Number(process.env.DECAY_MS || 45000);
const FEED_BONUS = Number(process.env.FEED_BONUS || 3);
const P_BEACON = 'padi.game.beacon';
const P_PRES = 'padi.game.presence';
if (process.env.FF_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Fixed identity — same registration every run, no ghosts.
const SPIRIT = { sys: 'f1aef1e5-0009-4a09-9e09-000000000009', node: 'FireflyIslandSpirit000', name: 'Island Spirit' };

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------------------------------------------------------- client
const getType = (v) => Object.prototype.toString.call(v);
function merge(target, source) {
  for (const key in source) {
    const value = source[key];
    const type = getType(value);
    if (type === '[object Null]') delete target[key];
    else if (type === '[object Object]') {
      if (getType(target[key]) !== type || Object.keys(value).length === 0) target[key] = {};
      merge(target[key], value);
    } else target[key] = value;
  }
}
class Client {
  constructor(url) {
    this.url = url; this.cache = { keys: {} }; this.updates = 0; this.tx = 1; this.reqs = {};
    this.onopen = null;
    this.#open();
  }
  #open() {
    this.ws = new WebSocket(this.url, { rejectUnauthorized: process.env.FF_INSECURE !== '1' });
    this.ws.on('message', (buf) => {
      const data = JSON.parse(buf.toString());
      if (data.transaction !== undefined) {
        const r = this.reqs[data.transaction];
        if (r) { delete this.reqs[data.transaction]; r.resolve(data); }
        return;
      }
      merge(this.cache, data);
      if (this.updates++ === 0 && this.onopen) this.onopen();
    });
    this.ws.on('close', () => {
      log('connection lost — reconnecting in 5s');
      this.updates = 0; this.cache = { keys: {} };
      setTimeout(() => this.#open(), 5000);
    });
    this.ws.on('error', (e) => log(`socket error: ${e.message}`));
    // browsers can't keepalive; Node can — protect long idle nights
    clearInterval(this.pinger);
    this.pinger = setInterval(() => { try { this.ws.ping(); } catch (_) {} }, 30000);
  }
  get keys() { return this.cache.keys; }
  isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN; }
  command(cmd, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) return reject(new Error('socket not open'));
      for (const a of args) cmd += ' "' + a + '"';
      const transaction = this.tx++;
      this.reqs[transaction] = { resolve, reject };
      this.ws.send(JSON.stringify({ transaction, format: 'json', command: cmd }));
    });
  }
  put(key, value) { return this.command('put', key, value); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const beaconBase = `cns/${SPIRIT.sys}/nodes/${SPIRIT.node}/contexts/${CTX}/provider/${P_BEACON}`;
const presBase = `cns/${SPIRIT.sys}/nodes/${SPIRIT.node}/contexts/${CTX}/consumer/${P_PRES}`;

async function register(c) {
  await c.command('systems', SPIRIT.sys, 'Firefly Island Spirit');
  await c.command('nodes', SPIRIT.sys, SPIRIT.node, SPIRIT.name, false, null);
  await c.command('contexts', SPIRIT.sys, SPIRIT.node, CTX, CTX_NAME);
  for (const [role, profile, cmd] of [['provider', P_BEACON, 'providers'], ['consumer', P_PRES, 'consumers']]) {
    const base = `cns/${SPIRIT.sys}/nodes/${SPIRIT.node}/contexts/${CTX}/${role}/${profile}`;
    if (c.keys[base + '/version'] !== undefined) {
      log(`${role} ${profile} already declared — skipping (wiper guard)`);
      continue;
    }
    await c.command(cmd, SPIRIT.sys, SPIRIT.node, CTX, profile);
  }
  if (c.keys[`${beaconBase}/properties/level`] === undefined) {
    await c.put(`${beaconBase}/properties/level`, '80');
  }
  if (c.keys[`${beaconBase}/properties/pattern`] === undefined) {
    await c.put(`${beaconBase}/properties/pattern`, 'calm');
  }
}

// connections under a capability base: connId -> peer path parts
function conns(c, base, peerSide) {
  const out = {};
  const prefix = `${base}/connections/`;
  for (const k in c.keys) {
    if (!k.startsWith(prefix) || !k.endsWith('/' + peerSide)) continue;
    const connId = k.slice(prefix.length).split('/')[0];
    out[connId] = String(c.keys[k]).split('/');
  }
  return out;
}

(async () => {
  log(`Island Spirit waking — realm wss://${HOST}:443, island ctx ${CTX}`);
  const c = new Client(`wss://${HOST}:443`);
  // Re-register ONLY on reconnect — never concurrently with the initial
  // registration below (two interleaved register() runs corrupt the
  // registration server-side; bitten on bali 2026-07-25).
  let registeredOnce = false;
  c.onopen = () => {
    if (!registeredOnce) return;
    register(c).then(() => log('re-registered after reconnect')).catch((e) => log(`re-register failed: ${e.message}`));
  };

  const t0 = Date.now();
  while (c.updates === 0 && Date.now() - t0 < 20000) await sleep(100);
  if (c.updates === 0) { log('could not reach the realm'); process.exit(1); }
  await register(c);
  registeredOnce = true;
  log('registered. The beacon is lit.');

  let level = Math.max(5, Math.min(100, parseInt(c.keys[`${beaconBase}/properties/level`] || '80', 10) || 80));
  const welcomed = new Set();
  let lastDecay = Date.now();

  for (;;) {
    await sleep(2000); // snappy acks — a feed should feel answered
    if (!c.isOpen() || c.updates === 0) continue;

    // ---- feeds (beacon provider side: peer writes `feed` addressed to us).
    // The banked baseline is `granted` — persisted ON THE REALM per connection,
    // so restarts are lossless and the spirit itself holds no state.
    const feedConns = conns(c, beaconBase, 'consumer');
    for (const connId in feedConns) {
      const n = parseInt(c.keys[`${beaconBase}/connections/${connId}/properties/feed`] || '0', 10) || 0;
      const banked = parseInt(c.keys[`${beaconBase}/connections/${connId}/properties/granted`] || '0', 10) || 0;
      const delta = n - banked;
      if (delta > 0) {
        level = Math.min(100, level + delta * FEED_BONUS);
        await c.put(`${beaconBase}/connections/${connId}/properties/granted`, String(n)).catch(() => {});
        log(`fed +${delta} tap(s) via ${connId} — level ${level}`);
      } else if (n && delta < 0) {
        // player reset their count (fresh device/localStorage) — re-sync
        await c.put(`${beaconBase}/connections/${connId}/properties/granted`, String(n)).catch(() => {});
        log(`re-synced granted to ${n} on ${connId}`);
      }
    }

    // ---- welcomes (presence consumer side: greet each firefly ADDRESSED)
    const presConns = conns(c, presBase, 'provider');
    for (const connId in presConns) {
      if (welcomed.has(connId)) continue;
      const p = presConns[connId]; // [ , sys, 'nodes', node, ...]
      const peerPres = `cns/${p[1]}/nodes/${p[3]}/contexts/${CTX}/provider/${P_PRES}/properties/name`;
      const name = c.keys[peerPres] || c.keys[`cns/${p[1]}/nodes/${p[3]}/name`] || 'little light';
      await c.put(`${presBase}/connections/${connId}/properties/welcome`, `Welcome to the island, ${name}!`).catch(() => {});
      welcomed.add(connId);
      log(`welcomed ${name} (${connId})`);
    }

    // ---- decay + publish
    if (Date.now() - lastDecay >= DECAY_MS) {
      lastDecay = Date.now();
      if (level > 5) level -= 1;
    }
    const wantPattern = level >= 95 ? 'festival' : 'calm';
    if (c.keys[`${beaconBase}/properties/level`] !== String(level)) {
      await c.put(`${beaconBase}/properties/level`, String(level)).catch(() => {});
    }
    if (c.keys[`${beaconBase}/properties/pattern`] !== wantPattern) {
      await c.put(`${beaconBase}/properties/pattern`, wantPattern).catch(() => {});
      log(`pattern -> ${wantPattern}`);
    }
  }
})();
