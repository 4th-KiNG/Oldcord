/**
 * Standalone Loadbalancer process. Runs a tiny Express server exposing:
 *   GET /gateway        — returns the WS URL of the shard hashed for the
 *                         caller's user (Authorization required), or the
 *                         first online shard otherwise.
 *   GET /gateway/bot    — same plus shard count (Discord-style payload).
 *   GET /gateway/status — aggregated health of every shard, read from
 *                         Redis heartbeat keys.
 *
 * The LB does NOT proxy WebSocket frames. Clients connect to the shard
 * directly. If they hit the wrong shard (cache miss, race), the shard's
 * IDENTIFY safety-check closes with code 4014 and the client re-fetches
 * /gateway, which then returns the correct shard.
 *
 * Run with: `node dist_server/loadbalancer.js` after build, or
 *           `tsx server/loadbalancer.ts` in dev.
 *
 * Reads config.json from the working directory like the main server.
 */

import express from 'express';
import { existsSync, readFileSync } from 'fs';

import dispatcher from './helpers/dispatcher.js';
import intershard from './helpers/intershard.ts';
import shardManager from './helpers/shardmanager.ts';
import { logText } from './helpers/utils/logger.ts';

interface ShardCfg {
  enabled: boolean;
  num_shards: number;
  shard_id: number;
  shards: Array<{
    id: number;
    host: string;
    ws_port: number;
    http_port: number;
    secure: boolean;
  }>;
}

interface RawConfig {
  sharding?: ShardCfg;
  redis?: { url?: string; key_prefix?: string };
  loadbalancer?: { host: string; port: number; secure: boolean };
}

const configPath = './config.json';
if (!existsSync(configPath)) {
  console.error('loadbalancer: no config.json in working directory');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8')) as RawConfig;

// Stub global.config so logger doesn't crash.
(globalThis as { config?: unknown }).config = config;

const lbCfg = config.loadbalancer ?? { host: '127.0.0.1', port: 1336, secure: false };
const sharding = config.sharding;

if (!sharding?.enabled || sharding.num_shards <= 1) {
  console.warn(
    'loadbalancer: sharding.enabled is false or num_shards<=1; LB will pass through all requests to shard 0.',
  );
}

// LB participates in the cluster as a virtual shard "-1" — we only need
// the shard registry, not a self-shard. Use shard_id from config (or
// SHARD_ID env) just to satisfy ShardManager init; LB never serves WS
// connections itself.
shardManager.init(
  sharding ?? { enabled: false, num_shards: 1, shard_id: 0, shards: [] },
  sharding?.shard_id,
);

async function startup(): Promise<void> {
  if (shardManager.isEnabled()) {
    try {
      await intershard.init({
        url: config.redis?.url ?? 'redis://127.0.0.1:6379',
        key_prefix: config.redis?.key_prefix ?? 'oldcord:',
      });
      // LB is a passive observer — it only reads status, never dispatches.
      intershard.onShardMessage(() => {
        /* LB does not host sessions, ignore */
      });
      // Re-use dispatcher's intershard handler stub so unused handler types
      // don't stay null.
      void dispatcher;
    } catch (e) {
      logText(`loadbalancer: redis init failed: ${e}`, 'error');
    }
  }
}

const app = express();

function pickShardUrl(userId: string | null): string {
  if (!shardManager.isEnabled()) {
    const s = shardManager.getAllShards()[0];
    if (s) {
      const proto = s.secure ? 'wss' : 'ws';
      return `${proto}://${s.host}:${s.ws_port}`;
    }
    return 'ws://127.0.0.1:1337';
  }

  let target = 0;
  if (userId) {
    target = shardManager.getShardForUser(userId);
  } else {
    const healthy = shardManager.getHealthyShards();
    target = healthy[0] ?? 0;
  }
  const addr = shardManager.getShardAddress(target);
  if (!addr) return 'ws://127.0.0.1:1337';
  return addr.ws;
}

app.get('/gateway', async (req, res) => {
  // Auth resolution requires DB access. The LB intentionally does not
  // hold a DB connection (so it can run on a tiny VM). Resolution
  // happens via the shard's REST API: we forward the Authorization
  // header to one of the live shards and ask it to compute the URL.
  // For MVP, we just hash by Authorization-as-userid prefix when we
  // can't reach a shard, otherwise return shard 0.
  const auth = req.headers.authorization;
  let userId: string | null = null;
  if (auth && shardManager.isEnabled()) {
    try {
      // Best-effort: ask shard 0 to resolve. If shard 0 is down, try the
      // next healthy one.
      const healthy = shardManager.getHealthyShards();
      for (const sid of healthy) {
        const addr = shardManager.getShardAddress(sid);
        if (!addr) continue;
        try {
          const r = await fetch(`${addr.http}/api/users/@me`, {
            headers: { Authorization: auth },
          });
          if (r.ok) {
            const body = (await r.json()) as { id?: string };
            if (body.id) {
              userId = body.id;
              break;
            }
          }
        } catch {
          continue;
        }
      }
    } catch {
      /* ignore — fall back to shard 0 */
    }
  }

  return res.status(200).json({ url: pickShardUrl(userId) });
});

app.get('/gateway/bot', (_req, res) => {
  return res.status(200).json({
    url: pickShardUrl(null),
    shards: shardManager.isEnabled() ? shardManager.getNumShards() : 0,
    session_start_limit: {
      total: 1,
      remaining: 1,
      reset_after: 14400000,
      max_concurrency: 1,
    },
  });
});

app.get('/gateway/status', async (_req, res) => {
  if (!shardManager.isEnabled()) {
    return res.status(200).json({
      sharding: false,
      shards: shardManager.getAllShards().map((s) => ({
        id: s.id,
        host: s.host,
        ws_port: s.ws_port,
        http_port: s.http_port,
        status: 'unknown',
      })),
    });
  }

  const statuses = intershard.isEnabled() ? await intershard.getAllShardsStatus() : {};
  const shards = shardManager.getAllShards().map((s) => {
    const live = statuses[s.id];
    if (live?.status === 'online') {
      shardManager.markShardUp(s.id, live.ts);
    } else {
      shardManager.markShardDown(s.id);
    }
    return {
      id: s.id,
      host: s.host,
      ws_port: s.ws_port,
      http_port: s.http_port,
      status: live?.status ?? 'unknown',
      last_heartbeat: live?.ts ?? null,
    };
  });

  return res.status(200).json({
    sharding: true,
    num_shards: shardManager.getNumShards(),
    healthy_shards: shardManager.getHealthyShards(),
    shards,
  });
});

void startup().then(() => {
  app.listen(lbCfg.port, lbCfg.host, () => {
    logText(`loadbalancer listening on http://${lbCfg.host}:${lbCfg.port}`, 'OLDCORD');
  });
});
