import dispatcher from '../helpers/dispatcher.js';
import intershard from '../helpers/intershard.ts';
import lazyRequest from '../helpers/lazyRequest.js';
import session from '../helpers/session.js';
import shardManager from '../helpers/shardmanager.ts';
import globalUtils from '../helpers/utils/globalutils.js';
import voiceManager from '../helpers/voicemanager.ts';
import '../sharding-init.ts';

const OPCODES = {
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE: 3,
  VOICESTATE: 4,
  RESUME: 6,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HEARTBEAT_INFO: 10,
  HEARTBEAT_ACK: 11,
  LAZYFETCH: 12,
  MEMBERCHUNKS: 14,
};

async function handleIdentify(socket, packet) {
  if (socket.identified || socket.session) {
    return socket.close(4005, 'You have already identified.');
  }

  global.gateway.debug('New client connection');

  socket.identified = true;

  const user = await global.database.getAccountByToken(packet.d.token);

  if (user == null || user.disabled_until) {
    return socket.close(4004, 'Authentication failed');
  }

  // Sharding affinity: when a user lands on a shard that does not match
  // their hash, we used to close with 4014 and force a /gateway re-fetch.
  // Legacy Discord clients (2015-17) cannot interpret custom close codes
  // and would loop forever. Instead we accept the connection on whichever
  // shard the client reached — the next `/gateway` REST call (made after
  // login, when Authorization is present) routes them to the hashed shard
  // for any future reconnects. Cross-shard dispatch keeps events flowing
  // either way. Set sharding.strict_affinity=true in config to re-enable
  // the 4014 redirect for clients that support it.
  if (
    shardManager.isEnabled() &&
    global.config?.sharding?.strict_affinity === true &&
    !shardManager.isLocal(user.id)
  ) {
    return socket.close(4014, 'Wrong shard, please re-fetch /gateway');
  }

  const providedIntents = packet.d.intents;

  global.gatewayIntentMap.delete(user.id);

  if (providedIntents !== undefined && providedIntents !== null) {
    global.gatewayIntentMap.set(user.id, Number(providedIntents));
  }

  let savedStatus = 'online';

  if (user.bot) {
    user.settings = {
      status: 'online',
    };
  } else {
    savedStatus = user.settings?.status || 'online';
  }

  socket.user = user;

  const sesh = new session(
    globalUtils.generateString(16),
    socket,
    user,
    packet.d.token,
    false,
    {
      game_id: null,
      status: savedStatus,
      activities: [],
      user: globalUtils.miniUserObject(socket.user),
      roles: [],
    },
    undefined,
    undefined,
    undefined,
    socket.apiVersion,
    packet.d.capabilities ?? socket.client_build_date,
  );

  socket.session = sesh;
  socket.session.start();

  if (intershard.isEnabled()) {
    await intershard.setSessionIndex(sesh.id, {
      shard_id: shardManager.getSelfShardId(),
      user_id: user.id,
      seq: 0,
      last_seen: Date.now(),
    });
    await intershard.setUserShard(user.id, shardManager.getSelfShardId());
  }

  await socket.session.prepareReady();

  if (intershard.isEnabled() && Array.isArray(socket.session.guilds)) {
    for (const g of socket.session.guilds) {
      if (g?.id) await intershard.subscribeGuild(String(g.id));
    }
  }

  const pastPresence = packet.d.presence;
  let finalStatus = savedStatus;

  if (pastPresence && pastPresence.status && pastPresence.status === savedStatus) {
    finalStatus = pastPresence.status;
  } //Only listening if the users settings status is the same as the identify payload - as thats what discord did

  await socket.session.updatePresence(finalStatus, null, false, true);
}

async function handleHeartbeat(socket, packet) {
  if (!socket.hb) return;

  socket.hb.reset();
  socket.hb.acknowledge(packet.d);
}

async function handlePresence(socket, packet) {
  if (!socket.session) return socket.close(4003, 'Not authenticated');

  await global.gateway.syncPresence(socket, packet);
}

async function handleVoiceState(socket, packet) {
  if (!socket.session) return socket.close(4003, 'Not authenticated');

  const guild_id = packet.d.guild_id;
  const channel_id = packet.d.channel_id;
  const self_mute = packet.d.self_mute;
  const self_deaf = packet.d.self_deaf;

  if (guild_id === null && channel_id === null) {
    if (socket.current_guild?.id && socket.user?.id) {
      await voiceManager.leaveRoom(String(socket.current_guild.id), null, String(socket.user.id));

      await dispatcher.dispatchEventInGuild(socket.current_guild, 'VOICE_STATE_UPDATE', {
        channel_id: channel_id,
        guild_id: socket.current_guild.id, //must be guild id even if they left the vc and they dont send any guild id
        user_id: socket.user.id,
        session_id: socket.session.id,
        deaf: false,
        mute: false,
        self_deaf: self_deaf,
        self_mute: self_mute,
        self_video: false,
        suppress: false,
      });

      socket.current_guild = null;
      socket.inCall = false;
      return;
    }
  }

  socket.session.guild_id = guild_id ?? 0;
  socket.session.channel_id = channel_id ?? 0;
  socket.session.self_muted = self_mute;
  socket.session.self_deafened = self_deaf;

  if (!socket.current_guild) {
    socket.current_guild = await global.database.getGuildById(guild_id);
  }

  if (socket.session.channel_id !== 0 && socket.current_guild) {
    const channel = socket.current_guild.channels.find((x) => x.id === channel_id);

    if (!channel || channel.type !== 2) {
      return;
    }

    if (channel?.type === 2 && channel.user_limit > 0) {
      const participants = await voiceManager.getRoomParticipants(
        String(guild_id),
        String(channel_id),
      );
      const permissionCheck = global.permissions.hasChannelPermissionTo(
        channel,
        socket.current_guild,
        socket.user.id,
        'MOVE_MEMBERS',
      );

      if (participants.length >= channel.user_limit && !permissionCheck) {
        return;
      } //to-do: work on moving members into the channel
    }
  }

  await dispatcher.dispatchEventInGuild(socket.current_guild, 'VOICE_STATE_UPDATE', {
    channel_id: channel_id,
    guild_id: guild_id,
    user_id: socket.user.id,
    session_id: socket.session.id,
    deaf: false,
    mute: false,
    self_deaf: self_deaf,
    self_mute: self_mute,
    self_video: false,
    suppress: false,
  });

  await voiceManager.joinRoom(
    String(guild_id),
    String(channel_id),
    {
      user_id: String(socket.user.id),
      ssrc: globalUtils.generateString(30),
      user: globalUtils.miniUserObject(socket.user),
    },
    {
      user_id: String(socket.user.id),
      session_id: socket.session.id,
      guild_id: String(guild_id),
      channel_id: String(channel_id),
      mute: false,
      deaf: false,
      self_deaf: self_deaf,
      self_mute: self_mute,
      self_video: false,
      suppress: false,
    },
  );

  if (!socket.inCall && socket.current_guild != null) {
    socket.session.dispatch('VOICE_SERVER_UPDATE', {
      token: globalUtils.generateString(30),
      guild_id: guild_id,
      channel_id: channel_id,
      endpoint: globalUtils.generateRTCServerURL(),
    });
    socket.inCall = true;
  }
}

async function handleOp12GetGuildMembersAndPresences(socket, packet) {
  if (!socket.session) return;

  const guild_ids = packet.d;

  if (guild_ids.length === 0) return;

  const usersGuilds = socket.session.guilds;

  if (usersGuilds.length === 0) return;

  for (var guild of guild_ids) {
    const guildObj = usersGuilds.find((x) => x.id === guild);

    if (!guildObj) continue;

    const op12 = await global.database.op12getGuildMembersAndPresences(guildObj);

    if (op12 == null) continue;

    socket.session.dispatch('GUILD_SYNC', {
      id: guildObj.id,
      presences: op12.presences,
      members: op12.members,
    });
  }
}

async function handleOp8GuildMemberChunks(socket, packet) {
  if (!socket.session) return;

  const rawGuildId = packet.d.guild_id;
  const guild_id = Array.isArray(rawGuildId) ? rawGuildId[0] : rawGuildId;
  const usernameQuery = packet.d.query;
  const userLimit = packet.d.limit;
  const presences = packet.d.presences;
  const usersGuilds = socket.session.guilds;

  if (!usersGuilds || !usersGuilds.some((x) => x.id === guild_id)) return;

  const op8 = await global.database.op8getGuildMemberChunks(
    guild_id,
    usernameQuery,
    userLimit,
    presences,
  );
  const filteredPresences = op8.presences.map((presence) => ({
    user: { id: presence.user.id },
    status: presence.status,
    activities: presence.activities || [],
    game: presence.game || null,
  }));

  socket.session.dispatch('GUILD_MEMBERS_CHUNK', {
    guild_id: guild_id,
    members: op8.members,
    chunk_index: op8.chunk_index,
    chunk_count: op8.chunk_count,
    presences: filteredPresences,
  });
}

async function handleOp14GetGuildMemberChunks(socket, packet) {
  //This new rewritten code was mainly inspired by spacebar if you couldn't tell since their OP 14 is more stable than ours at the moment.
  //TO-DO: add support for shit like INSERT and whatnot (hell)

  await lazyRequest.fire(socket, packet);
}

async function handleResume(socket, packet) {
  const token = packet.d.token;
  const session_id = packet.d.session_id;

  if (!token || !session_id) return socket.close(4000, 'Invalid payload');

  if (socket.session || socket.resumed) return socket.close(4005, 'Cannot resume at this time');

  socket.resumed = true;

  const user2 = await global.database.getAccountByToken(token);

  if (!user2) {
    return socket.close(4004, 'Authentication failed');
  }

  socket.user = user2;

  const session2 = global.sessions.get(session_id);

  // Cross-shard resume: when the original shard is alive and a strict
  // client is connected, redirect via 4014. Legacy clients (which cannot
  // interpret 4014) get accepted locally as a fresh session starting from
  // the persisted seq — events buffered on the original shard are lost
  // for that resume, but the session continues on this shard.
  if (!session2 && intershard.isEnabled()) {
    const idx = await intershard.getSessionIndex(session_id);
    if (idx && idx.shard_id !== shardManager.getSelfShardId()) {
      const status = await intershard.getShardStatus(idx.shard_id);
      const strict = global.config?.sharding?.strict_affinity === true;
      if (status && status.status === 'online' && strict) {
        return socket.close(4014, 'Resume on different shard; please re-fetch /gateway');
      }
      // Otherwise accept the resume locally.
    }
  }

  if (!session2) {
    const sesh = new session(
      globalUtils.generateString(16),
      socket,
      socket.user,
      packet.d.token,
      false,
      {
        game_id: null,
        status: socket.user?.settings?.status ?? 'online',
        activities: [],
        user: globalUtils.miniUserObject(socket.user),
        roles: [],
      },
      undefined,
      undefined,
      undefined,
      socket.apiVersion,
      packet.d.capabilities ?? socket.client_build_date,
    );

    sesh.seq = packet.d.seq;
    sesh.eventsBuffer = [];
    sesh.start();

    socket.session = sesh;
  }

  let sesh = null;

  if (!session2) {
    sesh = socket.session;
  } else sesh = session2;

  if (sesh.user.id !== socket.user.id) {
    return socket.close(4004, 'Authentication failed');
  }

  if (sesh.seq < packet.d.seq) {
    return socket.close(4007, 'Invalid seq');
  }

  if (sesh.eventsBuffer.find((x) => x.seq === packet.d.seq)) {
    socket.session = sesh;

    if (intershard.isEnabled()) {
      await intershard.setSessionIndex(sesh.id, {
        shard_id: shardManager.getSelfShardId(),
        user_id: socket.user.id,
        seq: sesh.seq,
        last_seen: Date.now(),
      });
      await intershard.setUserShard(socket.user.id, shardManager.getSelfShardId());
    }

    return await socket.session.resume(sesh.seq, socket);
  } else {
    sesh.send({
      op: OPCODES.INVALID_SESSION,
      d: false,
    });
  }
}

const gatewayHandlers = {
  [OPCODES.IDENTIFY]: handleIdentify,
  [OPCODES.HEARTBEAT]: handleHeartbeat,
  [OPCODES.PRESENCE]: handlePresence,
  [OPCODES.VOICESTATE]: handleVoiceState,
  [OPCODES.LAZYFETCH]: handleOp12GetGuildMembersAndPresences,
  [OPCODES.REQUEST_GUILD_MEMBERS]: handleOp8GuildMemberChunks,
  [OPCODES.MEMBERCHUNKS]: handleOp14GetGuildMemberChunks,
  [OPCODES.RESUME]: handleResume,
};

export { gatewayHandlers, OPCODES };
