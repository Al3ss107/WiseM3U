#!/usr/bin/env node
'use strict';

/**
 * ACCESS_TOKEN environment variable: it must protect client-facing endpoints
 * automatically and must never be persisted into config.json. ADMIN_TOKEN stays
 * a separate credential for the configuration APIs.
 */
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ADMIN = 'admin-test';
const ACCESS = 'access-test';
let BASE = '';
let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log('PASS ' + message); }
  else { fail++; console.log('FAIL ' + message); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function call(pathname, token) {
  const sep = pathname.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${pathname}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-token-'));
  const configFile = path.join(dir, 'config.json');
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const app = spawn('node', [path.join(REPO, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CONFIG_FILE: configFile,
      CACHE_DIR: path.join(dir, 'cache'),
      ADMIN_TOKEN: ADMIN,
      ACCESS_TOKEN: ACCESS,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${BASE}/healthz`)).ok; } catch (_) { /* starting */ }
    if (!up) await sleep(120);
  }
  ok(up, 'server started with ACCESS_TOKEN');
  if (!up) { app.kill(); process.exit(1); }

  try {
    ok((await call('/playlist.m3u')).status === 401, 'playlist without token is rejected');
    ok((await call('/playlist.m3u', ADMIN)).status === 401, 'ADMIN_TOKEN is not the access token');
    ok((await call('/playlist.m3u', ACCESS)).status === 200, 'playlist accepts ACCESS_TOKEN');

    const cfg = await call('/api/config', ADMIN);
    ok(cfg.status === 200 && cfg.body.settings.token === ACCESS, 'config page receives the effective env token');
    ok(cfg.body.accessTokenFromEnv === true, 'config tells the UI that the token comes from the environment');

    const put = await fetch(`${BASE}/api/config?token=${ADMIN}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { token: 'ui-token', addonName: 'Env test' }, baseRev: cfg.body.rev }),
    });
    ok(put.status === 200, 'configuration save succeeds');
    const after = await call('/api/config', ADMIN);
    ok(after.body.settings.token === ACCESS, 'a UI save cannot replace the env token');
    ok((await call('/playlist.m3u', 'ui-token')).status === 401, 'the discarded UI token does not work');
    const disk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    ok(disk.settings.token === '', 'ACCESS_TOKEN is not written to config.json');
    ok(disk.settings.addonName === 'Env test', 'other settings are still saved normally');
  } finally {
    app.kill();
  }

  console.log('');
  console.log(fail === 0 ? `ALL ACCESS TOKEN TESTS PASSED (${pass})` : `${fail} ACCESS TOKEN TESTS FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
