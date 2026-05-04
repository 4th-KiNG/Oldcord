import intershard from './intershard.ts';
import { handleMembersSync } from './lazyRequest.js';
import shardManager from './shardmanager.ts';
import { logText } from './utils/logger.ts';

// ----- Local-only helpers (operate on global.userSessions) -----

function _localDispatchToUser(user_id, type, payload) {
  const sessions = global.userSessions.get(user_id);
  if (!sessions || sessions.length === 0) return false;
  for (let z = 0; z < sessions.length; z++) {
    sessions[z].dispatch(type, payload);
  }
  return true;
}

function _isLegacyClient(socket) {
  if (!socket || !socket.client_build_date) return false;
  const y = socket.client_build_date.getFullYear();
  const m = socket.client_build_date.getMonth();
  const d = socket.client_build_date.getDate();
  return y === 2015 || (y === 2016 && m < 8) || (y === 2016 && m === 8 && d < 26);
}

function _legacyAdjustPresence(payload, socket) {
  const finalPayload = { ...payload };
  if (_isLegacyClient(socket) && payload?.status) {
    const cur = payload.status.toLowerCase();
    if (['offline', 'invisible'].includes(cur)) {
      finalPayload.status = 'offline';
    } else if (cur === 'dnd') {
      finalPayload.status = 'online';
    }
  }
  return finalPayload;
}

function _localDispatchToUserWithLegacyAdjust(user_id, type, payload) {
  const sessions = global.userSessions.get(user_id);
  if (!sessions || sessions.length === 0) return false;
  for (let z = 0; z < sessions.length; z++) {
    const session = sessions[z];
    let finalPayload = payload;
    if (type === 'PRESENCE_UPDATE' && payload && typeof payload === 'object') {
      finalPayload = _legacyAdjustPresence(payload, session.socket);
    }
    session.dispatch(type, finalPayload);
  }
  return true;
}

// Group user IDs by target shard, excluding self.
function _groupRemoteUsersByShard(user_ids) {
  if (!shardManager.isEnabled()) return new Map();
  const selfId = shardManager.getSelfShardId();
  const out = new Map();
  for (const uid of user_ids) {
    const target = shardManager.getShardForUser(uid);
    if (target === selfId) continue;
    if (!out.has(target)) out.set(target, []);
    out.get(target).push(uid);
  }
  return out;
}

async function _publishBulkToShards(grouped, type, payload, opts) {
  if (grouped.size === 0) return;
  const promises = [];
  for (const [shardId, userIds] of grouped) {
    promises.push(
      intershard.publishToShard(shardId, {
        kind: 'dispatch_bulk',
        user_ids: userIds,
        type,
        payload,
        opts: opts || null,
      }),
    );
  }
  await Promise.all(promises);
}

// ----- Public dispatcher API -----

const dispatcher = {
  dispatchEventTo: async (user_id, type, payload) => {
    const localSent = _localDispatchToUser(user_id, type, payload);

    if (shardManager.isEnabled() && !shardManager.isLocal(user_id)) {
      await intershard.publishToShard(shardManager.getShardForUser(user_id), {
        kind: 'dispatch_to_user',
        user_id,
        type,
        payload,
      });
      return true;
    }
    return localSent;
  },

  dispatchLogoutTo: async (user_id) => {
    const sessions = global.userSessions.get(user_id);
    if (sessions && sessions.length > 0) {
      for (let z = 0; z < sessions.length; z++) {
        sessions[z].socket?.close(4004, 'Authentication failed');
        sessions[z].onClose(4004);
      }
    }
    if (shardManager.isEnabled() && !shardManager.isLocal(user_id)) {
      await intershard.publishToShard(shardManager.getShardForUser(user_id), {
        kind: 'force_disconnect',
        user_id,
        code: 4004,
        reason: 'Authentication failed',
      });
    }
  },

  dispatchEventToEveryoneWhatAreYouDoingWhyWouldYouDoThis: async (type, payload) => {
    global.userSessions.forEach((sessions) => {
      for (let z = 0; z < sessions.length; z++) {
        sessions[z].dispatch(type, payload);
      }
    });
    if (shardManager.isEnabled()) {
      // broadcast to every other shard via control? Use per-shard publish.
      const promises = [];
      for (const s of shardManager.getAllShards()) {
        if (s.id === shardManager.getSelfShardId()) continue;
        promises.push(
          intershard.publishToShard(s.id, {
            kind: 'dispatch_to_all_local',
            type,
            payload,
          }),
        );
      }
      await Promise.all(promises);
    }
  },

  dispatchGuildMemberUpdateToAllTheirGuilds: async (user_id, new_user) => {
    const sessions = global.userSessions.get(user_id);
    if (sessions && sessions.length > 0) {
      for (let z = 0; z < sessions.length; z++) {
        sessions[z].user = new_user;
        sessions[z].dispatchSelfUpdate();
      }
    }
    if (shardManager.isEnabled() && !shardManager.isLocal(user_id)) {
      await intershard.publishToShard(shardManager.getShardForUser(user_id), {
        kind: 'self_user_update',
        user_id,
        new_user,
      });
    }
  },

  dispatchEventToAllPerms: async (guild_id, channel_id, permission_check, type, payload) => {
    const guild = await global.database.getGuildById(guild_id);
    if (guild == null) return false;

    let channel;
    if (channel_id) {
      channel = guild.channels.find((x) => x.id === channel_id);
      if (!channel) return false;
    }

    const members = guild.members;
    if (!members || members.length === 0) return false;

    const remoteUserIds = [];
    const selfId = shardManager.getSelfShardId();
    const sharded = shardManager.isEnabled();

    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      if (sharded && shardManager.getShardForUser(member.id) !== selfId) {
        remoteUserIds.push(member.id);
        continue;
      }

      const uSessions = global.userSessions.get(member.id);
      if (!uSessions) continue;

      for (let z = 0; z < uSessions.length; z++) {
        const uSession = uSessions[z];
        if (guild.owner_id !== member.id && uSession?.socket) {
          const guildPermCheck = global.permissions.hasGuildPermissionTo(
            guild,
            member.id,
            permission_check,
            uSession.socket.client_build,
          );
          if (!guildPermCheck) break;
          if (channel) {
            const channelPermCheck = global.permissions.hasChannelPermissionTo(
              channel,
              guild,
              member.id,
              permission_check,
            );
            if (!channelPermCheck) break;
          }
        }
        uSession.dispatch(type, payload);
      }
    }

    if (sharded && remoteUserIds.length > 0) {
      const grouped = _groupRemoteUsersByShard(remoteUserIds);
      await _publishBulkToShards(grouped, type, payload, {
        permission_check,
        guild_id,
        channel_id,
      });
    }

    logText(`(Event to all perms) -> ${type}`, 'dispatcher');
    return true;
  },

  dispatchEventInGuildToThoseSubscribedTo: async (
    guild,
    type,
    payload,
    ignorePayload = false,
    typeOverride = null,
  ) => {
    if (!guild?.id) return;

    const activeSessions = Array.from(global.userSessions.values()).flat();
    const updatePromises = activeSessions.map(async (session) => {
      const guildInSession = session.guilds?.find((g) => g.id === guild.id);
      if (!guildInSession) return;

      const socket = session.socket;
      let finalPayload = payload;
      let finalType = typeOverride || type;

      if (typeof payload === 'function') {
        try {
          finalPayload = await payload.call(session);
          if (!finalPayload) return;
          if (finalPayload.ops) finalType = 'GUILD_MEMBER_LIST_UPDATE';
        } catch (err) {
          logText(`Error executing dynamic payload: ${err}`, 'error');
          return;
        }
      } else if (type === 'PRESENCE_UPDATE' && payload && payload.user) {
        finalPayload = { ...payload };
        const member = guild.members.find((m) => m.user.id === finalPayload.user.id);
        if (member) {
          finalPayload.nick = member.nick;
          finalPayload.roles = member.roles;
        }
        finalPayload = _legacyAdjustPresence(finalPayload, socket);
      }

      const sub = session.subscriptions?.[guild.id];
      if (sub) {
        const channel = guild.channels.find((x) => x.id === sub.channel_id);
        if (channel) await handleMembersSync(session, channel, guild, sub);
      }

      if (!ignorePayload) session.dispatch(finalType, finalPayload);
    });

    await Promise.all(updatePromises);

    // For non-function payloads, fan out the same payload to remote shards
    // that have members of this guild. We don't try to evaluate `payload`
    // remotely if it's a function — guild subscription updates are
    // best-effort cross-shard.
    if (shardManager.isEnabled() && typeof payload !== 'function') {
      const remoteIds = [];
      const selfId = shardManager.getSelfShardId();
      for (const member of guild.members) {
        if (shardManager.getShardForUser(member.id) !== selfId) {
          remoteIds.push(member.id);
        }
      }
      const grouped = _groupRemoteUsersByShard(remoteIds);
      await _publishBulkToShards(grouped, typeOverride || type, payload, {
        source: 'guild_subscribed',
        guild_id: guild.id,
        ignorePayload,
      });
    }

    logText(`(Subscription event in ${guild.id}) -> ${type}`, 'dispatcher');
    return true;
  },

  getSessionsInGuild: (guild) => {
    const sessions = [];
    if (!guild || !guild.members) return [];
    for (let i = 0; i < guild.members.length; i++) {
      const member = guild.members[i];
      if (!member) continue;
      const uSessions = global.userSessions.get(member.id);
      if (!uSessions || uSessions.length === 0) continue;
      sessions.push(...uSessions);
    }
    return sessions;
  },

  getAllActiveSessions: () => {
    const usessions = [];
    global.userSessions.forEach((sessions) => {
      for (let z = 0; z < sessions.length; z++) {
        if (sessions[z].dead || sessions[z].terminated) continue;
        usessions.push(sessions[z]);
      }
    });
    return usessions;
  },

  dispatchEventInGuild: async (guild, type, payload) => {
    if (!guild || !guild.members) return;

    const sharded = shardManager.isEnabled();
    const selfId = shardManager.getSelfShardId();
    const remoteUserIds = [];

    for (let i = 0; i < guild.members.length; i++) {
      const member = guild.members[i];
      if (!member) continue;
      const uid = member.user?.id ?? member.id;
      if (sharded && shardManager.getShardForUser(uid) !== selfId) {
        remoteUserIds.push(uid);
        continue;
      }

      const uSessions = global.userSessions.get(uid);
      if (!uSessions || uSessions.length === 0) continue;

      for (let z = 0; z < uSessions.length; z++) {
        const session = uSessions[z];
        const finalPayload =
          typeof payload === 'function'
            ? payload
            : type === 'PRESENCE_UPDATE'
              ? _legacyAdjustPresence(payload, session.socket)
              : { ...payload };
        session.dispatch(type, finalPayload);
      }
    }

    if (sharded && remoteUserIds.length > 0 && typeof payload !== 'function') {
      const grouped = _groupRemoteUsersByShard(remoteUserIds);
      await _publishBulkToShards(grouped, type, payload, { source: 'guild' });
    }

    logText(`(Event in guild) -> ${type}`, 'dispatcher');
    return true;
  },

  dispatchEventInPrivateChannel: async (channel, type, payload) => {
    if (channel === null || !channel.recipients) return false;

    const sharded = shardManager.isEnabled();
    const selfId = shardManager.getSelfShardId();
    const remoteUserIds = [];

    for (let i = 0; i < channel.recipients.length; i++) {
      const recipient = channel.recipients[i].id;
      if (sharded && shardManager.getShardForUser(recipient) !== selfId) {
        remoteUserIds.push(recipient);
        continue;
      }
      _localDispatchToUser(recipient, type, payload);
    }

    if (sharded && remoteUserIds.length > 0) {
      const grouped = _groupRemoteUsersByShard(remoteUserIds);
      await _publishBulkToShards(grouped, type, payload, { source: 'dm' });
    }

    logText(`(Event in group/dm channel) -> ${type}`, 'dispatcher');
    return true;
  },

  dispatchEventInChannel: async (guild, channel_id, type, payload) => {
    if (guild === null) return false;
    const channel = guild.channels.find((x) => x.id === channel_id);
    if (channel == null) return false;

    const sharded = shardManager.isEnabled();
    const selfId = shardManager.getSelfShardId();
    const remoteUserIds = [];

    for (let i = 0; i < guild.members.length; i++) {
      const member = guild.members[i];
      if (!member) continue;

      const permissions = global.permissions.hasChannelPermissionTo(
        channel,
        guild,
        member.id,
        'READ_MESSAGES',
      );
      if (!permissions) continue;

      if (sharded && shardManager.getShardForUser(member.id) !== selfId) {
        remoteUserIds.push(member.id);
        continue;
      }

      const uSessions = global.userSessions.get(member.id);
      if (!uSessions || uSessions.length === 0) continue;
      for (let z = 0; z < uSessions.length; z++) {
        uSessions[z].dispatch(type, payload);
      }
    }

    if (sharded && remoteUserIds.length > 0) {
      const grouped = _groupRemoteUsersByShard(remoteUserIds);
      await _publishBulkToShards(grouped, type, payload, {
        source: 'channel',
        guild_id: guild.id,
        channel_id,
      });
    }

    logText(`(Event in channel) -> ${type}`, 'dispatcher');
    return true;
  },

  // Called by intershard when a message arrives on this shard's channel.
  _handleIntershardMessage: async (msg) => {
    try {
      switch (msg.kind) {
        case 'dispatch_to_user':
          _localDispatchToUserWithLegacyAdjust(msg.user_id, msg.type, msg.payload);
          break;
        case 'dispatch_bulk': {
          const seen = new Set();
          for (const uid of msg.user_ids || []) {
            if (seen.has(uid)) continue;
            seen.add(uid);
            _localDispatchToUserWithLegacyAdjust(uid, msg.type, msg.payload);
          }
          break;
        }
        case 'dispatch_to_all_local': {
          global.userSessions.forEach((sessions) => {
            for (let z = 0; z < sessions.length; z++) {
              sessions[z].dispatch(msg.type, msg.payload);
            }
          });
          break;
        }
        case 'force_disconnect': {
          const sessions = global.userSessions.get(msg.user_id);
          if (sessions) {
            for (const s of sessions) {
              s.socket?.close(msg.code ?? 4000, msg.reason ?? 'forced');
              s.onClose?.(msg.code ?? 4000);
            }
          }
          break;
        }
        case 'self_user_update': {
          const sessions = global.userSessions.get(msg.user_id);
          if (sessions) {
            for (const s of sessions) {
              s.user = msg.new_user;
              s.dispatchSelfUpdate?.();
            }
          }
          break;
        }
        default:
          // Unknown message kind — likely a future extension; ignore.
          break;
      }
    } catch (e) {
      logText(`dispatcher: intershard handler error: ${e}`, 'error');
    }
  },
};

export const {
  dispatchEventTo,
  dispatchLogoutTo,
  dispatchEventToEveryoneWhatAreYouDoingWhyWouldYouDoThis,
  dispatchGuildMemberUpdateToAllTheirGuilds,
  dispatchEventToAllPerms,
  dispatchEventInGuildToThoseSubscribedTo,
  getSessionsInGuild,
  getAllActiveSessions,
  dispatchEventInGuild,
  dispatchEventInPrivateChannel,
  dispatchEventInChannel,
  _handleIntershardMessage,
} = dispatcher;

export default dispatcher;
