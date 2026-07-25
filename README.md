# Firefly Island

A tiny social toy on a CNS/CP realm: every visitor is a firefly whose lamp only
**others** can light. Phase 1 vertical slice — see `firefly-island-game-plan.md`
and `firefly-island-cps.md` in Experiments for the full design.

**Version: FF v2** (stamp in `index.html` footer — bump on every change).

v2 adds, on the `padi.game.*` CPs published 2026-07-25: colored fireflies +
spirit welcomes (`padi.game.presence`), the beacon with decay and feeding
(`padi.game.beacon`, see `spirit/`), QR share, and the all-lit celebration.

## Run

Static PWA, no build step:

```bash
cd firefly-island && python3 -m http.server 8474
# open http://localhost:8474  (or double-click "Start Firefly Island.command")
```

Deploy = push the folder to GitHub Pages (same pattern as the Monitor/Widget
PWAs). Share link: the in-app button copies the URL; `?island=<ctxId>` selects
an island, `?host=<realm>` a realm, `?autojoin=0` disables auto-rejoin.

## How it maps to the substrate (Phase 1)

- One shared **context** (`FireflyIslandPhase1Ctx`) = the island.
- Each player = one **node** declaring BOTH `padi.light` roles: provider (their
  switch) + consumer (their lamp). The broker binds every switch↔lamp pair in
  the context — **cross-system, live-verified** (see test below).
- Tapping a firefly = **addressed per-connection write** of `sOut` (never a
  broadcast capability write).
- A lamp is ON iff **any** incoming connection holds `sOut=1` — the OR is
  deliberate multi-connection semantics; tug-of-war is legal play.
- Your own switch→lamp self-connection is real and legal; the app **deranks**
  it (never played, never counted). App-level semantics, not a mechanism fix.
- Lamp state is reported honestly on the consumer capability (`cState`,
  propagates) so the whole island sees who is lit.

Ported invariants: value-wiper guard (skip declaration when `/version` exists),
no `.watch()` (derive from keys on `update`), auto-reconnect re-runs the
guarded join. Identity (system UUID + b62 node id) persists in localStorage.

## Exit test (headless, against the live realm)

```bash
npm i ws && node scripts/test-firefly.js
# env: ARETE_HOST=..., FF_INSECURE=1 (self-signed TLS), BIND_TIMEOUT_MS=...
```

Simulates two players with FIXED identities (no ghost accumulation; test
context `FireflyIslandTestCtx00`, never the real island).

**Result 2026-07-25 on anto.aretehosting.com: PASS, 3.0s total —
cross-system bind 1.2s, addressed write A→B visible at B in 0.4s.**
The Phase-1 architecture questions are closed: the broker binds across systems
sharing a context id, and bind latency on this realm is ~1s, not the feared
30–90s.

## The island spirit (beacon host)

Always-on node — run it anywhere with Node 18+ (e.g. alongside the realm):

```bash
cd spirit && npm i && npm start
# env: ARETE_HOST, ISLAND_CTX, DECAY_MS (45000), FEED_BONUS (3), FF_INSECURE=1
```

Provider of `padi.game.beacon` (level/pattern propagate; `granted` acks
addressed per connection) + consumer of `padi.game.presence` (addressed
`welcome` per firefly). **Stateless by design:** the feed baseline is the
`granted` value persisted on the realm per connection, so restarts lose
nothing. Level decays 1 point per DECAY_MS (floor 5); each tap feeds
+FEED_BONUS; ≥95 flips pattern to `festival` (the beacon pulses).

Spirit exit test (spawns a spirit on the TEST context + one player; verifies
welcome, feed→granted, level rise): `node scripts/test-spirit.js` —
**PASS 2026-07-25 live** (welcome addressed, +6 taps banked incl. 3 recovered
from a previous run, level propagated in 0.4s).

## Deploy to GitHub Pages (from Anto's terminal)

```bash
cd ~/Downloads/Claude/Experiments/firefly-island
git init && git add -A && git commit -m "Firefly Island FF v2"
# create project-arete/firefly-island on GitHub, then:
git remote add origin git@github.com:project-arete/firefly-island.git
git branch -M main && git push -u origin main
# GitHub repo Settings -> Pages -> deploy from branch main, / (root)
```

The app then lives at `https://project-arete.github.io/firefly-island/` —
that URL is what the in-app QR encodes. (`spirit/` and `scripts/` ride along
harmlessly; add a `.nojekyll` file if Pages ever mangles paths.)

### Custom domain: fireflyisland.org

The repo already carries a `CNAME` file with `fireflyisland.org`. Then:

1. GitHub repo → Settings → Pages → Custom domain: `fireflyisland.org`
   (wait for the DNS check, then tick **Enforce HTTPS** — required for the PWA).
2. At the registrar, add DNS records:
   - apex `fireflyisland.org` → **A** records `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `www` → **CNAME** `project-arete.github.io`
3. Give DNS + the Let's Encrypt cert a few minutes; then
   `https://fireflyisland.org` serves the game, and the in-app QR/share URL
   picks the domain up automatically (it's built from `location.href`).

## Phase 3 pointers

Single-context is deliberate here; place-based pairing needs the multi-context
attach pattern (Widget desktop v43). Invite tokens/owner rights await the
credentials work — the browser cannot attach Basic auth to WebSockets, so
tokens must ride the URL when the control plane learns to accept them.
