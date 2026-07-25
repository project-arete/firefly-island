#!/usr/bin/env node
// Headless two-player exit test for Firefly Island (Phase 1).
// Simulates two phones: register, declare (wiper-guarded), wait for the broker,
// addressed sOut write A->B, verify B's lamp logic and cState propagation back.
// Also answers the architecture question: does the broker bind across SYSTEMS
// that share a context id? (Phase 1 depends on it.)
//
//   npm i ws && node scripts/test-firefly.js
//   env: ARETE_HOST (default anto.aretehosting.com), FF_INSECURE=1 (TLS off),
//        BIND_TIMEOUT_MS (default 120000)
//
// Identities are FIXED so reruns reuse the same realm registrations instead of
// minting ghosts (there is no delete command in the wire protocol).

import WebSocket from 'ws';

const HOST = process.env.ARETE_HOST || 'bali.aretehosting.com';
const BIND_TIMEOUT = Number(process.env.BIND_TIMEOUT_MS || 120000);
const PROFILE = 'padi.light';
const CTX = 'FireflyIslandTestCtx00'; // 22 chars — test island, NOT the real one
const CTX_NAME = 'Firefly Island (test)';
if (process.env.FF_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Fixed test identities (stable across runs, clearly labeled on the realm).
const A = { sys: 'f1aef1e5-0001-4a01-9e01-000000000001', node: 'FireflyTestPlayerA0000', name: 'Test Firefly A' };
const B = { sys: 'f1aef1e5-0002-4a02-9e02-000000000002', node: 'FireflyTestPlayerB0000', name: 'Test Firefly B' };

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
    this.cache = { keys: {} }; this.updates = 0; this.tx = 1; this.reqs = {};
    this.ws = new WebSocket(url, { rejectUnauthorized: process.env.FF_INSECURE !== '1' });
    this.ws.on('message', (buf) => {
      const data = JSON.parse(buf.toString());
      if (data.transaction !== undefined) {
        const r = this.reqs[data.transaction];
        if (r) { delete this.reqs[data.transaction]; r.resolve(data); }
        return;
      }
      merge(this.cache, data); this.updates++;
    });
    this.ws.on('error', (e) => { this.err = e; });
  }
  get keys() { return this.cache.keys; }
  async waitForOpen(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.updates > 0) return;
      if (this.err) throw this.err;
      await sleep(50);
    }
    throw new Error('connect timeout');
  }
  command(cmd, ...args) {
    return new Promise((resolve, reject) => {
      for (const a of args) cmd += ' "' + a + '"';
      const transaction = this.tx++;
      this.reqs[transaction] = { resolve, reject };
      this.ws.send(JSON.stringify({ transaction, format: 'json', command: cmd }));
    });
  }
  put(key, value) { return this.command('put', key, value); }
  close() { try { this.ws.close(); } catch (_) {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(desc, timeout, fn) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) { console.log(`  ✓ ${desc}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return v; }
    if (Date.now() - t0 > timeout) throw new Error(`TIMEOUT waiting for: ${desc}`);
    await sleep(400);
  }
}

const base = (p, role) => `cns/${p.sys}/nodes/${p.node}/contexts/${CTX}/${role}/${PROFILE}`;

async function join(c, p) {
  await c.command('systems', p.sys, `Firefly (${p.name})`);
  await c.command('nodes', p.sys, p.node, p.name, false, null);
  await c.command('contexts', p.sys, p.node, CTX, CTX_NAME);
  for (const role of ['provider', 'consumer']) {
    if (c.keys[base(p, role) + '/version'] !== undefined) {
      console.log(`  · ${p.name}: ${role} already declared — SKIPPING (wiper guard)`);
      continue;
    }
    await c.command(role === 'provider' ? 'providers' : 'consumers', p.sys, p.node, CTX, PROFILE);
  }
  if (c.keys[`${base(p, 'consumer')}/properties/cState`] === undefined) {
    await c.put(`${base(p, 'consumer')}/properties/cState`, '0');
  }
}

// find provider-side connId whose peer is `other` (path parse as in the apps)
function connTo(c, p, other) {
  const prefix = `${base(p, 'provider')}/connections/`;
  for (const k in c.keys) {
    if (!k.startsWith(prefix) || !k.endsWith('/consumer')) continue;
    const parts = String(c.keys[k]).split('/');
    if (parts[1] === other.sys && parts[3] === other.node) return k.slice(prefix.length).split('/')[0];
  }
  return null;
}
function selfConn(c, p) { return connTo(c, p, p); }

(async () => {
  console.log(`Firefly Island exit test — realm wss://${HOST}:443, ctx ${CTX}`);
  const t0 = Date.now();
  const ca = new Client(`wss://${HOST}:443`);
  const cb = new Client(`wss://${HOST}:443`);
  await ca.waitForOpen(); await cb.waitForOpen();
  console.log('  ✓ both players connected (snapshot merged)');

  await join(ca, A); await join(cb, B);
  console.log('  ✓ both players registered + declared');

  // THE architecture question: cross-system bind within a shared context id.
  const tBind = Date.now();
  const abConn = await until('broker bound A.switch -> B.lamp (CROSS-SYSTEM)', BIND_TIMEOUT, () => connTo(ca, A, B));
  console.log(`  ⏱ bind latency: ${((Date.now() - tBind) / 1000).toFixed(1)}s`);
  const selfA = selfConn(ca, A);
  console.log(selfA
    ? `  · self-connection A.switch -> A.lamp exists (${selfA}) — legal, app deranks it`
    : '  · no self-connection for A (broker did not self-bind)');

  // Addressed write: A lights B's lamp through ONE connection.
  await ca.put(`${base(A, 'provider')}/connections/${abConn}/properties/sOut`, '1');
  console.log('  ✓ A wrote sOut=1 ADDRESSED into the A->B connection');

  // B's consumer sees it on its side of the connection…
  await until("B's lamp received sOut=1 on its consumer connection", 30000, () => {
    const prefix = `${base(B, 'consumer')}/connections/`;
    for (const k in cb.keys) {
      if (k.startsWith(prefix) && k.endsWith('/properties/sOut') && cb.keys[k] === '1') return true;
    }
    return false;
  });

  // …and honestly reports its lamp state on the capability (game logic).
  await cb.put(`${base(B, 'consumer')}/properties/cState`, '1');
  await until('A observes B.cState=1 (lamp visibly lit, realm-wide)', 30000,
    () => ca.keys[`${base(B, 'consumer')}/properties/cState`] === '1');

  // Let go again (leave the test island dark for the next run).
  await ca.put(`${base(A, 'provider')}/connections/${abConn}/properties/sOut`, '0');
  await cb.put(`${base(B, 'consumer')}/properties/cState`, '0');

  console.log(`\nPASS — stranger lit your lamp. Total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ca.close(); cb.close();
  process.exit(0);
})().catch((e) => {
  console.error(`\nFAIL — ${e.message || e}`);
  process.exit(1);
});
