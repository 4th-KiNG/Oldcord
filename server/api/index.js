import express from 'express';

import { authMiddleware, instanceMiddleware } from '../helpers/middlewares.js';

const app = express();

import intershard from '../helpers/intershard.ts';
import shardManager from '../helpers/shardmanager.ts';
import {
  config,
  generateGatewayURL,
  generateShardedGatewayURL,
} from '../helpers/utils/globalutils.js';
import activities from './activities.ts';
import admin from './admin.js';
import auth from './auth.js';
import channels from './channels.js';
import connections from './connections.js';
import entitlements from './entitlements.js';
import gifs from './gifs.js';
import guilds from './guilds.js';
import integrations from './integrations.js';
import invites from './invites.js';
import oauth2 from './oauth2/index.js';
import report from './report.ts';
import reports from './reports.js';
import spacebarPing from './spacebar-compat/ping.ts';
import spacebarPolicies from './spacebar-compat/policies.ts';
import store from './store.js';
import tutorial from './tutorial.js';
import users from './users/index.js';
import voice from './voice.ts';
import webhooks from './webhooks.js';

global.config = config;
//just in case

app.use('/auth', auth);
app.use('/connections', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), connections);

app.get('/incidents/unresolved.json', (req, res) => {
  return res.status(200).json({
    scheduled_maintenances: [],
    incidents: [],
  });
});

app.get('/scheduled-maintenances/upcoming.json', (req, res) => {
  return res.status(200).json({
    scheduled_maintenances: [],
  });
});

app.get('/scheduled-maintenances/active.json', (req, res) => {
  return res.status(200).json({
    scheduled_maintenances: [],
    incidents: [],
  });
});

app.use('/policies', spacebarPolicies);

app.use('/ping', spacebarPing);

app.get('/experiments', (req, res) => {
  return res.status(200).json({ assignments: [] });
});

app.get('/promotions', (req, res) => {
  return res.status(200).json([]);
});

app.get('/applications', (req, res) => {
  return res.status(200).json([]);
});

app.get('/activities', (req, res) => {
  return res.status(200).json([]);
});

app.get('/applications/detectable', (req, res) => {
  return res.status(200).json([]);
});

app.get('/games', (req, res) => {
  return res.status(200).json([]);
});

// Live failover: refresh shard health from Redis heartbeats and mark down
// any shard that hasn't pinged recently. Without this, getShardForUser
// happily routes to a configured shard whose process is not actually
// running, and the client hangs on connecting.
async function refreshShardHealth() {
  if (!shardManager.isEnabled() || !intershard.isEnabled()) return;
  const statuses = await intershard.getAllShardsStatus();
  const now = Date.now();
  for (const s of shardManager.getAllShards()) {
    const live = statuses[s.id];
    if (live?.status === 'online' && now - live.ts < 20_000) {
      shardManager.markShardUp(s.id, live.ts);
    } else {
      shardManager.markShardDown(s.id);
    }
  }
}

async function resolveShardUrl(req) {
  if (!shardManager.isEnabled()) return generateGatewayURL(req);
  await refreshShardHealth();
  const auth = req.headers.authorization;
  if (auth) {
    try {
      const account = await global.database.getAccountByToken(auth);
      if (account?.id) {
        return generateShardedGatewayURL(req, account.id, shardManager);
      }
    } catch {
      /* fall through to default URL */
    }
  }
  // No auth — pick any healthy shard so an anonymous probe never lands on
  // a dead port.
  const healthy = shardManager.getHealthyShards();
  if (healthy.length > 0) {
    const addr = shardManager.getShardAddress(healthy[0]);
    if (addr) return addr.ws;
  }
  return generateGatewayURL(req);
}

app.get('/gateway', async (req, res) => {
  return res.status(200).json({
    url: await resolveShardUrl(req),
  });
});

app.get('/gateway/bot', async (req, res) => {
  return res.status(200).json({
    url: await resolveShardUrl(req),
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
      shards: [
        {
          id: 0,
          status: 'online',
          last_heartbeat: Date.now(),
        },
      ],
    });
  }
  const statuses = intershard.isEnabled() ? await intershard.getAllShardsStatus() : {};
  const shards = shardManager.getAllShards().map((s) => {
    const live = statuses[s.id];
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
    self_shard: shardManager.getSelfShardId(),
    num_shards: shardManager.getNumShards(),
    shards,
  });
});

app.get('/voice/ice', (req, res) => {
  return res.status(200).json({
    servers: [
      {
        url: 'stun:stun.l.google.com:19302',
        username: '',
        credential: '',
      },
    ],
  });
});

app.use('/reports', reports);

app.use(authMiddleware);

app.use('/admin', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), admin);
app.use('/tutorial', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), tutorial);
app.use('/users', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), users);
app.use('/voice', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), voice);
app.use('/guilds', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), guilds);
app.use('/channels', channels);
app.use('/gifs', gifs);
app.use('/entitlements', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), entitlements);
app.use('/activities', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), activities);
app.use(['/invite', '/invites'], instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), invites);
app.use('/webhooks', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), webhooks);
app.use('/oauth2', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), oauth2);
app.use('/store', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), store);
app.use('/integrations', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), integrations);
app.use('/report', instanceMiddleware('VERIFIED_EMAIL_REQUIRED'), report);

app.use('/track', (_, res) => {
  return res.status(204).send();
});

app.use('/science', (_, res) => {
  return res.status(204).send();
});

export default app;
