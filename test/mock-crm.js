#!/usr/bin/env node
/**
 * Mock of the CRM device API, for testing the bridge without the real CRM.
 *
 *   node test/mock-crm.js            # listens on http://127.0.0.1:8787
 *
 * Point the bridge at it with CRM_BASE_URL=http://127.0.0.1:8787/api and
 * CRM_DEVICE_KEY=test-key. Any path prefix before /device-api is accepted.
 *
 * Environment:
 *   MOCK_PORT           port (default 8787)
 *   MOCK_DEVICE_KEY     expected x-device-key (default "test-key"); wrong key -> 401
 *   MOCK_FAIL_PUNCHES   answer 503 to the first N punch uploads (default 0)
 *   MOCK_COMMANDS       JSON array of commands served once (default: one GET_USERS)
 */
'use strict';
const http = require('node:http');

const PORT = Number(process.env.MOCK_PORT || 8787);
const KEY = process.env.MOCK_DEVICE_KEY || 'test-key';
let failPunches = Number(process.env.MOCK_FAIL_PUNCHES || 0);
let pendingCommands = process.env.MOCK_COMMANDS
  ? JSON.parse(process.env.MOCK_COMMANDS)
  : [{ id: 'cmd-1', type: 'GET_USERS', payload: null }];

const stored = new Set(); // dedupe key: deviceUserId|punchedAt (device is implicit: one key = one device)
const stats = { punchPosts: 0, accepted: 0, duplicates: 0, heartbeats: 0, acks: 0 };

const log = (...args) => console.log(new Date().toISOString(), ...args);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const at = url.pathname.indexOf('/device-api/');
    const route = at >= 0 ? url.pathname.slice(at) : url.pathname;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      log(`${req.method} ${route} -> 400 (invalid JSON)`);
      return send(res, 400, { message: 'invalid JSON' });
    }
    const ua = req.headers['user-agent'];

    if (req.headers['x-device-key'] !== KEY) {
      log(`${req.method} ${route} -> 401 (bad x-device-key "${req.headers['x-device-key']}")`);
      return send(res, 401, { message: 'invalid device key' });
    }

    if (req.method === 'POST' && route === '/device-api/punches') {
      stats.punchPosts++;
      const punches = body && Array.isArray(body.punches) ? body.punches : null;
      if (!punches || punches.length > 1000) {
        log(`POST ${route} -> 400 (bad punches array)`);
        return send(res, 400, { message: 'punches must be an array of at most 1000' });
      }
      if (failPunches > 0) {
        failPunches--;
        log(`POST ${route} (${punches.length} punches) -> 503 (simulated outage, ${failPunches} more)`);
        return send(res, 503, { message: 'simulated outage' });
      }
      let accepted = 0;
      let duplicates = 0;
      for (const p of punches) {
        const key = `${p.deviceUserId}|${p.punchedAt}`;
        if (stored.has(key)) duplicates++;
        else {
          stored.add(key);
          accepted++;
        }
        log(`  punch user=${p.deviceUserId} at=${p.punchedAt} state=${p.state} verify=${p.verifyType} source=${p.source}`);
      }
      stats.accepted += accepted;
      stats.duplicates += duplicates;
      log(`POST ${route} (${punches.length} punches, ${ua}) -> 200 accepted=${accepted} duplicates=${duplicates}`);
      return send(res, 200, { accepted, duplicates });
    }

    if (req.method === 'POST' && route === '/device-api/heartbeat') {
      stats.heartbeats++;
      log(`POST ${route} -> 200 ${JSON.stringify(body)}`);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && route === '/device-api/commands') {
      const commands = pendingCommands;
      pendingCommands = [];
      log(`GET ${route} -> 200 (${commands.length} command(s)${commands.length ? ': ' + commands.map((c) => c.type).join(', ') : ''})`);
      return send(res, 200, { commands });
    }

    const ack = route.match(/^\/device-api\/commands\/([^/]+)\/ack$/);
    if (req.method === 'POST' && ack) {
      stats.acks++;
      log(`POST ${route} -> 200 ack for ${decodeURIComponent(ack[1])}: ${JSON.stringify(body)}`);
      return send(res, 200, { ok: true });
    }

    log(`${req.method} ${route} -> 404`);
    send(res, 404, { message: 'not found' });
  });
});

server.listen(PORT, '127.0.0.1', () => log(`mock CRM listening on http://127.0.0.1:${PORT} (key "${KEY}")`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`mock CRM stopping. ${JSON.stringify(stats)}, ${stored.size} unique punch(es) stored`);
    process.exit(0);
  });
}
