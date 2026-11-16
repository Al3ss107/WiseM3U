#!/usr/bin/env node
'use strict';
/**
 * Cronologia configurazione: snapshot automatici, dedupe, filtro per lista,
 * ripristino selettivo per categorie e protezione del token admin.
 */
const { spawn, execFileSync } = require('child_process');
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

  // ---- pagina configurazione: HTML leggero + asset CSS/JS esterni ----
  const pageRes = await fetch(`${BASE}/configure`);
  const pageHtml = await pageRes.text();
  ok(pageRes.status === 200, 'pagina /configure servita');
  ok(/name="wm-ui-version" content="\d+\.\d+\.\d+"/.test(pageHtml), 'versione iniettata nella meta');
  ok(!pageHtml.includes('__WM_UI_VERSION__'), 'nessun placeholder versione residuo');
  ok(pageHtml.includes('/configure.css') && pageHtml.includes('/configure.js'), 'pagina collegata a CSS e JS esterni');
  ok(!pageHtml.includes('<style>') && !pageHtml.includes('<script>'), 'pagina senza CSS/JS inline');
  const cssRes = await fetch(`${BASE}/configure.css`);
  ok(cssRes.status === 200 && /text\/css/.test(cssRes.headers.get('content-type') || ''), 'configure.css servito');
  const jsRes = await fetch(`${BASE}/configure.js`);
  const jsText = await jsRes.text();
  ok(jsRes.status === 200 && /javascript/.test(jsRes.headers.get('content-type') || ''), 'configure.js servito');
  ok(jsText.includes('wm-ui-version') && !jsText.includes('__WM_UI_VERSION__'), 'il JS legge la versione dalla meta');

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

  // ---- revisione: salvataggi basati su uno stato vecchio -> 409 ----
  let cfgRev = (await api('/api/config')).body;
  ok(typeof cfgRev.rev === 'number' && cfgRev.rev > 0, 'la config espone la revisione');
  const rev0 = cfgRev.rev;
  r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: cfgRev.settings, lists: cfgRev.lists, reason:'identico con rev', baseRev: rev0,
  }) });
  ok(r.status === 200 && r.body.rev === rev0, 'rev corretta e nessuna modifica: revisione ferma');
  r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: cfgRev.settings, lists: cfgRev.lists, reason:'stato vecchio', baseRev: rev0 - 1,
  }) });
  ok(r.status === 409 && r.body.rev === rev0 && r.body.config && r.body.config.settings,
    'rev vecchia -> 409 con lo stato del server');
  r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: { ...cfgRev.settings, addonName:'WiseM3U-rev' }, lists: cfgRev.lists, reason:'modifica con rev', baseRev: rev0,
  }) });
  ok(r.status === 200 && r.body.rev > rev0, 'rev corretta + modifica -> nuova revisione');

  // ---- undo delle operazioni distruttive ----
  let beforeU = (await api('/api/config')).body;
  const delBefore = beforeU.lists.find((l)=>l.id === 'l_b').options.deletedBranches || [];
  r = await api('/api/lists/l_b/delete', { method:'POST', body: JSON.stringify({ paths:['X'] }) });
  ok(r.status === 200 && r.body.undo && r.body.undo.id, 'eliminazione fornisce il punto di undo');
  ok(((await api('/api/config')).body.lists.find((l)=>l.id === 'l_b').options.deletedBranches || []).includes('X'),
    'la playlist eliminata finisce nel cestino');
  const undoDel = await api(`/api/history/${encodeURIComponent(r.body.undo.id)}/undo`, {
    method:'POST', body: JSON.stringify({ listIds: r.body.undo.listIds }),
  });
  ok(undoDel.status === 200, 'undo dell eliminazione risponde ok');
  let afterU = (await api('/api/config')).body;
  ok(JSON.stringify(afterU.lists.find((l)=>l.id === 'l_b').options.deletedBranches || []) === JSON.stringify(delBefore),
    'undo riporta il cestino allo stato precedente');

  const nameB = afterU.lists.find((l)=>l.id === 'l_b').name;
  r = await api('/api/lists/l_b', { method:'DELETE' });
  ok(((await api('/api/config')).body.lists.some((l)=>l.id === 'l_b') === false), 'lista eliminata davvero');
  ok(r.body.undo && r.body.undo.id, 'eliminazione lista fornisce il punto di undo');
  const undoList = await api(`/api/history/${encodeURIComponent(r.body.undo.id)}/undo`, {
    method:'POST', body: JSON.stringify({ listIds: r.body.undo.listIds }),
  });
  ok(undoList.status === 200, 'undo dell eliminazione lista risponde ok');
  afterU = (await api('/api/config')).body;
  const backB = afterU.lists.find((l)=>l.id === 'l_b');
  ok(!!backB && backB.name === nameB, 'undo ricrea la lista eliminata con lo stesso nome');

  // svuota cestino annullabile (le voci tornano ripristinabili)
  r = await api('/api/lists/l_b/delete', { method:'POST', body: JSON.stringify({ path:'Y' }) });
  const purgedBefore = JSON.stringify(((await api('/api/config')).body.lists.find((l)=>l.id === 'l_b').options.purgedBranches) || []);
  r = await api('/api/lists/l_b/emptytrash', { method:'POST', body:'{}' });
  ok(r.status === 200 && r.body.undo && r.body.undo.id, 'svuota cestino fornisce il punto di undo');
  ok(((await api('/api/config')).body.lists.find((l)=>l.id === 'l_b').options.purgedBranches || []).includes('Y'),
    'la voce svuotata risulta eliminata definitivamente');
  const undoTrash = await api(`/api/history/${encodeURIComponent(r.body.undo.id)}/undo`, {
    method:'POST', body: JSON.stringify({ listIds: r.body.undo.listIds }),
  });
  ok(undoTrash.status === 200, 'undo dello svuotamento risponde ok');
  afterU = (await api('/api/config')).body;
  ok(JSON.stringify(afterU.lists.find((l)=>l.id === 'l_b').options.purgedBranches || []) === purgedBefore,
    'undo dello svuotamento riaccende le voci nel cestino');

  // ---- checkpoint nominati ----
  const cpBefore = (await api('/api/history')).body.entries.length;
  r = await api('/api/history/checkpoints', { method:'POST', body: JSON.stringify({ name:'prima del merge' }) });
  ok(r.status === 200 && r.body.entry && r.body.entry.id, 'checkpoint creato');
  hist = (await api('/api/history')).body.entries;
  const cp = hist.find((e)=>e.id === r.body.entry.id);
  ok(!!cp && cp.name === 'prima del merge', 'il checkpoint conserva il nome');
  ok(hist.length === cpBefore + 1, 'il checkpoint crea una voce anche a config invariata');
  r = await api('/api/history/checkpoints', { method:'POST', body:'{}' });
  ok(r.status === 400, 'checkpoint senza nome -> 400');

  // ---- retention: i checkpoint nominati non scadono come gli stati automatici ----
  const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-hist-ret-'));
  const script = `
    const h = require(${JSON.stringify(path.join(REPO, 'src', 'history.js'))});
    const cfg = (n) => ({ settings: { addonName: 'x' + n }, lists: [] });
    const wait = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* ms distinti */ } };
    h.record(cfg(1), { reason: 'v1' });
    wait(3);
    h.checkpoint(cfg(1), 'vecchio');
    for (let n = 2; n <= 8; n++) { wait(3); h.record(cfg(n), { reason: 'v' + n }); }
    console.log(JSON.stringify(h.listEntries({ limit: 50 }).map((e) => ({ name: e.name, reason: e.reason }))));
  `;
  const raw = execFileSync('node', ['-e', script], {
    env: { ...process.env, HISTORY_DIR: hdir, HISTORY_MAX: '5', HISTORY_DAYS: '1' },
    encoding: 'utf8',
  });
  const kept = JSON.parse(raw.trim().split('\n').pop());
  ok(kept.length === 6, `retention: 5 stati automatici + il checkpoint (${kept.length})`);
  ok(kept.some((e) => e.name === 'vecchio'), 'il checkpoint nominato sopravvive alla retention');
  ok(kept.filter((e) => !e.name).map((e) => e.reason).join(',') === 'v8,v7,v6,v5,v4', 'restano gli stati automatici piu recenti');

  // pulizia manuale non prevista: i file restano sul volume
  const files = fs.readdirSync(path.join(dir, 'history')).filter(f=>f.endsWith('.json'));
  ok(files.length >= 3, `snapshot su disco (${files.length})`);

  app.kill();
  console.log('');
  console.log(fail === 0 ? `TUTTI I TEST CRONOLOGIA OK (${pass})` : `${fail} TEST CRONOLOGIA FALLITI`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e=>{ console.error(e); process.exit(1); });
