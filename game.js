// Firefly Island — Phase 2 (FF v2)
// v1: two-firefly slice on cp:padi.light (addressed writes, OR-lamp, deranked
//     self-connection). Exit test PASSED live 2026-07-25 (cross-system bind 1.2s).
// v2 adds, all on the padi.game.* CPs published 2026-07-25:
//   - presence: provider of cp:padi.game.presence (name/place/color propagate;
//     spirit's `welcome` arrives ADDRESSED on our provider-side connection)
//   - beacon: consumer of cp:padi.game.beacon (level/pattern read from the
//     spirit's capability keys; `feed` is an addressed per-connection write,
//     `granted` the spirit's addressed ack)
//   - colored fireflies, QR share, all-lit celebration
//
// Ported invariants (do not regress):
//   - capability re-declaration WIPES values -> skip when /version key exists
//   - no .watch(): derive everything from client.keys on 'update'
//   - reconnect re-runs join(); the wiper guard makes that safe

'use strict';

// ------------------------------------------------------------------ consts
const FF_VERSION = 'FF v27';
// Reach: how far your glow extends, in normalized (0-1) canvas units.
// Light received is power to give: every firefly holding your lamp lit
// extends your reach. The base must stay workable alone (cold-start guard),
// and the beacon stays reachable at a FIXED radius — the social safety net.
const REACH_BASE = 0.22;
const REACH_PER_SPARK = 0.05;
const REACH_MAX = 0.40;
const BEACON_REACH = 0.34;
const myReach = () => Math.min(REACH_MAX, REACH_BASE + REACH_PER_SPARK * game.litBy.length);
const DEFAULT_HOST = 'bali.aretehosting.com';
const DEFAULT_PORT = 443;
const P_LIGHT = 'padi.light';
const P_PRES = 'padi.game.presence';
const P_BEACON = 'padi.game.beacon';
const ISLAND_CTX_ID = 'FireflyIslandPhase1Ctx'; // 22 chars, shared by every player
const ISLAND_CTX_NAME = 'Firefly Island';
const RETRY_MS = 5000;
const KEYS_DEBOUNCE_MS = 300;
const COLORS = ['#ffe178', '#8ce99a', '#74c0fc', '#f783ac', '#b197fc', '#ffa94d'];

const LS_IDENTITY = 'firefly-identity';
const LS_NAME = 'firefly-name';
const LS_HOST = 'firefly-host';
const LS_COLOR = 'firefly-color';
const LS_FEED = 'firefly-feed-count';

// ------------------------------------------------------------ tiny emitter
class Emitter {
  #h = {};
  on(ev, fn) { (this.#h[ev] || (this.#h[ev] = [])).push(fn); return this; }
  emit(ev, ...args) { for (const fn of [...(this.#h[ev] || [])]) fn(...args); return this; }
}

// ------------------------------------------- SDK merge + client (ported 1:1)
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

class BrowserAreteClient extends Emitter {
  constructor(url) {
    super();
    this.url = url; this.userClosed = false; this.socket = undefined;
    this.#reset(); this.open();
  }
  #reset() {
    if (this.requests) for (const t in this.requests) this.requests[t].reject(new Error('Socket request failed'));
    this.transaction = 1; this.requests = {}; this.updates = 0;
    this.cache = { version: '', stats: {}, keys: {} };
  }
  open() {
    if (this.socket !== undefined || this.userClosed) return;
    this.#reset();
    this.socket = new WebSocket(this.url);
    this.socket.onmessage = (e) => this.#onmessage(e);
    this.socket.onclose = () => this.#onclose();
    this.socket.onerror = () => this.emit('error', new Error('Socket not open'));
  }
  async waitForOpen(timeout = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.updates > 0) return; // first snapshot merged = truly ready
      if (this.userClosed) throw new Error('Connection cancelled');
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Failed to connect within timeout');
  }
  isOpen() { return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN; }
  get keys() { return this.cache.keys; }
  put(key, value) { return this.command('put', key, value); }
  command(cmd, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) return reject(new Error('Socket not open'));
      for (const arg of args) cmd += ' "' + arg + '"';
      const transaction = this.transaction++;
      this.requests[transaction] = { resolve, reject };
      this.socket.send(JSON.stringify({ transaction, format: 'json', command: cmd }));
    });
  }
  close() {
    this.userClosed = true;
    if (this.socket !== undefined) this.socket.close();
    this.socket = undefined;
  }
  #onmessage(e) {
    try {
      const data = JSON.parse(e.data);
      if (data.transaction !== undefined) {
        const req = this.requests[data.transaction];
        if (req) { delete this.requests[data.transaction]; req.resolve(data); }
        return;
      }
      merge(this.cache, data);
      if (this.updates++ === 0) this.emit('open', e);
      this.emit('update', data);
    } catch (err) { this.emit('error', err); }
  }
  #onclose() {
    const had = this.socket !== undefined;
    this.socket = undefined; this.#reset();
    if (this.userClosed) return;
    if (had) this.emit('close');
    setTimeout(() => this.open(), RETRY_MS);
  }
}

// ---------------------------------------------------------------- identity
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function base62(len = 22) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = ''; for (const b of bytes) out += B62[b % 62]; return out;
}
function identity() {
  let id;
  try { id = JSON.parse(localStorage.getItem(LS_IDENTITY)); } catch (_) {}
  if (!id || !id.systemId || !id.nodeId) {
    id = { systemId: crypto.randomUUID(), nodeId: base62(22) };
    localStorage.setItem(LS_IDENTITY, JSON.stringify(id));
  }
  return id;
}
const clean = (s) => String(s || '').replace(/["\\\n\r]/g, '').trim().slice(0, 24);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- the game
const game = new (class extends Emitter {
  client = null;
  state = 'idle';        // idle | connecting | joining | alone | waiting | live | error
  lastError = null;
  me = { ...identity(), name: '', color: COLORS[0], host: DEFAULT_HOST };
  ctxId = ISLAND_CTX_ID;
  fireflies = [];        // [{key, sysId, nodeId, name, color, lampOn, isMe, connId, litByMe}]
  myLampOn = false;
  litBy = [];
  beacon = { present: false, level: 0, pattern: 'calm', connId: null };
  celebrateUntil = 0;
  pendingBoost = 0;   // optimistic +level shown while the spirit hasn't acked yet
  pendingAt = 0;
  #keysTimer = null;
  #joined = false;
  #declared = false;
  #welcomed = new Set();  // welcome messages already shown (per conn)
  #lastGranted = null;
  #wasAllLit = false;
  #lastFeeds = null;      // spirit-side feed counts (null until baselined)
  #lastSOut = null;       // every island switch's per-connection sOut (baselined)

  log(m) { this.emit('log', m); }
  setState(s) { if (this.state !== s) { this.state = s; this.emit('change'); } }

  #base(role, profile) {
    return `cns/${this.me.systemId}/nodes/${this.me.nodeId}/contexts/${this.ctxId}/${role}/${profile}`;
  }

  async join(name, host, color) {
    this.me.name = clean(name) || 'A firefly';
    this.me.host = clean(host) || DEFAULT_HOST;
    this.me.color = COLORS.includes(color) ? color : COLORS[0];
    localStorage.setItem(LS_NAME, this.me.name);
    localStorage.setItem(LS_HOST, this.me.host);
    localStorage.setItem(LS_COLOR, this.me.color);

    const url = new URLSearchParams(location.search);
    this.ctxId = clean(url.get('island')) || ISLAND_CTX_ID;

    if (this.client) { try { this.client.close(); } catch (_) {} this.client = null; }
    this.#joined = false; this.#declared = false;
    this.lastError = null;
    this.setState('connecting');
    this.log(`Flying to the island at ${this.me.host}…`);

    this.client = new BrowserAreteClient(`wss://${this.me.host}:${DEFAULT_PORT}`);
    this.client.on('update', () => this.#scheduleDerive());
    this.client.on('close', () => {
      this.log('Lost the island in the dark — circling back…');
      if (this.state !== 'idle') this.setState('connecting');
    });
    this.client.on('open', () => {
      if (this.#joined) this.#register().catch((e) => this.#fail(e));
    });
    this.client.on('error', () => {
      if (!this.#joined && this.state === 'connecting') {
        this.lastError = 'The island is unreachable (network, certificate, or auth).';
        this.emit('change');
      }
    });

    try {
      await this.client.waitForOpen(15000);
    } catch (e) { return this.#fail(e); }

    this.setState('joining');
    try { await this.#register(); } catch (e) { return this.#fail(e); }
    this.#joined = true;
    this.log('Your firefly has landed. Waiting for the island to notice…');
    this.#scheduleDerive();
  }

  #fail(e) {
    this.lastError = String(e && e.message ? e.message : e);
    this.setState('error');
    this.log(`✗ ${this.lastError}`);
  }

  // System -> Node -> Context -> capabilities, with the value-wiper guard.
  async #register() {
    const c = this.client;
    const { systemId, nodeId, name } = this.me;
    await c.command('systems', systemId, `Firefly (${name})`);
    await c.command('nodes', systemId, nodeId, name, false, null);
    await c.command('contexts', systemId, nodeId, this.ctxId, ISLAND_CTX_NAME);
    const caps = [
      ['provider', P_LIGHT], ['consumer', P_LIGHT],   // switch + lamp
      ['provider', P_PRES],                            // firefly announces itself
      ['consumer', P_BEACON],                          // player feeds/watches beacon
    ];
    const keys = c.keys || {};
    for (const [role, profile] of caps) {
      const base = this.#base(role, profile);
      if (keys[base + '/version'] !== undefined) continue; // re-declaring WIPES values
      await c.command(role === 'provider' ? 'providers' : 'consumers',
        systemId, nodeId, this.ctxId, profile);
    }
    this.#declared = true;
    // Idempotent-safe capability puts (only when absent or stale).
    const want = {
      [`${this.#base('provider', P_LIGHT)}/properties/sLabel`]: `${name}'s switch`,
      [`${this.#base('consumer', P_LIGHT)}/properties/cLabel`]: `${name}'s lamp`,
      [`${this.#base('provider', P_PRES)}/properties/name`]: name,
      [`${this.#base('provider', P_PRES)}/properties/place`]: ISLAND_CTX_NAME,
      [`${this.#base('provider', P_PRES)}/properties/color`]: this.me.color,
    };
    for (const k in want) if (keys[k] !== want[k]) await c.put(k, want[k]);
    if (keys[`${this.#base('consumer', P_LIGHT)}/properties/cState`] === undefined) {
      await c.put(`${this.#base('consumer', P_LIGHT)}/properties/cState`, '0');
    }
  }

  #scheduleDerive() {
    if (this.#keysTimer) return;
    this.#keysTimer = setTimeout(() => { this.#keysTimer = null; this.#derive(); }, KEYS_DEBOUNCE_MS);
  }

  // Everything below is key-derivation — no watches, no cached assumptions.
  #derive() {
    if (!this.client || !this.#joined) return;
    const keys = this.client.keys || {};
    const meKey = `${this.me.systemId}/${this.me.nodeId}`;
    const ctx = esc(this.ctxId);

    // 1) Roster: every node with a padi.light consumer (a lamp) in the context.
    //    Name/color enriched from that node's presence provider, if declared.
    const roster = new Map();
    const rosterRe = new RegExp(`^cns/([^/]+)/nodes/([^/]+)/contexts/${ctx}/consumer/${esc(P_LIGHT)}/version$`);
    for (const k in keys) {
      const m = k.match(rosterRe);
      if (!m) continue;
      const [, sysId, nodeId] = m;
      const fkey = `${sysId}/${nodeId}`;
      const presBase = `cns/${sysId}/nodes/${nodeId}/contexts/${this.ctxId}/provider/${P_PRES}`;
      const spotRaw = keys[`${presBase}/properties/spot`];
      let spot = null;
      if (spotRaw) {
        const [sx, sy] = String(spotRaw).split(',').map(Number);
        if (Number.isFinite(sx) && Number.isFinite(sy)) spot = { x: sx, y: sy };
      }
      roster.set(fkey, {
        key: fkey, sysId, nodeId,
        name: keys[`${presBase}/properties/name`] || keys[`cns/${sysId}/nodes/${nodeId}/name`] || 'a firefly',
        color: keys[`${presBase}/properties/color`] || '#ffe178',
        spot, // realm-declared position (CP v2); null = hash-seat fallback
        lampOn: keys[`cns/${sysId}/nodes/${nodeId}/contexts/${this.ctxId}/consumer/${P_LIGHT}/properties/cState`] === '1',
        isMe: fkey === meKey,
        connId: null, litByMe: false,
      });
    }

    // 2) My OUTGOING light connections (provider side): peer firefly -> connId.
    const provBase = this.#base('provider', P_LIGHT);
    const provConnRe = new RegExp(`^${esc(provBase)}/connections/([^/]+)/consumer$`);
    for (const k in keys) {
      const m = k.match(provConnRe);
      if (!m) continue;
      const p = String(keys[k]).split('/');
      const fkey = `${p[1]}/${p[3]}`;
      const f = roster.get(fkey);
      if (!f || f.isMe) continue; // self-connection: legal, deranked, not played
      f.connId = m[1];
      f.litByMe = keys[`${provBase}/connections/${m[1]}/properties/sOut`] === '1';
    }

    // 3) My lamp: ON iff ANY incoming connection says sOut=1 (tug-of-war legal).
    const consBase = this.#base('consumer', P_LIGHT);
    const consConnRe = new RegExp(`^${esc(consBase)}/connections/([^/]+)/provider$`);
    const litBy = [];
    for (const k in keys) {
      const m = k.match(consConnRe);
      if (!m) continue;
      const p = String(keys[k]).split('/');
      const fkey = `${p[1]}/${p[3]}`;
      if (fkey === meKey) continue; // deranked self-connection
      if (keys[`${consBase}/connections/${m[1]}/properties/sOut`] === '1') {
        const who = roster.get(fkey);
        litBy.push({ name: who ? who.name : 'someone', color: who ? who.color : '#ffe178' });
      }
    }
    const lampOn = litBy.length > 0;
    if (lampOn !== this.myLampOn && this.#declared && this.client.isOpen()) {
      this.client.put(`${consBase}/properties/cState`, lampOn ? '1' : '0').catch(() => {});
      this.log(lampOn ? `✨ ${litBy.map((w) => w.name).join(' and ')} lit your lamp!` : 'Your lamp went dark.');
    }
    this.myLampOn = lampOn;
    this.litBy = litBy;

    // 4) Spirit's welcome — arrives ADDRESSED on my presence provider connection.
    const presBase = this.#base('provider', P_PRES);
    const welcomeRe = new RegExp(`^${esc(presBase)}/connections/([^/]+)/properties/welcome$`);
    for (const k in keys) {
      const m = k.match(welcomeRe);
      if (m && keys[k] && !this.#welcomed.has(m[1])) {
        this.#welcomed.add(m[1]);
        this.log(`🌟 The island spirit: ${keys[k]}`);
      }
    }

    // 5) Beacon: read the spirit's provider capability directly off the keys
    //    (level/pattern propagate — and capability keys are realm-visible).
    const beaconRe = new RegExp(`^cns/([^/]+)/nodes/([^/]+)/contexts/${ctx}/provider/${esc(P_BEACON)}/version$`);
    let beaconBase = null;
    for (const k in keys) {
      const m = k.match(beaconRe);
      if (m) { beaconBase = k.slice(0, -'/version'.length); break; }
    }
    const myBeacon = this.#base('consumer', P_BEACON);
    const beaconConnRe = new RegExp(`^${esc(myBeacon)}/connections/([^/]+)/provider$`);
    let beaconConn = null;
    for (const k in keys) {
      const m = k.match(beaconConnRe);
      if (m) { beaconConn = m[1]; break; }
    }
    this.beacon = {
      present: !!beaconBase,
      level: beaconBase ? Math.max(0, Math.min(100, parseInt(keys[`${beaconBase}/properties/level`] || '0', 10) || 0)) : 0,
      pattern: beaconBase ? (keys[`${beaconBase}/properties/pattern`] || 'calm') : 'calm',
      connId: beaconConn,
    };
    const granted = beaconConn ? keys[`${myBeacon}/connections/${beaconConn}/properties/granted`] : null;
    if (granted && granted !== this.#lastGranted) {
      if (this.#lastGranted !== null) this.log('✦ The beacon drank your light. It burns brighter.');
      this.#lastGranted = granted;
      this.pendingBoost = 0; // realm has caught up with the optimistic glow
    }

    // 5b) OTHER fireflies feeding: their addressed `feed` counts are mirrored
    //     on the spirit's provider-side connections — watch them tick up.
    if (beaconBase) {
      const spiritConnRe = new RegExp(`^${esc(beaconBase)}/connections/([^/]+)/consumer$`);
      const feeds = {};
      const first = this.#lastFeeds === null; // baseline silently, no replay
      for (const k in keys) {
        const m = k.match(spiritConnRe);
        if (!m) continue;
        const p = String(keys[k]).split('/');
        const fkey = `${p[1]}/${p[3]}`;
        const n = parseInt(keys[`${beaconBase}/connections/${m[1]}/properties/feed`] || '0', 10) || 0;
        feeds[m[1]] = n;
        const prev = first ? n : (this.#lastFeeds[m[1]] ?? n);
        if (n > prev && fkey !== meKey) {
          this.emit('peerfeedfx', { key: fkey });
          const who = roster.get(fkey);
          if (who) this.log(`${who.name} fed the beacon ✦`);
        }
      }
      this.#lastFeeds = feeds;
    }

    // 5c) EVERY switch->lamp act on the island, animated for everyone:
    //     all provider-side per-connection sOut values are realm-visible;
    //     when one flips, fly a mote from that switch's firefly to its lamp.
    {
      const wireRe = new RegExp(`^cns/([^/]+)/nodes/([^/]+)/contexts/${ctx}/provider/${esc(P_LIGHT)}/connections/([^/]+)/(consumer|properties/sOut)$`);
      const wires = {};
      for (const k in keys) {
        const m = k.match(wireRe);
        if (!m) continue;
        const id = `${m[1]}/${m[2]}/${m[3]}`;
        const w = wires[id] || (wires[id] = { from: `${m[1]}/${m[2]}`, to: null, sOut: null });
        if (m[4] === 'consumer') { const p = String(keys[k]).split('/'); w.to = `${p[1]}/${p[3]}`; }
        else w.sOut = keys[k];
      }
      // who holds each lamp lit — drives blaze AND the visible holder beads
      for (const id in wires) {
        const w = wires[id];
        if (w.sOut === '1' && w.to && w.from !== w.to) {
          const target = roster.get(w.to);
          const holder = roster.get(w.from);
          if (target) {
            target.held = (target.held || 0) + 1;
            (target.holders || (target.holders = [])).push({
              color: holder ? holder.color : '#ffe178',
              isMe: w.from === meKey,
            });
          }
        }
      }
      const first = this.#lastSOut === null;
      const last = first ? {} : this.#lastSOut;
      const cur = {};
      for (const id in wires) {
        const w = wires[id];
        if (w.sOut !== null) cur[id] = w.sOut;
        if (first || w.sOut === null || !w.to || w.from === w.to) continue; // baseline / self-conn
        const prev = last[id];
        if (prev !== undefined && prev !== w.sOut && w.from !== meKey) {
          this.emit('togglefx', { from: w.from, to: w.to, on: w.sOut === '1' });
          const a = roster.get(w.from), b = roster.get(w.to);
          if (a && b && !b.isMe) {
            this.log(w.sOut === '1' ? `${a.name} lit ${b.name}'s lamp ✨` : `${a.name} let go of ${b.name}'s lamp`);
          }
        }
      }
      this.#lastSOut = cur;
    }

    // 6) Order: me first, then bound peers, then the not-yet-bound.
    this.fireflies = [...roster.values()].sort((a, b) =>
      (b.isMe - a.isMe) || ((b.connId ? 1 : 0) - (a.connId ? 1 : 0)) || a.name.localeCompare(b.name));

    // 7) All-lit celebration (rising edge, needs at least 2 fireflies).
    const allLit = this.fireflies.length >= 2 && this.fireflies.every((f) => f.lampOn);
    if (allLit && !this.#wasAllLit) {
      this.celebrateUntil = performance.now() + 6000;
      this.log('🎆 EVERY LAMP ON THE ISLAND IS LIT!');
    }
    this.#wasAllLit = allLit;

    // 8) Fiction state machine.
    const others = this.fireflies.filter((f) => !f.isMe);
    const bound = others.filter((f) => f.connId);
    if (others.length === 0) this.setState('alone');
    else if (bound.length === 0) this.setState('waiting');
    else this.setState('live');
    this.emit('change');
  }

  // Tap a firefly: ADDRESSED write into that one connection — never broadcast.
  async toggle(fkey) {
    const f = this.fireflies.find((x) => x.key === fkey);
    if (!f || f.isMe || !f.connId || !this.client || !this.client.isOpen()) return;
    const key = `${this.#base('provider', P_LIGHT)}/connections/${f.connId}/properties/sOut`;
    const next = f.litByMe ? '0' : '1';
    this.emit('tapfx', { key: f.key, on: next === '1' }); // reward FIRST, realm truth follows
    try {
      await this.client.put(key, next);
      this.log(next === '1' ? `You lit ${f.name}'s lamp.` : `You let go of ${f.name}'s lamp.`);
    } catch (e) { this.log(`✗ Write failed: ${e.message || e}`); }
  }

  // Feed the beacon: monotonic tap-count, ADDRESSED to the spirit's connection.
  // Feedback is instant and optimistic (mote + glow); the spirit's `granted`
  // ack then confirms and replaces the optimism with realm truth.
  async feed() {
    if (!this.beacon.connId || !this.client || !this.client.isOpen()) return;
    const n = (parseInt(localStorage.getItem(LS_FEED) || '0', 10) || 0) + 1;
    localStorage.setItem(LS_FEED, String(n));
    this.pendingBoost = Math.min(30, this.pendingBoost + 3);
    this.pendingAt = performance.now();
    this.emit('feedfx');
    const key = `${this.#base('consumer', P_BEACON)}/connections/${this.beacon.connId}/properties/feed`;
    try { await this.client.put(key, String(n)); }
    catch (e) { this.log(`✗ Feed failed: ${e.message || e}`); }
  }

  // Publish my position as realm state (presence CP v2 `spot`, propagates).
  async pushSpot(s) {
    if (!this.client || !this.client.isOpen() || !this.#declared) return;
    const v = `${s.x.toFixed(3)},${s.y.toFixed(3)}`;
    try { await this.client.put(`${this.#base('provider', P_PRES)}/properties/spot`, v); }
    catch (_) {}
  }

  shareUrl() {
    // Always name the island fully: realm host + context id. A share link
    // is an invitation to THIS island, wherever the app's defaults drift.
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('host', this.me.host);
    u.searchParams.set('island', this.ctxId);
    return u.toString();
  }

  leave() {
    if (this.client) { try { this.client.close(); } catch (_) {} this.client = null; }
    this.#joined = false;
    this.setState('idle');
  }
})();

// ------------------------------------------------------------------- the UI
const $ = (s) => document.querySelector(s);

function fictionLine() {
  switch (game.state) {
    case 'connecting': return 'Your firefly is crossing the water…';
    case 'joining': return 'Your firefly is finding its way to the island…';
    case 'alone': return 'The island is quiet. Share the link — lamps need friends.';
    case 'waiting': return 'Fireflies nearby! The island spirits are wiring the lanterns…';
    case 'live': return game.myLampOn ? 'Your lamp is LIT. Return the favor?' : 'Glide close to a firefly, then tap to light their lamp.';
    case 'error': return game.lastError || 'Something went wrong.';
    default: return '';
  }
}

function posFor(key, i, n, W, H) {
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const angle = (i / Math.max(n, 1)) * Math.PI * 2 + (h % 100) / 100;
  const rx = W * 0.30 + (h % 37) / 37 * W * 0.08;
  const ry = H * 0.20 + (h % 23) / 23 * H * 0.06;
  return { x: W / 2 + Math.cos(angle) * rx, y: H * 0.52 + Math.sin(angle) * ry };
}

// Realm-declared spot wins; local drag override wins harder; hash-seat fallback.
let dragSpot = null;
let isDragging = false; // reach halo shows only while actively moving
function flyPos(f, i, n, W, H) {
  let s = f.spot;
  if (f.isMe && dragSpot) s = dragSpot;
  if (s) return { x: s.x * W, y: s.y * H };
  return posFor(f.key, i, n, W, H);
}

let hit = [];
let sparks = [];
let cursor = null; // canvas-relative pointer, for firefly excitement
let motes = [];        // sparks of light flying from your firefly to a target
let rings = [];        // expanding flash rings where motes land
let mePos = null;

const beaconLight = (W, H) => ({ x: W / 2, y: H * 0.40 - 12 });

function drawBeacon(g, W, H, t) {
  const b = game.beacon;
  if (!b.present) return;
  const bx = W / 2, byTop = H * 0.40, byBase = H * 0.62;
  // tower
  g.fillStyle = '#2a3d6b';
  g.beginPath();
  g.moveTo(bx - 9, byBase); g.lineTo(bx - 5, byTop); g.lineTo(bx + 5, byTop); g.lineTo(bx + 9, byBase);
  g.closePath(); g.fill();
  g.fillStyle = '#3a548c';
  g.fillRect(bx - 7, byTop - 8, 14, 8);
  // light, scaled by level (+ optimistic boost while a feed awaits its ack)
  const now = performance.now();
  const boost = (now - game.pendingAt < 10000) ? game.pendingBoost : 0;
  const lv = Math.min(100, b.level + boost) / 100;
  const pulse = b.pattern === 'festival' ? (0.75 + 0.25 * Math.sin(t * 6)) : 1;
  const r = (12 + lv * 46) * pulse;
  if (r > 2) {
    const glow = g.createRadialGradient(bx, byTop - 12, 2, bx, byTop - 12, r);
    glow.addColorStop(0, `rgba(255,214,94,${0.75 * Math.max(lv, 0.15)})`);
    glow.addColorStop(1, 'rgba(255,214,94,0)');
    g.fillStyle = glow;
    g.beginPath(); g.arc(bx, byTop - 12, r, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = lv > 0.05 ? '#ffe89a' : '#3a4666';
  g.beginPath(); g.arc(bx, byTop - 12, 4, 0, Math.PI * 2); g.fill();
  // the beacon IS the feed button — when your glow reaches it
  if (b.connId) {
    const near = !mePos || Math.hypot((bx - mePos.x) / W, (byTop - 12 - mePos.y) / H) <= BEACON_REACH;
    g.fillStyle = near ? 'rgba(255,225,120,0.8)' : 'rgba(255,225,120,0.45)';
    g.font = '12px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(near ? 'tap to feed ✦' : 'glide closer to feed ✦', bx, byBase + 18);
    hit.push({ x: bx, y: byTop - 12, r: 34, beacon: true, inReach: near, name: 'the beacon' });
  }
}

function drawMotes(g, W, H) {
  const now = performance.now();
  motes = motes.filter((m) => now - m.born < m.dur);
  for (const m of motes) {
    const to = m.to || beaconLight(W, H);
    const p = (now - m.born) / m.dur;
    const e = 1 - (1 - p) * (1 - p); // ease-out
    const x = m.from.x + (to.x - m.from.x) * e;
    const y = m.from.y + (to.y - m.from.y) * e - Math.sin(p * Math.PI) * 40; // gentle arc
    const [core, glowC] = m.dim
      ? ['#b9c6e8', 'rgba(150,170,220,0.7)']
      : ['#fff3c4', 'rgba(255,236,160,0.95)'];
    const glow = g.createRadialGradient(x, y, 1, x, y, 12);
    glow.addColorStop(0, glowC);
    glow.addColorStop(1, 'rgba(255,236,160,0)');
    g.fillStyle = glow;
    g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = core;
    g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
    if (p > 0.96 && !m.landed) { m.landed = true; rings.push({ x: to.x, y: to.y, at: now, dim: m.dim }); }
  }
  rings = rings.filter((r) => now - r.at < 600);
  for (const r of rings) {
    const age = (now - r.at) / 600;
    g.strokeStyle = r.dim ? `rgba(150,170,220,${0.7 * (1 - age)})` : `rgba(255,225,120,${0.8 * (1 - age)})`;
    g.lineWidth = 2;
    g.beginPath(); g.arc(r.x, r.y, 6 + age * 30, 0, Math.PI * 2); g.stroke();
  }
}

function drawCelebration(g, W, H) {
  const now = performance.now();
  if (now > game.celebrateUntil) { sparks = []; return; }
  if (sparks.length === 0) {
    for (let i = 0; i < 90; i++) {
      sparks.push({
        x: W / 2, y: H * 0.45,
        vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.8) * 5,
        c: COLORS[i % COLORS.length], born: now, life: 2500 + Math.random() * 3000,
      });
    }
  }
  for (const s of sparks) {
    const age = now - s.born;
    if (age > s.life) continue;
    s.x += s.vx; s.y += s.vy; s.vy += 0.03;
    g.globalAlpha = 1 - age / s.life;
    g.fillStyle = s.c;
    g.fillRect(s.x, s.y, 2.5, 2.5);
  }
  g.globalAlpha = 1;
}

function draw() {
  const cv = $('#island'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = performance.now() / 1000;

  // twilight indigo — the blue hour (FF v24)
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1b2150'); sky.addColorStop(0.55, '#2a2f6b'); sky.addColorStop(1, '#1d3d63');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  let sh = 7;
  for (let i = 0; i < 40; i++) {
    sh = (sh * 16807) % 2147483647;
    g.fillStyle = `rgba(255,255,255,${0.2 + (sh % 60) / 100})`;
    g.fillRect((sh % W), (sh % Math.floor(H * 0.5)), 1.5, 1.5);
  }
  g.fillStyle = '#20355c';
  g.beginPath(); g.ellipse(W / 2, H * 0.78, W * 0.46, H * 0.16, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2a4570';
  g.beginPath(); g.ellipse(W / 2, H * 0.74, W * 0.40, H * 0.12, 0, 0, Math.PI * 2); g.fill();

  hit = [];
  drawBeacon(g, W, H, t); // also registers the beacon's tap region in `hit`
  const flies = game.fireflies;
  flies.forEach((f, i) => {
    const { x, y } = flyPos(f, i, flies.length, W, H);
    const on = f.lampOn;
    // excitement: fireflies stir when the cursor comes near (0..1)
    const dCur = cursor ? Math.hypot(x - cursor.x, y - cursor.y) : Infinity;
    const excite = dCur < 120 ? 1 - dCur / 120 : 0;
    const bob = Math.sin(t * 1.4 + i * 2.1) * 3 + Math.sin(t * 9 + i * 3.3) * 2.5 * excite;
    const yy = y + bob;
    if (f.isMe) mePos = { x, y: yy }; // current-frame (I sort first in the roster)
    const reach = myReach(); // grows with every firefly holding my lamp lit
    const inReach = f.isMe || !mePos ||
      Math.hypot((x - mePos.x) / W, (yy - mePos.y) / H) <= reach;

    if (f.isMe && isDragging) {
      // my reach — the visible scope of my powers, shown while moving
      g.fillStyle = 'rgba(140,200,255,0.05)';
      g.beginPath(); g.ellipse(x, yy, reach * W, reach * H, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = `rgba(140,200,255,${0.25 + 0.08 * Math.sin(t * 2)})`;
      g.lineWidth = 1.5;
      g.setLineDash([6, 8]);
      g.lineDashOffset = -((t * 20) % 14);
      g.beginPath(); g.ellipse(x, yy, reach * W, reach * H, 0, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]); g.lineDashOffset = 0;
    }

    if (!f.isMe && f.connId) {
      const me = flies.find((m) => m.isMe);
      if (me) {
        const mp = flyPos(me, flies.indexOf(me), flies.length, W, H);
        g.strokeStyle = 'rgba(120,180,255,0.10)';
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(mp.x, mp.y); g.lineTo(x, yy); g.stroke();
      }
    }

    // dock-style zoom: the whole firefly assembly magnifies as you approach,
    // so the holder beads become readable right when you need to read them.
    // (The reach halo stays OUTSIDE this transform — it must never lie.)
    const s = 1 + 0.9 * excite * excite;
    g.save();
    g.translate(x, yy); g.scale(s, s); g.translate(-x, -yy);

    if (on) {
      // quiet at rest, swelling with holders and with nearby presence
      const flick = 1 + 0.04 * Math.sin(t * 5 + i * 1.7);
      const gr = (20 + 6 * Math.min((f.held || 1) - 1, 3)) * flick * (1 + 0.25 * excite);
      const glow = g.createRadialGradient(x, yy, 1, x, yy, gr);
      glow.addColorStop(0, hexA(f.color, 0.5 + 0.4 * excite));
      glow.addColorStop(0.4, hexA(f.color, 0.22 + 0.25 * excite));
      glow.addColorStop(1, hexA(f.color, 0));
      g.fillStyle = glow;
      g.beginPath(); g.arc(x, yy, gr, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgba(255,255,240,${0.75 + 0.2 * excite})`; // small hot core
      g.beginPath(); g.arc(x, yy, 2.2 + excite, 0, Math.PI * 2); g.fill();
    }
    if (on) {
      g.fillStyle = f.color;
      g.beginPath(); g.arc(x, yy, 7, 0, Math.PI * 2); g.fill();
    } else {
      // truly off: no glow, no color — just a white-outlined firefly
      g.fillStyle = '#0d1430';
      g.beginPath(); g.arc(x, yy, 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, yy, 5, 0, Math.PI * 2); g.stroke();
    }
    if (f.isMe) {
      g.strokeStyle = 'rgba(140,200,255,0.9)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, yy, 10, 0, Math.PI * 2); g.stroke();
    }
    // holder beads: one per switch holding this lamp, in the holder's color;
    // mine is white-ringed — so everyone always sees exactly who holds whom
    if (f.holders && f.holders.length) {
      f.holders.forEach((h2, j) => {
        const a = -Math.PI / 2 + (j - (f.holders.length - 1) / 2) * 0.55;
        const bx2 = x + Math.cos(a) * 14, by2 = yy + Math.sin(a) * 14;
        g.fillStyle = '#0a1128'; // dark backing so beads read over any glow
        g.beginPath(); g.arc(bx2, by2, 4.2, 0, Math.PI * 2); g.fill();
        g.fillStyle = h2.color;
        g.beginPath(); g.arc(bx2, by2, 3, 0, Math.PI * 2); g.fill();
        if (h2.isMe) {
          g.strokeStyle = '#fff'; g.lineWidth = 1.2;
          g.beginPath(); g.arc(bx2, by2, 4.4, 0, Math.PI * 2); g.stroke();
        }
      });
    }
    if (!f.isMe && f.connId && inReach) {
      // within my powers: a soft pulsing ring in their color
      g.strokeStyle = hexA(f.color, 0.32 + 0.12 * Math.sin(t * 3 + i));
      g.lineWidth = 1.2;
      g.beginPath(); g.arc(x, yy, 15 + Math.sin(t * 3 + i) * 1.5, 0, Math.PI * 2); g.stroke();
    }

    g.fillStyle = f.isMe ? '#9cc9ff' : (f.connId ? '#d8e2f5' : 'rgba(216,226,245,0.45)');
    g.font = '12px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(f.isMe ? `${f.name} (you)` : f.name, x, yy + 24);
    if (!f.isMe && !f.connId) g.fillText('…drifting closer…', x, yy + 38);
    g.restore();

    // tap target grows with the zoom so the visuals never lie about the hit area
    hit.push({ x, y: yy, r: 22 * s, key: f.key, isMe: f.isMe, bound: !!f.connId, inReach, name: f.name });
  });

  drawMotes(g, W, H);
  drawCelebration(g, W, H);
  requestAnimationFrame(draw);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function refresh() {
  const gate = $('#gate'), play = $('#play');
  const joined = game.state !== 'idle';
  gate.hidden = joined; play.hidden = !joined;
  const st = $('#status');
  const lit = game.state === 'live' && game.myLampOn;
  const pill = (name, color) => {
    const p = document.createElement('span');
    p.className = 'pill';
    p.textContent = name;
    p.style.background = color;
    return p;
  };
  if (game.state === 'live') {
    st.replaceChildren('You are', pill(game.me.name, game.me.color));
    if (lit) {
      st.append('· Lit by:');
      for (const w of game.litBy) st.append(pill(w.name, w.color));
    } else {
      st.append('— your lamp is dark');
    }
  } else {
    st.textContent = fictionLine();
  }
  st.classList.toggle('lit', lit);
  st.classList.toggle('error', game.state === 'error');
  // where am I: the island's full address (realm host, + ctx when custom)
  $('#where').textContent = joined
    ? game.me.host + (game.ctxId !== ISLAND_CTX_ID ? ` · ${game.ctxId}` : '')
    : '';
}

function showQr() {
  const u = game.shareUrl();
  try {
    const qr = qrcode(0, 'M');
    qr.addData(u); qr.make();
    $('#qrimg').src = qr.createDataURL(6, 8);
  } catch (_) { $('#qrimg').removeAttribute('src'); }
  $('#qrurl').textContent = u;
  $('#qrmodal').hidden = false;
}

function wireUi() {
  document.querySelectorAll('.ffv').forEach((el) => { el.textContent = FF_VERSION; });
  const url = new URLSearchParams(location.search);
  $('#name').value = localStorage.getItem(LS_NAME) || '';
  $('#host').value = url.get('host') || localStorage.getItem(LS_HOST) || DEFAULT_HOST;

  // color swatches
  const saved = localStorage.getItem(LS_COLOR) || COLORS[0];
  const sw = $('#colors');
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.style.background = c;
    b.classList.toggle('sel', c === saved);
    b.addEventListener('click', () => {
      sw.querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    });
    b.dataset.color = c;
    sw.appendChild(b);
  });

  $('#join').addEventListener('click', () => {
    const name = $('#name').value.trim();
    if (!name) { $('#name').focus(); return; }
    const color = (sw.querySelector('.swatch.sel') || sw.firstChild).dataset.color;
    game.join(name, $('#host').value.trim(), color);
  });
  $('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join').click(); });
  $('#fab').addEventListener('click', () => { $('#fan').hidden = !$('#fan').hidden; });
  $('#leave').addEventListener('click', () => { $('#fan').hidden = true; game.leave(); refresh(); });
  $('#share').addEventListener('click', () => { $('#fan').hidden = true; showQr(); });
  $('#qrclose').addEventListener('click', () => { $('#qrmodal').hidden = true; });
  $('#qrcopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(game.shareUrl()); $('#qrcopy').textContent = 'Copied!'; }
    catch (_) {}
    setTimeout(() => { $('#qrcopy').textContent = 'Copy link'; }, 1500);
  });
  const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (_) {} };
  game.on('feedfx', () => {
    const cv = $('#island');
    const from = mePos || { x: cv.clientWidth / 2, y: cv.clientHeight * 0.9 };
    motes.push({ from, to: null, born: performance.now(), dur: 750 }); // null target = the beacon
    buzz();
  });
  game.on('peerfeedfx', ({ key }) => {
    const h = hit.find((x) => x.key === key);
    const cv = $('#island');
    const from = h ? { x: h.x, y: h.y } : { x: cv.clientWidth * 0.15, y: cv.clientHeight * 0.5 };
    motes.push({ from, to: null, born: performance.now(), dur: 750 });
  });
  game.on('togglefx', ({ from, to, on }) => {
    const a = hit.find((x) => x.key === from);
    const b = hit.find((x) => x.key === to);
    if (!a || !b) return;
    motes.push({ from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, born: performance.now(), dur: 600, dim: !on });
  });
  game.on('tapfx', ({ key, on }) => {
    const h = hit.find((x) => x.key === key);
    if (!h) return;
    const cv = $('#island');
    const from = mePos || { x: cv.clientWidth / 2, y: cv.clientHeight * 0.9 };
    motes.push({ from, to: { x: h.x, y: h.y }, born: performance.now(), dur: 600, dim: !on });
    buzz();
  });

  // ---- PWA install: Chrome/Android give us a prompt to defer; iOS never
  //      prompts (no Apple API) — the button shows Add-to-Home-Screen steps.
  let deferredPrompt = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!standalone) $('#install').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    $('#install').hidden = true;
    game.log('Firefly Island now lives on your home screen ✨');
  });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $('#install').hidden = false;
  $('#install').addEventListener('click', () => {
    if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; $('#install').hidden = true; }
    else $('#iosTip').hidden = !$('#iosTip').hidden;
  });

  // --- drag your own firefly (position becomes realm state via presence.spot)
  const cv = $('#island');
  let dragging = false, dragMoved = false, suppressClick = false;
  let lastSpotPush = 0, dragClearTimer = null;
  const norm = (e) => {
    const r = cv.getBoundingClientRect();
    return {
      x: Math.min(0.97, Math.max(0.03, (e.clientX - r.left) / r.width)),
      y: Math.min(0.92, Math.max(0.12, (e.clientY - r.top) / r.height)),
    };
  };
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const mine = hit.find((h) => h.isMe && (x - h.x) ** 2 + (y - h.y) ** 2 <= (h.r * 1.4) ** 2);
    if (!mine) return;
    dragging = true; isDragging = true; dragMoved = false;
    if (dragClearTimer) { clearTimeout(dragClearTimer); dragClearTimer = null; }
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    const rr = cv.getBoundingClientRect();
    cursor = { x: e.clientX - rr.left, y: e.clientY - rr.top };
    if (!dragging) return;
    dragMoved = true;
    dragSpot = norm(e);
    const now = performance.now();
    if (now - lastSpotPush > 250) { lastSpotPush = now; game.pushSpot(dragSpot); }
  });
  cv.addEventListener('pointerleave', () => { cursor = null; });
  cv.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false; isDragging = false;
    if (dragMoved) {
      suppressClick = true;
      dragSpot = norm(e);
      game.pushSpot(dragSpot);
      // keep the local override briefly while the realm echo catches up
      dragClearTimer = setTimeout(() => { dragSpot = null; }, 1500);
    }
  });

  cv.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    for (const h of hit) {
      if ((x - h.x) ** 2 + (y - h.y) ** 2 > h.r ** 2) continue;
      if (!h.inReach) { // too far: a fizzle where you aimed, and a hint
        rings.push({ x: h.x, y: h.y, at: performance.now(), dim: true });
        game.log(`Too far — glide closer to ${h.name}.`);
        return;
      }
      if (h.beacon) { game.feed(); return; }
      if (!h.isMe && h.bound) { game.toggle(h.key); return; }
    }
  });

  game.on('change', refresh);
  game.on('log', (m) => {
    // murmurs: the island narrates, then the words dissolve
    const el = $('#murmurs');
    const line = document.createElement('div');
    line.className = 'murmur';
    line.textContent = m;
    el.appendChild(line);
    while (el.childElementCount > 5) el.firstChild.remove();
    setTimeout(() => line.remove(), 6500);
  });

  refresh();
  requestAnimationFrame(draw);

  if ($('#name').value && url.get('autojoin') !== '0') $('#join').click();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
document.addEventListener('DOMContentLoaded', wireUi);
