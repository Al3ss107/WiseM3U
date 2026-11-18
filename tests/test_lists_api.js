#!/usr/bin/env node
'use strict';

/**
 * Lists API smoke test: add a list, wait for the background download, read its
 * tree/channels/preview, refresh and delete it. It also checks that the list
 * routes are mounted at the expected paths after the modular refactor.
 */
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const TOKEN = 'lists-test';
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

async function api(pathname, options = {}) {
  const separator = pathname.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${pathname}${separator}token=${TOKEN}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    body: type.includes('json') ? await res.json() : await res.text(),
  };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-lists-'));
  const appPort = await freePort();
  BASE = `http://127.0.0.1:${appPort}`;
  const sourcePort = await freePort();
  const source = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.end([
      '#EXTM3U',
      '#EXTINF:-1 tvg-logo="https://example.com/logo.png" group-title="News",Alpha',
      'http://127.0.0.1:9/alpha.m3u8',
      '#EXTINF:-1 group-title="News",Beta',
      'http://127.0.0.1:9/beta.m3u8',
      '',
    ].join('\n'));
  });
  await new Promise((resolve) => source.listen(sourcePort, '127.0.0.1', resolve));

  const app = spawn('node', [path.join(REPO, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(appPort),
      HOST: '127.0.0.1',
      CONFIG_FILE: path.join(dir, 'config.json'),
      CACHE_DIR: path.join(dir, 'cache'),
      ADMIN_TOKEN: TOKEN,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${BASE}/healthz`)).ok; } catch (_) { /* starting */ }
    if (!up) await sleep(100);
  }
  ok(up, 'server started');
  if (!up) { app.kill(); source.close(); process.exit(1); }

  const noEpg = await api('/manifest.json');
  ok(!noEpg.body.behaviorHints || noEpg.body.behaviorHints.epgProvider === undefined, 'no EPG source: manifest does not opt in');

  try {
    const added = await api('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ url: `http://127.0.0.1:${sourcePort}/list.m3u`, name: 'Smoke' }),
    });
    ok(added.status === 200 && added.body.list && added.body.list.id, 'POST /api/lists creates a list');
    const id = added.body.list && added.body.list.id;

    let state = null;
    for (let i = 0; i < 80; i++) {
      state = await api(`/api/lists/${id}/state`);
      if (state.body.status === 'ready') break;
      await sleep(100);
    }
    ok(state && state.body.status === 'ready', 'background download reaches ready');
    ok(state && state.body.stats && state.body.stats.stations === 2, 'download counts both channels');

    const tree = await api(`/api/lists/${id}/tree`);
    ok(tree.status === 200 && tree.body && tree.body.meta, 'GET /:id/tree returns the tree');

    const suggest = await api(`/api/lists/${id}/suggest?path=News`);
    ok(suggest.status === 200 && (suggest.body.names || []).includes('Alpha'), 'GET /:id/suggest returns channel names');

    const preview = await api(`/api/lists/${id}/preview.m3u`);
    ok(preview.status === 200 && preview.body.includes('Alpha') && preview.body.includes('Beta'), 'GET /:id/preview.m3u exports channels');

    const xtream = await api(`/api/lists/${id}/xtream`);
    ok(xtream.status === 200 && xtream.body.xtream === false, 'GET /:id/xtream ignores non-Xtream URLs');

    const refreshed = await api(`/api/lists/${id}/refresh`, { method: 'POST', body: '{}' });
    ok(refreshed.status === 200, 'POST /:id/refresh starts a forced download');

    const deleted = await api(`/api/lists/${id}`, { method: 'DELETE' });
    ok(deleted.status === 200, 'DELETE /:id removes the list');
  } finally {
    app.kill();
    source.close();
  }

  console.log('');
  console.log(fail === 0 ? `ALL LISTS API TESTS PASSED (${pass})` : `${fail} LISTS API TESTS FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
