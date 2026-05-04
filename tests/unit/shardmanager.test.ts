import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// Stub global.config so logger doesn't throw on import.
(globalThis as any).config = { debug_logs: { gateway: false } };

const { default: shardManager, computeShardForUser } = await import(
  '../../server/helpers/shardmanager.ts'
);

describe('computeShardForUser', () => {
  it('returns 0 when num_shards is 1', () => {
    assert.equal(computeShardForUser('123456789012345678', 1), 0);
  });

  it('is deterministic: same id -> same shard', () => {
    const id = '123456789012345678';
    const a = computeShardForUser(id, 4);
    const b = computeShardForUser(id, 4);
    assert.equal(a, b);
  });

  it('matches the spec formula (BigInt(id) >> 22n) % N', () => {
    const id = '123456789012345678';
    const expected = Number((BigInt(id) >> 22n) % 4n);
    assert.equal(computeShardForUser(id, 4), expected);
  });

  it('handles numeric input', () => {
    const id = 123456789012345678n;
    const expected = Number((id >> 22n) % 7n);
    assert.equal(computeShardForUser(id.toString(), 7), expected);
  });

  it('falls back to 0 for invalid ids', () => {
    assert.equal(computeShardForUser('not-a-number', 4), 0);
    assert.equal(computeShardForUser(undefined as any, 4), 0);
    assert.equal(computeShardForUser(null as any, 4), 0);
  });

  it('distributes 1000 snowflakes across 4 shards within ±20% of mean', () => {
    const counts = [0, 0, 0, 0];
    const baseTimestamp = 1_400_000_000_000n;
    for (let i = 0; i < 1000; i++) {
      const ts = baseTimestamp + BigInt(i);
      const id = (ts << 22n) | BigInt(i & 0x3fffff);
      const shard = computeShardForUser(id.toString(), 4);
      counts[shard]++;
    }
    const mean = 1000 / 4;
    for (const c of counts) {
      const deviation = Math.abs(c - mean) / mean;
      assert.ok(deviation < 0.2, `deviation ${deviation} exceeds 0.2`);
    }
  });
});

describe('ShardManager singleton', () => {
  beforeEach(() => {
    shardManager.init({
      enabled: true,
      num_shards: 4,
      shard_id: 1,
      shards: [
        { id: 0, host: 'h0', ws_port: 1000, http_port: 1000, secure: false },
        { id: 1, host: 'h1', ws_port: 1001, http_port: 1001, secure: false },
        { id: 2, host: 'h2', ws_port: 1002, http_port: 1002, secure: false },
        { id: 3, host: 'h3', ws_port: 1003, http_port: 1003, secure: true },
      ],
    });
  });

  it('isEnabled returns true when num_shards > 1', () => {
    assert.equal(shardManager.isEnabled(), true);
    assert.equal(shardManager.getNumShards(), 4);
    assert.equal(shardManager.getSelfShardId(), 1);
  });

  it('legacy mode (num_shards=1) reports not enabled', () => {
    shardManager.init({
      enabled: true,
      num_shards: 1,
      shard_id: 0,
      shards: [{ id: 0, host: 'h', ws_port: 1, http_port: 1, secure: false }],
    });
    assert.equal(shardManager.isEnabled(), false);
  });

  it('isLocal works for self shard', () => {
    let target = '';
    for (let i = 0; i < 10000; i++) {
      const id = ((1_400_000_000_000n + BigInt(i)) << 22n).toString();
      if (computeShardForUser(id, 4) === 1) {
        target = id;
        break;
      }
    }
    assert.notEqual(target, '');
    assert.equal(shardManager.isLocal(target), true);
  });

  it('getShardAddress returns proper URLs', () => {
    assert.deepEqual(shardManager.getShardAddress(0), {
      ws: 'ws://h0:1000',
      http: 'http://h0:1000',
    });
    assert.deepEqual(shardManager.getShardAddress(3), {
      ws: 'wss://h3:1003',
      http: 'https://h3:1003',
    });
    assert.equal(shardManager.getShardAddress(99), null);
  });

  it('markShardDown then getShardForUser falls back to next healthy', () => {
    let target = '';
    for (let i = 0; i < 10000; i++) {
      const id = ((1_400_000_000_000n + BigInt(i)) << 22n).toString();
      if (computeShardForUser(id, 4) === 0) {
        target = id;
        break;
      }
    }
    assert.equal(shardManager.getShardForUser(target), 0);
    shardManager.markShardDown(0);
    assert.equal(shardManager.getShardForUser(target), 1);
    assert.ok(!shardManager.getHealthyShards().includes(0));
  });
});
