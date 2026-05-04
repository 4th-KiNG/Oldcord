import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// biome-ignore lint/suspicious/noExplicitAny: globalThis.config setup for test
(globalThis as any).config = { debug_logs: { gateway: false } };

const { default: shardManager } = await import('../../server/helpers/shardmanager.ts');
const { default: intershard } = await import('../../server/helpers/intershard.ts');

const RedisMock = (await import('ioredis-mock')).default;

describe('Intershard with ioredis-mock', () => {
  before(async () => {
    shardManager.init({
      enabled: true,
      num_shards: 2,
      shard_id: 0,
      shards: [
        { id: 0, host: '127.0.0.1', ws_port: 1337, http_port: 1337, secure: false },
        { id: 1, host: '127.0.0.1', ws_port: 1338, http_port: 1338, secure: false },
      ],
    });

    const mockClient = new RedisMock();
    // biome-ignore lint/suspicious/noExplicitAny: ioredis-mock has compatible runtime API
    intershard._setTestClient(mockClient as any);
    await intershard.init({ url: 'redis://mock', key_prefix: 'oldcord:' });
  });

  after(async () => {
    await intershard.shutdown();
  });

  it('reports enabled', () => {
    assert.equal(intershard.isEnabled(), true);
  });

  it('session index round-trip', async () => {
    await intershard.setSessionIndex('sess1', {
      shard_id: 0,
      user_id: 'user1',
      seq: 5,
      last_seen: 123,
    });
    const got = await intershard.getSessionIndex('sess1');
    assert.deepEqual(got, { shard_id: 0, user_id: 'user1', seq: 5, last_seen: 123 });

    await intershard.removeSessionIndex('sess1');
    const after = await intershard.getSessionIndex('sess1');
    assert.equal(after, null);
  });

  it('user shard round-trip', async () => {
    await intershard.setUserShard('userX', 1);
    const v = await intershard.getUserShard('userX');
    assert.equal(v, 1);
  });

  it('presence round-trip', async () => {
    const p = { status: 'online', game_id: null };
    await intershard.setPresence('userY', p);
    const got = await intershard.getPresence('userY');
    assert.deepEqual(got, p);
  });

  it('publishToShard does not loop back to self', async () => {
    let received = false;
    intershard.onShardMessage(() => {
      received = true;
    });
    await intershard.publishToShard(0, {
      kind: 'dispatch_to_user',
      user_id: 'u',
      type: 'X',
      payload: {},
    });
    // wait briefly
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received, false);
  });

  it('shard heartbeat populates shard:<id>:status', async () => {
    intershard.startHeartbeat();
    await new Promise((r) => setTimeout(r, 50));
    const s = await intershard.getShardStatus(0);
    assert.ok(s);
    assert.equal(s?.status, 'online');
  });
});
