import { logText } from './utils/logger.ts';

export interface ShardInfo {
  id: number;
  host: string;
  ws_port: number;
  http_port: number;
  secure: boolean;
  status?: 'online' | 'down' | 'unknown';
  last_heartbeat?: number;
}

export interface ShardingConfig {
  enabled: boolean;
  num_shards: number;
  shard_id: number;
  shards: ShardInfo[];
}

/**
 * Pure hash function: shard_id = (BigInt(user_id) >> 22n) % BigInt(num_shards).
 * Discord-style snowflake user IDs encode timestamp in the upper bits; shifting
 * by 22 distributes by epoch milliseconds while keeping a single user's id
 * mapped deterministically to one shard.
 */
export function computeShardForUser(user_id: string | number, num_shards: number): number {
  if (num_shards <= 1) return 0;
  if (user_id === undefined || user_id === null) return 0;

  let id: bigint;
  try {
    id = BigInt(String(user_id));
  } catch {
    return 0;
  }

  if (id < 0n) id = -id;
  const result = (id >> 22n) % BigInt(num_shards);
  return Number(result);
}

class ShardManager {
  private shards: Map<number, ShardInfo> = new Map();
  private numShards = 1;
  private selfShardId = 0;
  private enabled = false;

  init(cfg: ShardingConfig, overrideShardId?: number): void {
    this.enabled = !!cfg.enabled;
    this.numShards = Math.max(1, cfg.num_shards | 0);
    this.selfShardId = overrideShardId ?? cfg.shard_id ?? 0;

    this.shards.clear();
    for (const s of cfg.shards || []) {
      this.shards.set(s.id, { ...s, status: 'unknown' });
    }

    if (this.enabled && !this.shards.has(this.selfShardId)) {
      logText(
        `shardmanager: self shard ${this.selfShardId} not present in config.shards[]`,
        'error',
      );
    }

    logText(
      `shardmanager: enabled=${this.enabled} num_shards=${this.numShards} self=${this.selfShardId}`,
      'shard',
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.numShards > 1;
  }

  isMultiShard(): boolean {
    return this.isEnabled();
  }

  getNumShards(): number {
    return this.numShards;
  }

  getSelfShardId(): number {
    return this.selfShardId;
  }

  getShardForUser(user_id: string | number): number {
    if (!this.isEnabled()) return this.selfShardId;
    const target = computeShardForUser(user_id, this.numShards);
    if (this.isShardDown(target)) {
      // passive failover: rendezvous fallback to next healthy shard
      for (let i = 1; i < this.numShards; i++) {
        const candidate = (target + i) % this.numShards;
        if (!this.isShardDown(candidate)) return candidate;
      }
    }
    return target;
  }

  isLocal(user_id: string | number): boolean {
    return this.getShardForUser(user_id) === this.selfShardId;
  }

  getShardInfo(shard_id: number): ShardInfo | undefined {
    return this.shards.get(shard_id);
  }

  getShardAddress(shard_id: number): { ws: string; http: string } | null {
    const s = this.shards.get(shard_id);
    if (!s) return null;
    const wsProto = s.secure ? 'wss' : 'ws';
    const httpProto = s.secure ? 'https' : 'http';
    return {
      ws: `${wsProto}://${s.host}:${s.ws_port}`,
      http: `${httpProto}://${s.host}:${s.http_port}`,
    };
  }

  getAllShards(): ShardInfo[] {
    return Array.from(this.shards.values());
  }

  markShardDown(shard_id: number): void {
    const s = this.shards.get(shard_id);
    if (s) {
      s.status = 'down';
      logText(`shardmanager: shard ${shard_id} marked DOWN`, 'shard');
    }
  }

  markShardUp(shard_id: number, ts?: number): void {
    const s = this.shards.get(shard_id);
    if (s) {
      s.status = 'online';
      s.last_heartbeat = ts ?? Date.now();
    }
  }

  isShardDown(shard_id: number): boolean {
    const s = this.shards.get(shard_id);
    if (!s) return true;
    return s.status === 'down';
  }

  getHealthyShards(): number[] {
    return Array.from(this.shards.values())
      .filter((s) => s.status !== 'down')
      .map((s) => s.id);
  }
}

const shardManager = new ShardManager();
export default shardManager;
