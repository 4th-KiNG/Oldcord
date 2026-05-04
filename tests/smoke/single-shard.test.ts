/**
 * Smoke test: legacy single-shard mode must keep working without Redis.
 * Verifies that:
 *  - shardManager reports sharding disabled when num_shards = 1
 *  - dispatcher.dispatchEventTo invokes session.dispatch for local users
 *  - voiceManager mutates global.rooms / global.guild_voice_states like
 *    the original in-memory implementation
 */

import assert from 'node:assert/strict';
import { copyFileSync, existsSync } from 'node:fs';
import { before, describe, it } from 'node:test';

// globalUtils.js refuses to load without config.json — for smoke tests we
// auto-bootstrap a config from config.example.json. Never overwrites an
// existing user config.
if (!existsSync('config.json') && existsSync('config.example.json')) {
  copyFileSync('config.example.json', 'config.json');
}

// biome-ignore lint/suspicious/noExplicitAny: stub global.config for logger
(globalThis as any).config = { debug_logs: { gateway: false, dispatcher: false } };
(globalThis as any).userSessions = new Map();
(globalThis as any).sessions = new Map();
(globalThis as any).gatewayIntentMap = new Map();
(globalThis as any).rooms = [];
(globalThis as any).guild_voice_states = new Map();

const { default: shardManager } = await import('../../server/helpers/shardmanager.ts');
const { default: dispatcher } = await import('../../server/helpers/dispatcher.js');
const { default: voiceManager } = await import('../../server/helpers/voicemanager.ts');

describe('legacy single-shard smoke', () => {
  before(() => {
    shardManager.init({
      enabled: false,
      num_shards: 1,
      shard_id: 0,
      shards: [{ id: 0, host: '127.0.0.1', ws_port: 1337, http_port: 1337, secure: false }],
    });
  });

  it('shardManager reports not enabled', () => {
    assert.equal(shardManager.isEnabled(), false);
    assert.equal(shardManager.getSelfShardId(), 0);
  });

  it('dispatchEventTo calls session.dispatch for local user (no Redis)', async () => {
    const calls: Array<{ type: string; payload: unknown }> = [];
    const fakeSession = {
      dispatch(type: string, payload: unknown) {
        calls.push({ type, payload });
      },
    };
    global.userSessions.set('user-x', [fakeSession]);

    await dispatcher.dispatchEventTo('user-x', 'MESSAGE_CREATE', { id: '1', content: 'hi' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'MESSAGE_CREATE');
    assert.deepEqual(calls[0].payload, { id: '1', content: 'hi' });
  });

  it('voiceManager joinRoom mutates global.rooms in legacy mode', async () => {
    await voiceManager.joinRoom(
      'guild-1',
      'channel-1',
      { user_id: 'user-x', ssrc: 'ssrc-1', user: { id: 'user-x', username: 'X' } },
      {
        user_id: 'user-x',
        session_id: 'sess-1',
        guild_id: 'guild-1',
        channel_id: 'channel-1',
        mute: false,
        deaf: false,
        self_deaf: false,
        self_mute: false,
        self_video: false,
        suppress: false,
      },
    );

    const room = (global.rooms as Array<{ room_id: string; participants: unknown[] }>).find(
      (r) => r.room_id === 'guild-1:channel-1',
    );
    assert.ok(room, 'expected legacy room to be created');
    assert.equal(room?.participants.length, 1);

    const states = await voiceManager.getGuildVoiceStates('guild-1');
    assert.equal(states.length, 1);
    assert.equal(states[0].user_id, 'user-x');
  });

  it('voiceManager leaveRoom removes user from legacy state', async () => {
    const removed = await voiceManager.leaveRoom('guild-1', 'channel-1', 'user-x');
    assert.ok(removed);
    assert.equal(removed?.user_id, 'user-x');
    const states = await voiceManager.getGuildVoiceStates('guild-1');
    assert.equal(states.length, 0);
  });
});
