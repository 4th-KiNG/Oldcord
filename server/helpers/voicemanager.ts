import type { Redis } from 'ioredis';
import intershard from './intershard.ts';
import shardManager from './shardmanager.ts';
import { logText } from './utils/logger.ts';

export interface VoiceParticipant {
  user_id: string;
  ssrc: string;
  user: Record<string, unknown>;
}

export interface VoiceState {
  user_id: string;
  session_id: string;
  guild_id: string;
  channel_id: string | null;
  mute: boolean;
  deaf: boolean;
  self_deaf: boolean;
  self_mute: boolean;
  self_video: boolean;
  suppress: boolean;
}

interface RawGlobalRoom {
  room_id: string;
  participants: Array<{
    user: { id: string; [k: string]: unknown };
    ssrc: string;
  }>;
}

const VOICE_TTL_SECONDS = 24 * 60 * 60;

class VoiceManager {
  private get redis(): Redis | null {
    return ((intershard as unknown as { pub: Redis | null }).pub ?? null) as Redis | null;
  }

  private get prefix(): string {
    return ((intershard as unknown as { prefix: string }).prefix ?? 'oldcord:') as string;
  }

  private get useRedis(): boolean {
    return shardManager.isEnabled() && intershard.isEnabled() && !!this.redis;
  }

  private roomKey(guild_id: string, channel_id: string): string {
    return `${this.prefix}voice:room:${guild_id}:${channel_id}`;
  }

  private statesKey(guild_id: string): string {
    return `${this.prefix}voice:guild:${guild_id}:states`;
  }

  // ----- Legacy fallbacks (mutate global.rooms / global.guild_voice_states) -----

  private legacyEnsureRoom(guild_id: string, channel_id: string): RawGlobalRoom {
    const id = `${guild_id}:${channel_id}`;
    let room = (global.rooms as RawGlobalRoom[]).find((r) => r.room_id === id);
    if (!room) {
      room = { room_id: id, participants: [] };
      (global.rooms as RawGlobalRoom[]).push(room);
    }
    return room;
  }

  // ----- Public API -----

  async joinRoom(
    guild_id: string,
    channel_id: string,
    participant: VoiceParticipant,
    voiceState: VoiceState,
  ): Promise<void> {
    if (this.useRedis && this.redis) {
      const r = this.redis;
      await r.hset(
        this.roomKey(guild_id, channel_id),
        participant.user_id,
        JSON.stringify(participant),
      );
      await r.expire(this.roomKey(guild_id, channel_id), VOICE_TTL_SECONDS);
      await r.hset(this.statesKey(guild_id), voiceState.user_id, JSON.stringify(voiceState));
      await r.expire(this.statesKey(guild_id), VOICE_TTL_SECONDS);
      await intershard.publishToGuild(guild_id, {
        kind: 'voice_join',
        guild_id,
        channel_id,
        user_id: participant.user_id,
      });
      return;
    }

    // Legacy: in-memory.
    const room = this.legacyEnsureRoom(guild_id, channel_id);
    if (!room.participants.find((p) => p.user.id === participant.user_id)) {
      room.participants.push({
        user: { ...participant.user, id: participant.user_id },
        ssrc: participant.ssrc,
      });
    }
    if (!global.guild_voice_states.has(guild_id)) {
      global.guild_voice_states.set(guild_id, []);
    }
    const states = global.guild_voice_states.get(guild_id) as VoiceState[];
    if (!states.find((s) => s.user_id === voiceState.user_id)) {
      states.push(voiceState);
    }
  }

  async leaveRoom(
    guild_id: string,
    channel_id: string | null,
    user_id: string,
  ): Promise<VoiceState | null> {
    if (this.useRedis && this.redis) {
      const r = this.redis;
      const stateRaw = await r.hget(this.statesKey(guild_id), user_id);
      let state: VoiceState | null = null;
      if (stateRaw) {
        try {
          state = JSON.parse(stateRaw) as VoiceState;
        } catch {
          /* ignore */
        }
      }
      if (state?.channel_id) {
        await r.hdel(this.roomKey(guild_id, state.channel_id), user_id);
      }
      await r.hdel(this.statesKey(guild_id), user_id);
      await intershard.publishToGuild(guild_id, {
        kind: 'voice_leave',
        guild_id,
        channel_id: state?.channel_id ?? channel_id,
        user_id,
      });
      return state;
    }

    // Legacy
    const states = global.guild_voice_states.get(guild_id) as VoiceState[] | undefined;
    if (!states) return null;
    const idx = states.findIndex((s) => s.user_id === user_id);
    if (idx === -1) return null;
    const removed = states.splice(idx, 1)[0];
    global.guild_voice_states.set(guild_id, states);

    const targetChannel = removed.channel_id ?? channel_id;
    if (targetChannel) {
      const room = (global.rooms as RawGlobalRoom[]).find(
        (r) => r.room_id === `${guild_id}:${targetChannel}`,
      );
      if (room) {
        room.participants = room.participants.filter((p) => p.user.id !== user_id);
      }
    }
    return removed;
  }

  async getRoomParticipants(guild_id: string, channel_id: string): Promise<VoiceParticipant[]> {
    if (this.useRedis && this.redis) {
      const map = await this.redis.hgetall(this.roomKey(guild_id, channel_id));
      const out: VoiceParticipant[] = [];
      for (const v of Object.values(map)) {
        try {
          out.push(JSON.parse(v) as VoiceParticipant);
        } catch {
          /* skip */
        }
      }
      return out;
    }
    const room = (global.rooms as RawGlobalRoom[]).find(
      (r) => r.room_id === `${guild_id}:${channel_id}`,
    );
    if (!room) return [];
    return room.participants.map((p) => ({
      user_id: p.user.id,
      ssrc: p.ssrc,
      user: p.user,
    }));
  }

  async getGuildVoiceStates(guild_id: string): Promise<VoiceState[]> {
    if (this.useRedis && this.redis) {
      const map = await this.redis.hgetall(this.statesKey(guild_id));
      const out: VoiceState[] = [];
      for (const v of Object.values(map)) {
        try {
          out.push(JSON.parse(v) as VoiceState);
        } catch {
          /* skip */
        }
      }
      return out;
    }
    return ((global.guild_voice_states.get(guild_id) as VoiceState[]) ?? []).slice();
  }

  /**
   * Best-effort cleanup when a session terminates without an explicit
   * voice leave (network drop, kick, etc).
   */
  async cleanupSession(guild_id: string, user_id: string): Promise<VoiceState | null> {
    return await this.leaveRoom(guild_id, null, user_id);
  }
}

const voiceManager = new VoiceManager();
export default voiceManager;

export function _logVoiceDebug(msg: string): void {
  logText(`voicemanager: ${msg}`, 'rtc');
}
