#!/usr/bin/env node
'use strict';
/**
 * Cronologia configurazione: snapshot automatici, dedupe, filtro per lista,
 * ripristino selettivo per categorie e protezione del token admin.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const REPO = path.resolve(__dirname, '..');
const { defaultListOptions } = require(path.join(REPO, 'src', 'config.js'));

const PORT = 7393;
const TOKEN = 'tok';
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m)=>{ if (c){ pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

async function api(p, opts={}){
  const res = await fetch(`${BASE}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

const mkList = (id, name, opts={}) => ({
  id, url: `http://127.0.0.1:9/${id}.m3u`, name, kind: 'normal',
  state: { status: 'ready' },
  options: { ...defaultListOptions(), ...opts },
});

(async ()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-hist-'));
  const app = spawn('node', [path.join(REPO, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      CONFIG_FILE: path.join(dir, 'config.json'), CACHE_DIR: path.join(dir, 'cache'),
      ADMIN_TOKEN: TOKEN, LOG_LEVEL: 'error' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let up = false;
  for (let i=0; i<80 && !up; i++){
    try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { }
    if (!up) await sleep(150);
  }
  ok(up, 'server avviato');
  if (!up){ app.kill(); process.exit(1); }

  // v1: lista A con ordine [X,Y], lista B
  const listA = mkList('l_a', 'Lista A', { order: ['X', 'Y'], renames: { X: 'Vecchio nome' } });
  const listB = mkList('l_b', 'Lista B');
  let r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: { addonName: 'WiseM3U-test', token: TOKEN }, lists: [listA, listB], reason: 'prima versione',
  }) });
  ok(r.status === 200, 'v1 salvata');

  let hist = (await api('/api/history')).body.entries;
  ok(hist.length === 1, `primo snapshot registrato (${hist.length})`);
  ok(hist[0].reason === 'prima versione', 'motivo dello snapshot conservato');
  const idV1 = hist[0].id;

  await sleep(15);

  // v2: cambia ordine, nomi, nome lista B e impostazioni
  const listA2 = mkList('l_a', 'Lista A', { order: ['Y', 'X'], renames: { X: 'Nuovo nome' } });
  const listB2 = mkList('l_b', 'Lista B rinominata');
  r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: { addonName: 'WiseM3U-due', token: TOKEN }, lists: [listA2, listB2], reason: 'seconda versione',
  }) });
  ok(r.status === 200, 'v2 salvata');
  await sleep(15);

  // salvataggio identico: nessun nuovo snapshot (dedupe). Si rimanda la config
  // letta dal server (con createdAt), esattamente come fa la UI.
  const cfgNow = (await api('/api/config')).body;
  await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: cfgNow.settings, lists: cfgNow.lists, reason: 'identico',
  }) });
  hist = (await api('/api/history')).body.entries;
  ok(hist.length === 2, `salvataggio identico non crea snapshot (${hist.length})`);
  ok(hist[0].reason === 'seconda versione', 'ordine: il piu recente per primo');
  const changes = hist[0].changes;
  ok(changes.settings === true, 'diff rileva le impostazioni generali');
  ok(changes.lists === true, 'diff rileva il nome di una lista');
  ok((changes.options.l_a || []).includes('order'), 'diff rileva l ordine di l_a');
  ok((changes.options.l_a || []).includes('names'), 'diff rileva i nomi di l_a');

  // filtro per lista
  const filtered = (await api('/api/history?list=l_b')).body.entries;
  ok(filtered.length >= 1 && filtered.every(e=>!e.changes.options.l_a || Object.keys(e.changes.options).length === 0 || e.changes.lists),
     'filtro per lista: niente differenze di l_a');
  const onlyA = (await api('/api/history?list=l_a')).body.entries;
  ok(onlyA.length === 2, `filtro l_a mostra gli stati che la cambiano (${onlyA.length})`);

  // ripristino solo ordine di l_a dallo snapshot v1
  r = await api(`/api/history/${idV1}/restore`, { method:'POST', body: JSON.stringify({
    listId: 'l_a', options: ['order'],
  }) });
  ok(r.status === 200 && r.body.ok, 'ripristino selettivo risponde ok');
  ok(Array.isArray(r.body.restored.options.l_a), 'restore riporta le categorie applicate');

  let cfg = (await api('/api/config')).body;
  const a = cfg.lists.find(l=>l.id==='l_a');
  ok(JSON.stringify(a.options.order) === JSON.stringify(['X', 'Y']), 'ordine ripristinato da v1');
  ok(a.options.renames.X === 'Nuovo nome', 'i nomi (categoria non scelta) restano quelli nuovi');
  ok(cfg.settings.addonName === 'WiseM3U-due', 'impostazioni generali non toccate');
  hist = (await api('/api/history')).body.entries;
  ok(hist.length === 3 && hist[0].reason === 'ripristino cronologia', 'il ripristino crea un nuovo stato annullabile');

  // ripristino impostazioni + elenco liste da v1
  const v1 = hist.find(e=>e.id === idV1);
  ok(!!v1, 'snapshot v1 ancora presente');
  r = await api(`/api/history/${idV1}/restore`, { method:'POST', body: JSON.stringify({
    settings: true, lists: true,
  }) });
  ok(r.status === 200, 'ripristino impostazioni+liste ok');
  cfg = (await api('/api/config')).body;
  ok(cfg.settings.addonName === 'WiseM3U-test', 'impostazioni generali ripristinate');
  ok(cfg.settings.token === TOKEN, 'il token admin NON viene ripristinato (resta quello attuale)');
  ok(cfg.lists.find(l=>l.id==='l_b').name === 'Lista B', 'nome lista ripristinato');

  // categorie vuote / id inesistente
  r = await api(`/api/history/${idV1}/restore`, { method:'POST', body: '{}' });
  ok(r.status === 400, 'nessuna categoria -> 400');
  r = await api('/api/history/nonesiste/restore', { method:'POST', body: JSON.stringify({ options: ['order'] }) });
  ok(r.status === 404, 'snapshot inesistente -> 404');
  r = await api('/api/history/../config/restore', { method:'POST', body: JSON.stringify({ options: ['order'] }) });
  ok(r.status === 404, 'id non valido -> 404');

  // pulizia manuale non prevista: i file restano sul volume
  const files = fs.readdirSync(path.join(dir, 'history')).filter(f=>f.endsWith('.json'));
  ok(files.length >= 3, `snapshot su disco (${files.length})`);

  app.kill();
  console.log('');
  console.log(fail === 0 ? 'TUTTI I TEST CRONOLOGIA OK' : `${fail} TEST CRONOLOGIA FALLITI`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e=>{ console.error(e); process.exit(1); });
