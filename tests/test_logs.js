#!/usr/bin/env node
'use strict';
/**
 * Test log live + retry mirati (v1.1.3)
 * A) https su server solo-HTTP -> downgrade a http (ERR_SSL_WRONG_VERSION_NUMBER)
 * B) risposta vuota 0 byte -> messaggio "contenuto vuoto"
 * C) pagina HTML -> suggerimento link diretto
 * D) HTTP 403 -> spiegazione accesso negato
 * E) /api/logs + righe download/stream con canale, lista, url, ua
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const { buildTree } = require(path.join(REPO, 'src', 'wiseplay'));
const MOCK_PORT = 9846;
const APP_PORT = 7337;
const TOKEN = 't0k3n';
const BASE = `http://127.0.0.1:${APP_PORT}`;

const CHAN_URL = `http://127.0.0.1:${MOCK_PORT}/live/NewTestHD/ch1.ts`;
const CHAN_NAME = 'New Test HD';
const LIST_NAME = 'Lista Mock Logs';
const M3U = ['#EXTM3U', `#EXTINF:-1 tvg-id="newtest",${CHAN_NAME}`, CHAN_URL, ''].join('\n');

function mockServer() {
  return http.createServer((req, res) => {
    if (req.url === '/lista.m3u') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(M3U); }
    else if (req.url === '/vuota.m3u') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(''); }
    else if (req.url === '/websignin.jsp') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!DOCTYPE html><html><head><title>Google</title></head><body>sorry</body></html>'); }
    else if (req.url === '/negato.m3u') { res.writeHead(403); res.end('Forbidden'); }
    else { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(''); }
  });
}

async function run(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); return true; }
  catch (err) { console.log(`FAIL  ${name} — ${err.message}`); return false; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

async function apiJ(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}${pathname.includes('?') ? '&' : '?'}token=${TOKEN}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body };
}

async function waitFor(pred, ms, step = 400) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout attesa');
    await new Promise((r) => setTimeout(r, step));
  }
}

(async () => {
  const mock = mockServer();
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisem3u-logs-'));
  const app = spawn('node', [path.join(REPO, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      CONFIG_FILE: path.join(dataDir, 'config.json'),
      CACHE_DIR: path.join(dataDir, 'cache'),
      ADMIN_TOKEN: TOKEN,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  app.stderr.on('data', () => {});
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; }
  }, 15000, 300);

  let ok = true;

  ok = await run('A: https→http (ERR_SSL_WRONG_VERSION_NUMBER)', async () => {
    const r = await buildTree(`https://127.0.0.1:${MOCK_PORT}/lista.m3u`, { maxDepth: 5 });
    assert(r.stats && r.stats.stations >= 1, `stats: ${JSON.stringify(r.stats)}`);
    assert(JSON.stringify(r.children).includes('Test'), `canale assente`);
  }) && ok;

  ok = await run('B: risposta vuota 0 byte → messaggio esplicito', async () => {
    let err = null;
    try { await buildTree(`http://127.0.0.1:${MOCK_PORT}/vuota.m3u`, { maxDepth: 5 }); }
    catch (e) { err = e; }
    assert(err && /vuot|0 byte/i.test(err.message), `messaggio: ${err && err.message}`);
  }) && ok;

  ok = await run('C: pagina HTML → suggerimento link diretto', async () => {
    let err = null;
    try { await buildTree(`http://127.0.0.1:${MOCK_PORT}/websignin.jsp`, { maxDepth: 5 }); }
    catch (e) { err = e; }
    assert(err && /PAGINA WEB HTML|LINK DIRETTO/i.test(err.message), `messaggio: ${err && err.message}`);
  }) && ok;

  ok = await run('D: HTTP 403 → spiegazione accesso negato', async () => {
    let err = null;
    try { await buildTree(`http://127.0.0.1:${MOCK_PORT}/negato.m3u`, { maxDepth: 5 }); }
    catch (e) { err = e; }
    assert(err && /403/.test(err.message) && /accesso negato/i.test(err.message), `messaggio: ${err && err.message}`);
  }) && ok;

  ok = await run('E: log live (endpoint, download, stream ▶)', async () => {
    const boot = await apiJ('/api/logs');
    assert(boot.status === 200 && Array.isArray(boot.body.entries), `api/logs -> ${boot.status}`);
    const unauth = await fetch(`${BASE}/api/logs`);
    assert(unauth.status === 401, `senza token -> ${unauth.status}`);

    const add = await apiJ('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ url: `http://127.0.0.1:${MOCK_PORT}/lista.m3u`, name: LIST_NAME }),
    });
    assert(add.status === 200, `POST /api/lists -> ${add.status}`);
    const listId = add.body.id || (add.body.list && add.body.list.id);
    await waitFor(async () => {
      const st = await apiJ(`/api/lists/${listId}/state`);
      return st.body && (st.body.status === 'ready' || (st.body.state && st.body.state.status === 'ready'));
    }, 20000);

    const dl = await apiJ('/api/logs?scope=download&limit=200');
    const dlMsgs = dl.body.entries.map((e) => e.msg).join('\n');
    assert(dlMsgs.includes(LIST_NAME) && /✔|pronta/i.test(dlMsgs), `download log:\n${dlMsgs}`);

    const treeR = await apiJ(`/api/lists/${listId}/tree`);
    const brPath = (treeR.body.branches || [])[0];
    assert(brPath, `branches: ${JSON.stringify(treeR.body).slice(0, 200)}`);
    const chans = await apiJ(`/api/lists/${listId}/channels?path=${encodeURIComponent(brPath.path)}`);
    assert((chans.body.channels || []).length === 1, `channels: ${JSON.stringify(chans.body).slice(0, 200)}`);
    assert(chans.body.channels[0].url === CHAN_URL,
      `url sorgente atteso ${CHAN_URL}: ${JSON.stringify(chans.body.channels)}`);

    const cat = await apiJ(`/catalog/tv/wise%3A${encodeURIComponent(listId)}.json?skip=0`);
    const metas = (cat.body && cat.body.metas) || [];
    const meta = metas.find((m) => (m.name || '').includes('Test'));
    assert(meta, `catalogo: ${JSON.stringify(metas).slice(0, 200)}`);
    // i canali TV devono uscire come card landscape (loghi orizzontali):
    // se ricompare 'square' i client ricominciano a tagliare i loghi (v1.4.7)
    assert(meta.posterShape === 'landscape',
      `posterShape catalogo: ${meta.posterShape}`);
    const metaDet = await apiJ(`/meta/tv/${encodeURIComponent(meta.id)}.json`);
    assert(metaDet.body && metaDet.body.meta && metaDet.body.meta.posterShape === 'landscape',
      `posterShape meta: ${JSON.stringify(metaDet.body).slice(0, 200)}`);

    const stream = await apiJ(`/stream/tv/${encodeURIComponent(meta.id)}.json`);
    assert(stream.status === 200 && (stream.body.streams || []).some((s) => s.url === CHAN_URL),
      `stream: ${JSON.stringify(stream.body).slice(0, 200)}`);

    const st = await apiJ('/api/logs?scope=stream&limit=200');
    const stMsgs = st.body.entries.map((e) => e.msg).join('\n');
    assert(/▶/.test(stMsgs) && stMsgs.includes(CHAN_NAME) && stMsgs.includes(LIST_NAME) && stMsgs.includes(CHAN_URL),
      `stream log incompleto:\n${stMsgs}`);
    const entry = st.body.entries.find((e) => e.msg.includes('▶'));
    assert(entry.data && entry.data.ua != null && entry.data.ms != null, `data: ${JSON.stringify(entry.data)}`);

    const clr = await apiJ('/api/logs/clear', { method: 'POST', body: '{}' });
    assert(clr.status === 200 && clr.body.ok, `clear: ${JSON.stringify(clr.body)}`);
    const after = await apiJ('/api/logs');
    assert(after.body.entries.length === 0, `buffer: ${after.body.entries.length}`);

    // regressione bug v1.4.4→v1.4.5: il marcatore WM_UI_VERSION nella pagina DEVE
    // essere iniettato dal server = stessa versione del backend (altrimenti l'avviso
    // "pagina vecchia" resta per sempre anche dopo l'aggiornamento)
    const page = await fetch(`${BASE}/configure`);
    const html = await page.text();
    const pkgV = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
    assert(html.includes(`WM_UI_VERSION = '${pkgV}'`),
      `marcatore in pagina diverso da package.json (${pkgV})`);
    assert(!html.includes('__WM_UI_VERSION__'), 'placeholder non sostituito in pagina');
  }) && ok;

  app.kill('SIGTERM');
  mock.close();
  console.log(ok ? '\nTUTTI I TEST PASSATI ✔' : '\nALCUNI TEST FALLITI ✖');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
