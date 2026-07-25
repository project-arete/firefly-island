#!/usr/bin/env node
// Island Spirit v3 — the always-on host for the WHOLE ARCHIPELAGO.
// The spirit now DISCOVERS islands from the realm keys: any context where a
// firefly has declared a padi.light lamp gets a beacon and a greeter. Mint an
// island by sharing a link; the spirit senses it and lights the lighthouse.
//
//   provider of cp:padi.game.beacon   per island: level/pattern PROPAGATE;
//                                     `granted` acks ADDRESSED per connection
//   consumer of cp:padi.game.presence per island: ADDRESSED `welcome` greetings
//
//   npm i ws && node island-spirit.js
//   env: ARETE_HOST   (default bali.aretehosting.com)
//        ISLAND_CTX   (always tended even before anyone arrives;
//                      default FireflyIslandPhase1Ctx)
//        AUTO=0       disable island auto-discovery (tend ISLAND_CTX only)
//        FF_INSECURE=1 (self-signed TLS), DECAY_MS (45000), FEED_BONUS (3)
//
// Ported invariants: value-wiper guard per capability; feed baseline is the
// realm-persisted `granted` per connection (stateless restarts); registration
// is serialized — re-register only on reconnect (the bali race, 2026-07-25).

import WebSocket from 'ws';

const HOST = process.env.ARETE_HOST || 'bali.aretehosting.com';
const HOME_CTX = process.env.ISLAND_CTX || 'FireflyIslandPhase1Ctx';
const AUTO = process.env.AUTO !== '0';
const CTX_NAME = 'Firefly Island';
const DECAY_MS = Number(process.env.DECAY_MS || 45000);
const FEED_BONUS = Number(process.env.FEED_BONUS || 3);
const P_BEACON = 'padi.game.beacon';
const P_PRES = 'padi.game.presence';
const P_LIGHT = 'padi.light';
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

const beaconBase = (ctx) => `cns/${SPIRIT.sys}/nodes/${SPIRIT.node}/contexts/${ctx}/provider/${P_BEACON}`;
const presBase = (ctx) => `cns/${SPIRIT.sys}/nodes/${SPIRIT.node}/contexts/${ctx}/consumer/${P_PRES}`;

// islands = contexts where at least one firefly lamp is declared (any system)
function discoverIslands(c) {
  const found = new Set([HOME_CTX]);
  if (!AUTO) return found;
  const re = new RegExp(`^cns/[^/]+/nodes/[^/]+/contexts/([^/]+)/consumer/${P_LIGHT.replace(/\./g, '\\.')}/version$`);
  for (const k in c.keys) {
    const m = k.match(re);
    if (m) found.add(m[1]);
  }
  return found;
}

async function registerBase(c) {
  await c.command('systems', SPIRIT.sys, 'Firefly Island Spirit');
  await c.command('nodes', SPIRIT.sys, SPIRIT.node, SPIRIT.name, false, null);
}

// The founders christen an island; the spirit canonizes their name. Look at
// what OTHER participants registered this context as, adopt the first real
// name found, else the default. The spirit's ctx-name key then becomes the
// display name every client shows.
function adoptName(c, ctx) {
  const re = new RegExp(`^cns/([^/]+)/nodes/[^/]+/contexts/${ctx.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/name$`);
  for (const k in c.keys) {
    const m = k.match(re);
    if (m && m[1] !== SPIRIT.sys && c.keys[k]) return String(c.keys[k]);
  }
  return CTX_NAME;
}

// declare the spirit's presence on one island (wiper-guarded, serialized)
async function tendIsland(c, ctx) {
  await c.command('contexts', SPIRIT.sys, SPIRIT.node, ctx, adoptName(c, ctx));
  for (const [role, profile, cmd] of [['provider', P_BEACON, 'providers'], ['consumer', P_PRES, 'consumers']]) {
    const base = `cns/${SPIRIT.sys}/nodes/${SPIRIT.node}/contexts/${ctx}/${role}/${profile}`;
    if (c.keys[base + '/version'] !== undefined) continue; // re-declaring WIPES values
    await c.command(cmd, SPIRIT.sys, SPIRIT.node, ctx, profile);
  }
  if (c.keys[`${beaconBase(ctx)}/properties/level`] === undefined) {
    await c.put(`${beaconBase(ctx)}/properties/level`, '80');
  }
  if (c.keys[`${beaconBase(ctx)}/properties/pattern`] === undefined) {
    await c.put(`${beaconBase(ctx)}/properties/pattern`, 'calm');
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
  log(`Island Spirit v3 waking — realm wss://${HOST}:443, home ctx ${HOME_CTX}, auto-discovery ${AUTO ? 'ON' : 'off'}`);
  const c = new Client(`wss://${HOST}:443`);
  const islands = new Map(); // ctx -> { level, welcomed:Set, lastDecay }
  let registeredOnce = false;
  let busy = false; // serialize ALL registration work (the bali race lesson)

  c.onopen = () => {
    if (!registeredOnce) return;
    (async () => {
      while (busy) await sleep(200);
      busy = true;
      try {
        await registerBase(c);
        for (const ctx of islands.keys()) await tendIsland(c, ctx);
        log('re-registered after reconnect');
      } catch (e) { log(`re-register failed: ${e.message}`); }
      finally { busy = false; }
    })();
  };

  const t0 = Date.now();
  while (c.updates === 0 && Date.now() - t0 < 20000) await sleep(100);
  if (c.updates === 0) { log('could not reach the realm'); process.exit(1); }
  busy = true;
  await registerBase(c);
  busy = false;
  registeredOnce = true;
  log('registered. Scanning the archipelago…');

  for (;;) {
    await sleep(2000); // snappy acks — a feed should feel answered
    if (!c.isOpen() || c.updates === 0 || busy) continue;

    // ---- discover new islands and light their beacons
    for (const ctx of discoverIslands(c)) {
      if (islands.has(ctx)) continue;
      busy = true;
      try {
        await tendIsland(c, ctx);
        islands.set(ctx, {
          level: Math.max(5, Math.min(100, parseInt(c.keys[`${beaconBase(ctx)}/properties/level`] || '80', 10) || 80)),
          welcomed: new Set(),
          lastDecay: Date.now(),
        });
        log(`⛯ new island discovered — beacon lit on ${ctx}`);
      } catch (e) { log(`could not tend ${ctx}: ${e.message}`); }
      finally { busy = false; }
    }

    for (const [ctx, isle] of islands) {
      const bBase = beaconBase(ctx), pBase = presBase(ctx);

      // ---- feeds: baseline is realm-persisted `granted` (stateless restarts)
      const feedConns = conns(c, bBase, 'consumer');
      for (const connId in feedConns) {
        const n = parseInt(c.keys[`${bBase}/connections/${connId}/properties/feed`] || '0', 10) || 0;
        const banked = parseInt(c.keys[`${bBase}/connections/${connId}/properties/granted`] || '0', 10) || 0;
        const delta = n - banked;
        if (delta > 0) {
          isle.level = Math.min(100, isle.level + delta * FEED_BONUS);
          await c.put(`${bBase}/connections/${connId}/properties/granted`, String(n)).catch(() => {});
          log(`[${ctx}] fed +${delta} tap(s) — level ${isle.level}`);
        } else if (n && delta < 0) {
          await c.put(`${bBase}/connections/${connId}/properties/granted`, String(n)).catch(() => {});
          log(`[${ctx}] re-synced granted to ${n}`);
        }
      }

      // ---- welcomes (ADDRESSED per firefly)
      const presConns = conns(c, pBase, 'provider');
      for (const connId in presConns) {
        if (isle.welcomed.has(connId)) continue;
        const p = presConns[connId];
        const peerPres = `cns/${p[1]}/nodes/${p[3]}/contexts/${ctx}/provider/${P_PRES}/properties/name`;
        const name = c.keys[peerPres] || c.keys[`cns/${p[1]}/nodes/${p[3]}/name`] || 'little light';
        await c.put(`${pBase}/connections/${connId}/properties/welcome`, `Welcome to the island, ${name}!`).catch(() => {});
        isle.welcomed.add(connId);
        log(`[${ctx}] welcomed ${name}`);
      }

      // ---- decay + publish
      if (Date.now() - isle.lastDecay >= DECAY_MS) {
        isle.lastDecay = Date.now();
        if (isle.level > 5) isle.level -= 1;
      }
      const wantPattern = isle.level >= 95 ? 'festival' : 'calm';
      if (c.keys[`${bBase}/properties/level`] !== String(isle.level)) {
        await c.put(`${bBase}/properties/level`, String(isle.level)).catch(() => {});
      }
      if (c.keys[`${bBase}/properties/pattern`] !== wantPattern) {
        await c.put(`${bBase}/properties/pattern`, wantPattern).catch(() => {});
        log(`[${ctx}] pattern -> ${wantPattern}`);
      }
    }
  }
})();
