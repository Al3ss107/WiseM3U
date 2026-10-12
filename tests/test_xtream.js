#!/usr/bin/env node
'use strict';
/**
 * Test scadenza account Xtream (v1.4.1)
 * A) lista get.php con user/pass -> /api/lists/:id/xtream ok con scadenza + giorni
 * B) la seconda chiamata usa la cache(30 min): fetchedAt identico
 * C) lista non-Xtream (m3u semplice) -> {ok:false, xtream:false}
 * D) pannello irraggiungibile ma cache presente -> stale:true
 * E) xtreamInfo parser: no username/password -> null
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const xtream = require(path.join(REPO, 'src', 'xtream'));

const MOCK_PORT = 9848;
const APP_PORT = 7339;
const TOKEN = 't0k3n';
const BASE = `http://127.0.0.1:${APP_PORT}`;
const LIST_URL = `http://127.0.0.1:${MOCK_PORT}/get.php?username=demo&password=segreto&type=m3u_plus&output=ts`;

const EXP_TS = Math.floor(Date.now() / 1000) + 45 * 86400; // scade tra 45 giorni
const M3U = ['#EXTM3U', '#EXTINF:-1,Canale Test', `${M3U_TS_HOST()}/ts/1.ts`, ''].join('\n');
function M3U_TS_HOST() { return `http://127.0.0.1:${MOCK_PORT}`; }

let playerApiHits = 0;
function mockServer() {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/get.php')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(M3U); }
    else if (req.url.startsWith('/player_api.php')) {
      playerApiHits++;
      if (req.url.includes('username=demo')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user_info: { status: 'Active', exp_date: EXP_TS, max_connections: '2', is_trial: '0', active_cons: '0' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
      }
    } else { res.writeHead(404); res.end(''); }
  });
}

async function run(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); return true; }
  catch (err) { console.log(`FAIL  ${name} — ${err.message}`); return false; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

async function apiJ(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}${pathname.includes('?') ? '&' : '?'}token=${TOKEN}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return { status: res.status, body: await res.json() };
}

async function waitFor(pred, ms, step = 400) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - t0 > ms) throw new Error('timeout attesa');
    await new Promise((r) => setTimeout(r, step));
  }
}

(async () => {
  const mock = mockServer();
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisem3u-xtream-'));
  const app = spawn('node', [path.join(REPO, 'src', 'server.js')], {
    env: {
      ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1',
      CONFIG_FILE: path.join(dataDir, 'config.json'),
      CACHE_DIR: path.join(dataDir, 'cache'),
      ADMIN_TOKEN: TOKEN, LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitFor(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, 15000, 300);

  let ok = true;

  // lista Xtream + una lista non-Xtream
  const add1 = await apiJ('/api/lists', { method: 'POST', body: JSON.stringify({ url: LIST_URL, name: 'Panel Demo' }) });
  const id1 = add1.body.id || (add1.body.list && add1.body.list.id);
  const add2 = await apiJ('/api/lists', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${MOCK_PORT}/notfound.m3u`, name: 'Plain' }) });
  const id2 = add2.body.id || (add2.body.list && add2.body.list.id);

  ok = await run('A: scadenza letta dal pannello Xtream', async () => {
    const r = await apiJ(`/api/lists/${id1}/xtream`);
    assert(r.status === 200 && r.body.ok === true, `risposta: ${JSON.stringify(r.body)}`);
    assert(r.body.user && r.body.user.status === 'Active', `stato: ${JSON.stringify(r.body.user)}`);
    assert(r.body.user.daysLeft >= 44 && r.body.user.daysLeft <= 46, `giorni: ${r.body.user.daysLeft}`);
    assert(/^\d{4}-\d{2}-\d{2}T/.test(r.body.user.expiryIso), `expiryIso: ${r.body.user.expiryIso}`);
    assert(r.body.user.maxConnections === 2, `maxConn: ${r.body.user.maxConnections}`);
  }) && ok;

  ok = await run('B: cache 30 min (nessuna nuova richiesta al pannello)', async () => {
    const hitsBefore = playerApiHits;
    const r = await apiJ(`/api/lists/${id1}/xtream`);
    assert(r.body.cached === true, `cached: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert(playerApiHits === hitsBefore, `richiesta ripetuta non cachata (${hitsBefore} -> ${playerApiHits})`);
    // refresh forzato
    const r2 = await apiJ(`/api/lists/${id1}/xtream?refresh=1`);
    assert(r2.body.cached === false && r2.body.ok === true, `refresh forzato: ${JSON.stringify(r2.body).slice(0, 200)}`);
    assert(playerApiHits === hitsBefore + 1, `refresh forzato non ha interrogato il pannello`);
  }) && ok;

  ok = await run('C: lista non-Xtream -> ok:false', async () => {
    const r = await apiJ(`/api/lists/${id2}/xtream`);
    assert(r.status === 200 && r.body.ok === false && r.body.xtream === false, `risposta: ${JSON.stringify(r.body)}`);
  }) && ok;

  ok = await run('D: pannello giu ma cache esiste -> stale', async () => {
    mock.closeAllConnections();
    // fai fallire la chiamata fresca spegnendo il mini server temporaneamente
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const saved = data.lists.find((l) => l.id === id1).state.xtream;
    assert(saved && saved.user, `cache non persistita in config: ${JSON.stringify(saved)}`);
    await new Promise((r) => mock.close(r));
    const r = await apiJ(`/api/lists/${id1}/xtream?refresh=1`);
    assert(r.body.ok === true && r.body.stale === true, `stale: ${JSON.stringify(r.body).slice(0, 300)}`);
    assert(r.body.fetchError, `fetchError mancante: ${JSON.stringify(r.body).slice(0, 300)}`);
  }) && ok;

  ok = await run('E: parsificatore URL Xtream', async () => {
    assert(xtream.xtreamInfo(LIST_URL).panelApi.includes('username=demo'), 'panelApi');
    assert(xtream.xtreamInfo(`http://h/get.php?username=demo`) === null, 'manca password -> null');
    assert(xtream.xtreamInfo(`http://h/playlist.m3u`) === null, 'non get.php -> null');
    assert(xtream.xtreamInfo('non-un-url') === null, 'url rotto -> null');
  }) && ok;

  try { app.kill('SIGTERM'); } catch (_) { }
  console.log(ok ? '\nTUTTI I TEST XTREAM PASSATI ✔' : '\nALCUNI TEST XTREAM FALLITI ✖');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
