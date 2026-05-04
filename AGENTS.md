# AGENTS.md — Notes for Claude/agent collaborators

This file is for AI coding assistants (and humans) working on Oldcord. It captures the
non-obvious bits of the local environment, build, test setup, and conventions so an
agent can be productive without re-discovering them.

## Local environment

- **OS:** macOS (developer machine), but should work on any POSIX.
- **Node.js:** v22.x or v24.x. `package.json#engines` says `>=24.0.0` but v22 works
  for everything except some optional native modules. CI uses Node 24.
- **Package manager:** npm (workspaces). Don't introduce yarn/pnpm.
- **Shell:** zsh.
- **Docker:** required only for integration tests (Redis + Postgres). Optional in dev.

## Build / run

```bash
npm install                    # install deps + husky hook
cp config.example.json config.json   # required first time
npm run dev:server             # tsx watcher, starts the gateway+REST on config.port
npm run dev:loadbalancer       # standalone REST loadbalancer (multi-shard mode)
npm run build:server           # tsc → dist_server/
npm run start:server           # build then run dist_server/index.js
```

In **single-shard / legacy** mode (`config.json` → `sharding.enabled: false`),
behavior is identical to the pre-sharding code. **No Redis required.** The gateway
listens on `config.ws_port`, REST on `config.port`. This is the default.

In **multi-shard** mode, set `sharding.enabled: true` and list every shard in
`sharding.shards`. Then run one process per shard with `SHARD_ID=N`:

```bash
docker compose -f docker-compose.test.yml up -d redis postgres   # one Redis + one Postgres for everyone
SHARD_ID=0 npm run dev:server                                    # terminal 1
SHARD_ID=1 npm run dev:server                                    # terminal 2
npm run dev:loadbalancer                                         # terminal 3 (port 1336 by default)
```

`SHARD_ID` overrides `config.sharding.shard_id`. Each shard reads `config.sharding.shards[id]`
to know its host/port.

## Sharding architecture (one paragraph)

`shardmanager.ts` (singleton) computes `(BigInt(user_id) >> 22n) % BigInt(num_shards)` —
the formula required by the spec. `intershard.ts` is a thin wrapper over two `ioredis`
clients (publisher + subscriber) plus Redis KV helpers (session index, user→shard map,
voice rooms, presence cache, per-shard heartbeats). `dispatcher.js` is the central
broadcast surface: every public helper now dispatches to local sessions immediately,
and groups remote member ids by target shard, publishing one bulk pub/sub message per
shard. Incoming intershard messages re-enter the dispatcher through
`_handleIntershardMessage`, which calls private `_local*` helpers that never re-emit
(loop prevention via `origin_shard` tag). `voicemanager.ts` proxies voice room state:
in-memory in legacy mode, Redis-backed when sharding is on. The gateway-level safety
check on IDENTIFY closes wrong-shard connections with code `4014`, after which the
client re-fetches `/gateway` and lands on the right shard.

```
   client → /gateway → loadbalancer.ts → wss://shard-N
                                    │
                                    ▼
       shard 0 ── Redis pub/sub ── shard 1
            \                       /
             ── Redis KV (sessions, voice, presence)
                       │
                  PostgreSQL
```

Loadbalancer is REST-only — it does not proxy WebSocket frames. WS goes directly
client→shard. If routing is stale, the shard's IDENTIFY 4014 redirect cleans it up.

## Tests

- **Unit tests:** `npm run test:unit` (no external deps). Uses Node's built-in
  `node:test` runner via `tsx` for TS support. Don't reach for vitest — the project's
  `vite → rolldown-vite` override breaks vitest's transform.
- **Integration tests:** `npm run test:integration`. Needs Redis. Tests auto-skip
  (with a warning) when Redis is not reachable, so CI without docker still passes.
  To run with Redis:
  ```bash
  docker compose -f docker-compose.test.yml up -d redis
  npm run test:integration
  ```
- **Smoke tests:** `npm run test:smoke`. Verify legacy single-shard mode still works.
  No Redis needed. The smoke test auto-bootstraps a `config.json` from the example if
  one is missing (it never overwrites an existing config).
- **All:** `npm test` runs unit + smoke.

Tests live under `tests/{unit,integration,smoke}/*.test.ts`.

## Demo / defense

```bash
node scripts/demo-distribution.mjs 16 4   # show 16 user ids → 4 shards distribution
curl http://127.0.0.1:1336/gateway/status # health of every shard
curl http://127.0.0.1:1337/gateway/status # same, served from shard 0 directly
```

## Coding guidelines

- **TypeScript** is strict + `verbatimModuleSyntax`. Use `import type { X }` for type-only
  imports. `.ts` extensions are required in imports (the project relies on
  `rewriteRelativeImportExtensions`).
- **Biome** (`npx @biomejs/biome check .`) is the formatter and linter. Run via
  `npm run lint` / `npm run lint:fix`. The pre-commit hook (husky + lint-staged) runs
  `biome check --write` on staged files; fix issues at write-time, don't bypass with
  `--no-verify`.
- **`global.*`**: the pre-existing project keeps tonnes of state on `globalThis`
  (`global.userSessions`, `global.rooms`, `global.guild_voice_states`, etc). New shard
  manager / intershard / voiceManager instances are also exposed on global for
  consistency. Don't fight this style.
- **Sharding-aware helpers**: when adding a new broadcast in `dispatcher.js`, always
  follow the pattern: dispatch locally first, then group remote user ids by shard via
  `shardManager.getShardForUser(...)` and bulk-publish via `intershard.publishToShard`.
  Set a `kind:` discriminator and handle it in `_handleIntershardMessage`.
- **No-Redis mode**: every multi-shard helper must early-out cleanly when
  `shardManager.isEnabled()` is false. The existing in-memory paths must continue to
  pass smoke tests with no behavioral change.
- **Comments**: only when the *why* is non-obvious. Don't restate code.

## Documentation expectations

- New public helpers in `intershard.ts` / `voicemanager.ts` get a one-line JSDoc
  describing the contract and the legacy fallback (when applicable).
- Interfaces and TS types are exported alongside the helper.
- Don't add README/MD for trivial features — only `AGENTS.md` and inline comments.

## Known gotchas (save the agent some time)

- **Pre-existing biome violations** in `server/index.ts` and parts of
  `server/helpers/utils/globalutils.js` (`useAwait`, `noExplicitAny`) — these block
  pre-commit when those files are staged. Avoid touching them; if you must, factor
  changes into a separate helper file (we did this with `server/sharding-init.ts`).
- **`rolldown-vite` override** breaks vitest. We use `node:test` instead.
- **`config.json` is gitignored.** New devs must `cp config.example.json config.json`
  on first checkout. The smoke test auto-bootstraps it.
- **Cross-shard resume** code path: when the original shard is *alive*, we close the
  WS with `4014` and let the client re-fetch `/gateway`. When the original shard is
  *dead* (heartbeat TTL expired in Redis), we accept the resume locally from the
  persisted seq — the in-memory event buffer is gone, so we send `INVALID_SESSION`
  for any held seq that isn't in our buffer (which it never is).
- **The Loadbalancer needs HTTP access to shards** for `/api/users/@me` token
  resolution. Make sure `config.sharding.shards[].http_port` is reachable from the
  LB. In docker compose, this is just network connectivity.

## Files added/changed by sharding work

- New: `server/helpers/shardmanager.ts`, `server/helpers/intershard.ts`,
  `server/helpers/voicemanager.ts`, `server/loadbalancer.ts`,
  `server/sharding-init.ts`, `tests/`, `docker-compose.test.yml`,
  `scripts/demo-distribution.mjs`.
- Modified: `server/handlers/gateway.js` (IDENTIFY safety check, RESUME cross-shard,
  voice-state via voiceManager), `server/helpers/session.js` (Redis cleanup on
  terminate), `server/helpers/dispatcher.js` (local + remote dispatch),
  `server/api/index.js` (sharded `/gateway` and `/gateway/status`),
  `server/helpers/utils/globalutils.js` (`generateShardedGatewayURL`),
  `server/gateway.ts` (voiceManager.cleanupSession in handleClientClose),
  `config.example.json` (sharding/redis/loadbalancer sections),
  `package.json` (test scripts, ioredis, ioredis-mock).
