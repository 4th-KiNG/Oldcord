import dispatcher from './helpers/dispatcher.js';
import intershard from './helpers/intershard.ts';
import shardManager from './helpers/shardmanager.ts';
import globalUtils from './helpers/utils/globalutils.js';
import { logText } from './helpers/utils/logger.ts';

interface RawConfig {
  sharding?: {
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
  };
  redis?: { url?: string; key_prefix?: string };
}

export function initShardManager(rawConfig: unknown): void {
  const cfg = (rawConfig as RawConfig).sharding ?? {
    enabled: false,
    num_shards: 1,
    shard_id: 0,
    shards: [],
  };
  const envShardId = process.env.SHARD_ID !== undefined ? Number(process.env.SHARD_ID) : undefined;
  shardManager.init(cfg, envShardId);
  (globalThis as { shardManager?: unknown }).shardManager = shardManager;
  (globalThis as { intershard?: unknown }).intershard = intershard;

  // When sharding is enabled and the self shard has its own host/port entry,
  // override the top-level config.port / config.ws_port / config.base_url so
  // multiple shards can run side-by-side from a single config.json (selected
  // by the SHARD_ID env var).
  if (shardManager.isEnabled()) {
    const self = shardManager.getShardInfo(shardManager.getSelfShardId());
    if (self) {
      const c = rawConfig as { port?: number; ws_port?: number; base_url?: string };
      c.port = self.http_port;
      c.ws_port = self.ws_port;
      c.base_url = self.host;
      logText(
        `sharding-init: shard ${self.id} bound to ${self.host}:${self.http_port} (ws ${self.ws_port})`,
        'shard',
      );
    }
  }
}

/**
 * Connect to Redis and wire intershard handlers into the dispatcher.
 * Returns silently in single-shard mode. Logs and continues on failure
 * so a missing Redis does not crash the process — cross-shard messaging
 * is simply unavailable in that case.
 */
export async function connectIntershard(rawConfig: unknown): Promise<void> {
  if (!shardManager.isEnabled()) return;
  const redisCfg = (rawConfig as RawConfig).redis ?? {};
  try {
    await intershard.init({
      url: redisCfg.url ?? 'redis://127.0.0.1:6379',
      key_prefix: redisCfg.key_prefix ?? 'oldcord:',
    });
    intershard.onShardMessage((msg) => dispatcher._handleIntershardMessage(msg));
    intershard.onGuildMessage((msg) => dispatcher._handleIntershardMessage(msg));
    logText(
      `sharding active: shard ${shardManager.getSelfShardId()}/${shardManager.getNumShards()}`,
      'OLDCORD',
    );
  } catch (e) {
    logText(`intershard init failed; running without cross-shard messaging: ${e}`, 'error');
  }
}

// Side-effect bootstrap: run on import so server/index.ts does not need
// modification. shardManager is set up synchronously (cheap, legacy-safe).
// connectIntershard is fired on the next tick — by then global.gateway and
// the rest of the runtime are initialised, and Redis connection happens in
// the background. Failures are caught inside connectIntershard.
initShardManager(globalUtils.config);
setImmediate(() => {
  void connectIntershard(globalUtils.config);
});
