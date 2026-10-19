#!/usr/bin/env node
'use strict';
/**
 * Test dieta RAM (v1.4.5)
 * =======================
 * Server reale con 3 liste x 9000 canali (27k stazioni tenute in cache):
 * dopo che tutte sono pronte (e dopo usi di playlist/catalogo/canali),
 * l'RSS del processo addon deve restare sotto soglia grazie a:
 * alberi gz in RAM + solo WM_HOT_TREES parseati alla volta + GC periodica.
 *
 * Esegui con: node --expose-gc test_mem.js (la GC nel server richiede --expose-gc)
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MOCK_PORT = 9849;
const APP_PORT = 7340;
const TOKEN = 't0k3n';
const BASE = `http://127.0.0.1:${APP_PORT}`;
const N = 9000;
const GROUPS = 90;
const RSS_LIMIT_MB = Number(process.env.RSS_LIMIT_MB || 240);

function makeM3u(n, seed) {
  const parts = ['#EXTM3U'];
  for (let i = 0; i < n; i++) {
    parts.push(`#EXTINF:-1 tvg-logo="http://logo.srv/${(i + seed) % 50}.png" group-title="G${i % GROUPS}",Canale ${seed} ${i}`);
    parts.push(`http://127.0.0.1:${MOCK_PORT}/live/u${seed}_${i}/p/schema_${i}.ts?id=${'z'.repeat(26)}`);
  }
  return parts.join('\n');
}

const rssKb = (pid) => {
  const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const m = s.match(/VmRSS:\s+(\d+) kB/);
  return m ? Number(m[1]) : 0;
};

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

async function waitFor(pred, ms, step = 500) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return true;
    if (Date.now() - t0 > ms) throw new Error('timeout attesa');
    await new Promise((r) => setTimeout(r, step));
  }
}

(async () => {
  const mock = http.createServer((req, res) => {
    const m = req.url.match(/^\/lista(\d)\.m3u/);
    if (m) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(makeM3u(N, Number(m[1]))); }
    else { res.writeHead(404); res.end(''); }
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisem3u-mem-'));
  const app = spawn('node', ['--expose-gc', path.join(REPO, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
      CONFIG_FILE: path.join(dataDir, 'config.json'),
      CACHE_DIR: path.join(dataDir, 'cache'),
      ADMIN_TOKEN: TOKEN,
      WM_HOT_TREES: '1',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  app.stderr.on('data', () => {});
  await waitFor(async () => { try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; } }, 15000, 300);

  let ok = true;
  let listIds = [null, null, null];

  ok = await run('A: 3 liste x 9000 canali pronte, RSS sotto soglia', async () => {
    for (let i = 0; i < 3; i++) {
      const add = await apiJ('/api/lists', {
        method: 'POST',
        body: JSON.stringify({ url: `http://127.0.0.1:${MOCK_PORT}/lista${i}.m3u`, name: `ListaM${i}` }),
      });
      assert(add.status === 200, `POST lista${i} -> ${add.status}: ${JSON.stringify(add.body).slice(0, 200)}`);
      listIds[i] = add.body.id || (add.body.list && add.body.list.id);
      await waitFor(async () => {
        const st = await apiJ(`/api/lists/${listIds[i]}/state`);
        return st.body && st.body.status === 'ready';
      }, 60000);
      console.log(`     lista ${listIds[i]} ready — RSS attuale: ${Math.round(rssKb(app.pid) / 1024)} MB`);
    }
    // aspetta una GC del server (timer 30 s, unref)
    await new Promise((r) => setTimeout(r, 3000));
    const rss = Math.round(rssKb(app.pid) / 1024);
    console.log(`     RSS post-pronte: ${rss} MB (limite ${RSS_LIMIT_MB} MB)`);
    assert(rss < RSS_LIMIT_MB, `RSS ${rss} MB >= limite ${RSS_LIMIT_MB} MB`);
  }) && ok;

  ok = await run('B: correttezza — tutte le liste rispondono (parse al volo)', async () => {
    const pl = await apiJ('/playlist.m3u');
    assert(pl.status === 200, `playlist -> ${pl.status}`);
    const count = (pl.body.match(/#EXTINF/g) || []).length;
    assert(count === 3 * N, `canali playlist: ${count} attesi ${3 * N}`);
    // cold parse della PRIMA lista (probabilmente evitta dalle ultime)
    const tree1 = await apiJ(`/api/lists/${listIds[0]}/tree`);
    assert((tree1.body.branches || []).length >= 1, `branches lista0: ${JSON.stringify(tree1.body).slice(0, 200)}`);
    const cat0 = await apiJ(`/catalog/tv/wise%3A${encodeURIComponent(listIds[0])}.json`);
    assert((cat0.body.metas || []).length >= 1, `catalogo lista0 vuoto`);
  }) && ok;

  ok = await run('C: pressione di uso reale non fa esplodere la RAM', async () => {
    for (const id of listIds) {
      await apiJ(`/api/lists/${id}/tree`);
      await apiJ(`/catalog/tv/wise%3A${encodeURIComponent(id)}.json`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const rss = Math.round(rssKb(app.pid) / 1024);
    console.log(`     RSS dopo uso intenso: ${rss} MB (limite ${RSS_LIMIT_MB} MB)`);
    assert(rss < RSS_LIMIT_MB, `RSS ${rss} MB >= limite ${RSS_LIMIT_MB} MB`);
  }) && ok;

  app.kill('SIGTERM');
  mock.close();
  console.log(ok ? '\nTEST MEMORIA PASSATO ✔' : '\nTEST MEMORIA FALLITO ✖');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
