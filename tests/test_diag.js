#!/usr/bin/env node
'use strict';
/**
 * Test diagnostica stream (v1.4.0)
 * A) diag SPENTA: playlist e stream JSON hanno gli URL originali
 * B) diag ACCESA: playlist.m3u e /stream contengono URL /proxy/play (+token propagato)
 * C) /proxy/play su canale OK -> 302 verso la fonte
 * D) /proxy/play su 403 -> video di errore a schermo (ffmpeg) o 502 testuale
 * E) log live: riga ⛔ con canale e motivo
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MOCK_PORT = 9847;
const APP_PORT = 7338;
const TOKEN = 't0k3n';
const BASE = `http://127.0.0.1:${APP_PORT}`;

const OK_URL = `http://127.0.0.1:${MOCK_PORT}/ok-ch1.ts`;
const BAD_URL = `http://127.0.0.1:${MOCK_PORT}/bad-ch2.ts`;
const CH_OK = 'Diag OK HD';
const CH_BAD = 'Diag KO HD';
const LIST_NAME = 'Lista Diag';

const M3U = [
  '#EXTM3U',
  `#EXTINF:-1,${CH_OK}`,
  OK_URL,
  `#EXTINF:-1,${CH_BAD}`,
  BAD_URL,
  '',
].join('\n');

const HAS_FFMPEG = (() => {
  try { return spawnSync('sh', ['-lc', 'command -v ffmpeg'], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString().trim() !== ''; }
  catch { return false; }
})();

function mockServer() {
  return http.createServer((req, res) => {
    if (req.url === '/lista.m3u') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(M3U); }
    else if (req.url === '/ok-ch1.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.alloc(376, 0x47));
    } else if (req.url === '/bad-ch2.ts') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); }
    else { res.writeHead(404); res.end(''); }
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
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}

const PUBLIC_TOKEN = 'pub1';
async function pubJ(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}${pathname.includes('?') ? '&' : '?'}token=${PUBLIC_TOKEN}`, {
    redirect: 'manual',
    ...opts,
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
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

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisem3u-diag-'));
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
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitFor(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, 15000, 300);

  let ok = true;

  const add = await apiJ('/api/lists', {
    method: 'POST',
    body: JSON.stringify({ url: `http://127.0.0.1:${MOCK_PORT}/lista.m3u`, name: LIST_NAME }),
  });
  assert(add.status === 200, `POST /api/lists -> ${add.status}: ${JSON.stringify(add.body)}`);
  const listId = add.body.id || (add.body.list && add.body.list.id);
  await waitFor(async () => {
    const st = await apiJ(`/api/lists/${listId}/state`);
    return st.body && st.body.status === 'ready';
  }, 20000);

  /* A) spenta: URL originali */
  ok = await run('A: diag spenta -> URL originali invariati', async () => {
    const m3u = await apiJ('/playlist.m3u');
    assert(m3u.status === 200, `playlist -> ${m3u.status}`);
    assert(m3u.body.includes(OK_URL), `playlist senza URL originale:\n${m3u.body.slice(0, 400)}`);
    assert(!m3u.body.includes('/proxy/play'), 'diag spenta ma URL /proxy/play presenti');
  }) && ok;

  /* B) accesa: URL riscritti */
  ok = await run('B: diag accesa -> playlist e stream riscritti', async () => {
    const cfgGet = await apiJ('/api/config');
    const cfg = cfgGet.body.config || cfgGet.body;
    cfg.settings.streamDiag = true;
    cfg.settings.token = PUBLIC_TOKEN;
    const put = await apiJ('/api/config', { method: 'PUT', body: JSON.stringify({ settings: cfg.settings, lists: cfg.lists }) });
    assert(put.status === 200, `PUT /api/config -> ${put.status}`);

    const m3u = await pubJ('/playlist.m3u');
    assert(m3u.status === 200, `playlist -> ${m3u.status}`);
    assert(m3u.body.includes('/proxy/play?'), `manca URL diagnostico:\n${m3u.body.slice(0, 500)}`);
    const line = m3u.body.split('\n').find((l) => l.includes('/proxy/play'));
    assert(decodeURIComponent(line).includes(OK_URL), `parametro u diverso: ${line}`);
    assert(line.includes(`token=${PUBLIC_TOKEN}`), `manca token propagato: ${line}`);

    const cat = await pubJ(`/catalog/tv/wise%3A${encodeURIComponent(listId)}.json`);
    const metas = (cat.body && cat.body.metas) || [];
    const st = await pubJ(`/stream/tv/${encodeURIComponent(metas.find((m) => m.name.includes('OK')).id)}.json`);
    const s0 = (st.body.streams || [])[0];
    assert(s0 && s0.url.includes('/proxy/play') && s0.url.includes(`token=${PUBLIC_TOKEN}`), `stream non riscritto`);
  }) && ok;

  /* C) OK -> 302 */
  ok = await run('C: stream OK -> redirect 302 diretto', async () => {
    const u = `/proxy/play?u=${encodeURIComponent(OK_URL)}&n=${encodeURIComponent(CH_OK)}&l=${encodeURIComponent(LIST_NAME)}`;
    const r = await pubJ(u);
    assert(r.status === 302, `status ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert(r.headers.get('location') === OK_URL, `Location: ${r.headers.get('location')}`);
  }) && ok;

  /* D) 403 -> video/errore */
  ok = await run('D: stream 403 -> messaggio a schermo', async () => {
    const u = `/proxy/play?u=${encodeURIComponent(BAD_URL)}&n=${encodeURIComponent(CH_BAD)}&l=${encodeURIComponent(LIST_NAME)}`;
    const res = await fetch(`${BASE}${u}&token=${PUBLIC_TOKEN}`, { redirect: 'manual' });
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (HAS_FFMPEG) {
      assert(res.status === 200, `ffmpeg presente ma status ${res.status}`);
      assert(/mp2t|octet-stream/.test(ct), `content-type: ${ct}`);
      assert(buf.length > 1000 && buf[0] === 0x47, `payload non TS`);
    } else {
      assert(res.status === 502, `senza ffmpeg atteso 502, status ${res.status}`);
      const txt = buf.toString('utf8');
      assert(txt.includes('STREAM NON DISPONIBILE') && txt.includes(CH_BAD) && txt.includes('403'), `testo:\n${txt}`);
    }
  }) && ok;

  /* E) log ⛔ */
  ok = await run('E: log live contiene ⛔ diagnostico', async () => {
    const logs = await apiJ('/api/logs?scope=stream&limit=200');
    const msgs = logs.body.entries.map((e) => e.msg).join('\n');
    assert(/⛔/.test(msgs) && msgs.includes(CH_BAD) && /accesso negato|403/.test(msgs) && /⏯/.test(msgs), `log:\n${msgs}`);
  }) && ok;

  app.kill('SIGTERM');
  mock.close();
  console.log(ok ? '\nTUTTI I TEST DIAG PASSATI ✔' : '\nALCUNI TEST DIAG FALLITI ✖');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
