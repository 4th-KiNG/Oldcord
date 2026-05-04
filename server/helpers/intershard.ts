import type { Redis } from 'ioredis';
import shardManager from './shardmanager.ts';
import { logText } from './utils/logger.ts';

export interface IntershardMessage {
  kind: string;
  origin_shard: number;
  [key: string]: unknown;
}

export interface SessionIndexEntry {
  shard_id: number;
  user_id: string;
  seq: number;
  last_seen: number;
}

export type IntershardHandler = (msg: IntershardMessage) => void | Promise<void>;

const SESSION_TTL_SECONDS = 600;
const SHARD_STATUS_TTL = 15;
const SHARD_HEARTBEAT_INTERVAL_MS = 5000;

class Intershard {
  private pub: Redis | null = null;
  private sub: Redis | null = null;
  private prefix = 'oldcord:';
  private enabled = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private guildSubscriptions: Map<string, number> = new Map();
  private messageHandler: IntershardHandler | null = null;
  private guildMessageHandler: IntershardHandler | null = null;
  private testRedis: Redis | null = null;

  /**
   * Allow tests to inject a mocked Redis client (ioredis-mock) bypassing real
   * connections. Must be called before init().
   */
  _setTestClient(client: Redis): void {
    this.testRedis = client;
  }

  async init(opts: { url: string; key_prefix?: string }): Promise<void> {
    if (!shardManager.isEnabled()) {
      logText('intershard: skipped (single-shard mode)', 'shard');
      this.enabled = false;
      return;
    }

    this.prefix = opts.key_prefix || 'oldcord:';

    if (this.testRedis) {
      this.pub = this.testRedis;
      // ioredis-mock requires duplicate() for sub client
      const dup = this.testRedis as Redis & { duplicate: () => Redis };
      this.sub = dup.duplicate();
    } else {
      try {
        const mod = (await import('ioredis')) as unknown as {
          Redis?: new (url: string, opts?: object) => Redis;
          default?: new (url: string, opts?: object) => Redis;
        };
        const RedisCtor = mod.Redis ?? mod.default;
        if (!RedisCtor) throw new Error('ioredis Redis ctor not found');
        this.pub = new RedisCtor(opts.url, { lazyConnect: false });
        this.sub = new RedisCtor(opts.url, { lazyConnect: false });
      } catch (e) {
        logText(`intershard: failed to load ioredis: ${e}`, 'error');
        this.enabled = false;
        return;
      }
    }

    const sub = this.sub;
    if (!sub) {
      this.enabled = false;
      return;
    }
    sub.on('message', (channel: string, payload: string) => {
      this._dispatchIncoming(channel, payload);
    });

    const selfId = shardManager.getSelfShardId();
    const selfChannel = `${this.prefix}shard:${selfId}`;
    await sub.subscribe(selfChannel);
    await sub.subscribe(`${this.prefix}control`);

    this.enabled = true;
    logText(`intershard: connected, subscribed to ${selfChannel}`, 'shard');

    await this._publishControl({ kind: 'shard_up', shard_id: selfId });
    this.startHeartbeat();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  onShardMessage(handler: IntershardHandler): void {
    this.messageHandler = handler;
  }

  onGuildMessage(handler: IntershardHandler): void {
    this.guildMessageHandler = handler;
  }

  async publishToShard(
    shard_id: number,
    msg: Omit<IntershardMessage, 'origin_shard'>,
  ): Promise<void> {
    if (!this.enabled || !this.pub) return;
    if (shard_id === shardManager.getSelfShardId()) return; // no self-loop
    const fullMsg: IntershardMessage = {
      ...msg,
      origin_shard: shardManager.getSelfShardId(),
    };
    await this.pub.publish(`${this.prefix}shard:${shard_id}`, JSON.stringify(fullMsg));
  }

  async publishToGuild(
    guild_id: string,
    msg: Omit<IntershardMessage, 'origin_shard'>,
  ): Promise<void> {
    if (!this.enabled || !this.pub) return;
    const fullMsg: IntershardMessage = {
      ...msg,
      origin_shard: shardManager.getSelfShardId(),
    };
    await this.pub.publish(`${this.prefix}guild:${guild_id}`, JSON.stringify(fullMsg));
  }

  async subscribeGuild(guild_id: string): Promise<void> {
    if (!this.enabled || !this.sub) return;
    const cur = this.guildSubscriptions.get(guild_id) ?? 0;
    this.guildSubscriptions.set(guild_id, cur + 1);
    if (cur === 0) {
      await this.sub.subscribe(`${this.prefix}guild:${guild_id}`);
    }
  }

  async unsubscribeGuild(guild_id: string): Promise<void> {
    if (!this.enabled || !this.sub) return;
    const cur = this.guildSubscriptions.get(guild_id) ?? 0;
    if (cur <= 1) {
      this.guildSubscriptions.delete(guild_id);
      await this.sub.unsubscribe(`${this.prefix}guild:${guild_id}`);
    } else {
      this.guildSubscriptions.set(guild_id, cur - 1);
    }
  }

  // ------- Session index -------
  async setSessionIndex(session_id: string, entry: SessionIndexEntry): Promise<void> {
    if (!this.enabled || !this.pub) return;
    await this.pub.set(
      `${this.prefix}session:${session_id}`,
      JSON.stringify(entry),
      'EX',
      SESSION_TTL_SECONDS,
    );
  }

  async getSessionIndex(session_id: string): Promise<SessionIndexEntry | null> {
    if (!this.enabled || !this.pub) return null;
    const raw = await this.pub.get(`${this.prefix}session:${session_id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionIndexEntry;
    } catch {
      return null;
    }
  }

  async removeSessionIndex(session_id: string): Promise<void> {
    if (!this.enabled || !this.pub) return;
    await this.pub.del(`${this.prefix}session:${session_id}`);
  }

  async setUserShard(user_id: string, shard_id: number): Promise<void> {
    if (!this.enabled || !this.pub) return;
    await this.pub.set(
      `${this.prefix}user:${user_id}:shard`,
      String(shard_id),
      'EX',
      SESSION_TTL_SECONDS,
    );
  }

  async getUserShard(user_id: string): Promise<number | null> {
    if (!this.enabled || !this.pub) return null;
    const raw = await this.pub.get(`${this.prefix}user:${user_id}:shard`);
    return raw ? Number(raw) : null;
  }

  async removeUserShard(user_id: string): Promise<void> {
    if (!this.enabled || !this.pub) return;
    await this.pub.del(`${this.prefix}user:${user_id}:shard`);
  }

  // ------- Presence -------
  async setPresence(user_id: string, presence: unknown): Promise<void> {
    if (!this.enabled || !this.pub) return;
    await this.pub.set(
      `${this.prefix}user:${user_id}:presence`,
      JSON.stringify(presence),
      'EX',
      SESSION_TTL_SECONDS,
    );
  }

  async getPresence(user_id: string): Promise<unknown> {
    if (!this.enabled || !this.pub) return null;
    const raw = await this.pub.get(`${this.prefix}user:${user_id}:presence`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ------- Health check -------
  startHeartbeat(): void {
    if (!this.enabled || this.heartbeatTimer) return;
    const writeHeartbeat = async () => {
      if (!this.pub) return;
      try {
        await this.pub.set(
          `${this.prefix}shard:${shardManager.getSelfShardId()}:status`,
          JSON.stringify({ status: 'online', ts: Date.now() }),
          'EX',
          SHARD_STATUS_TTL,
        );
      } catch (e) {
        logText(`intershard: heartbeat failed: ${e}`, 'error');
      }
    };
    writeHeartbeat();
    this.heartbeatTimer = setInterval(writeHeartbeat, SHARD_HEARTBEAT_INTERVAL_MS);
  }

  async getShardStatus(shard_id: number): Promise<{ status: string; ts: number } | null> {
    if (!this.pub) return null;
    const raw = await this.pub.get(`${this.prefix}shard:${shard_id}:status`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async getAllShardsStatus(): Promise<Record<number, { status: string; ts: number } | null>> {
    const out: Record<number, { status: string; ts: number } | null> = {};
    for (const s of shardManager.getAllShards()) {
      out[s.id] = await this.getShardStatus(s.id);
    }
    return out;
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.enabled) {
      await this._publishControl({
        kind: 'shard_down',
        shard_id: shardManager.getSelfShardId(),
      });
    }
    if (this.pub) await this.pub.quit().catch(() => undefined);
    if (this.sub) await this.sub.quit().catch(() => undefined);
    this.pub = null;
    this.sub = null;
    this.enabled = false;
  }

  // ------- Internals -------
  private async _publishControl(msg: unknown): Promise<void> {
    if (!this.pub) return;
    try {
      await this.pub.publish(`${this.prefix}control`, JSON.stringify(msg));
    } catch (e) {
      logText(`intershard: control publish failed: ${e}`, 'error');
    }
  }

  private _dispatchIncoming(channel: string, payload: string): void {
    let parsed: IntershardMessage;
    try {
      parsed = JSON.parse(payload) as IntershardMessage;
    } catch (e) {
      logText(`intershard: invalid payload on ${channel}: ${e}`, 'error');
      return;
    }
    if (parsed.origin_shard === shardManager.getSelfShardId()) return; // no loops

    if (channel === `${this.prefix}control`) {
      const sid = Number(parsed.shard_id);
      if (parsed.kind === 'shard_up' && Number.isFinite(sid)) {
        shardManager.markShardUp(sid);
      } else if (parsed.kind === 'shard_down' && Number.isFinite(sid)) {
        shardManager.markShardDown(sid);
      }
      return;
    }

    if (channel.startsWith(`${this.prefix}guild:`)) {
      if (this.guildMessageHandler) {
        Promise.resolve(this.guildMessageHandler(parsed)).catch((e) =>
          logText(`intershard: guild handler error: ${e}`, 'error'),
        );
      }
      return;
    }

    if (channel === `${this.prefix}shard:${shardManager.getSelfShardId()}`) {
      if (this.messageHandler) {
        Promise.resolve(this.messageHandler(parsed)).catch((e) =>
          logText(`intershard: shard handler error: ${e}`, 'error'),
        );
      }
    }
  }
}

const intershard = new Intershard();
export default intershard;
