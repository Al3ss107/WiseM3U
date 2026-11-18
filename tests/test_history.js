#!/usr/bin/env node
'use strict';
/**
 * Configuration history: automatic snapshots, dedupe, per-list filter,
 * selective restore by category and admin token protection.
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const REPO = path.resolve(__dirname, '..');
const { defaultListOptions, defaultConfig, normalizeConfig, normalizeList } = require(path.join(REPO, 'src', 'config.js'));

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

  // defaults and one-time migration for existing configurations
  ok(defaultListOptions().userAgent === '', 'new list: custom User-Agent empty by default');
  ok(defaultListOptions().dedupe === false, 'new list: duplicate removal off by default');
  ok(defaultListOptions().protocols.ace === false, 'new list: AceStream off by default');
  ok(defaultConfig().settings.dedupeGlobal === false, 'global duplicate removal off by default');

  const legacy = normalizeConfig({
    version: 1,
    settings: { dedupeGlobal: true, userAgent: 'OldUA/1' },
    lists: [{ id: 'legacy', url: 'http://127.0.0.1:9/x.m3u', options: { dedupe: true, userAgent: 'OldUA/1', protocols: { http: true, ace: true } } }],
  });
  ok(legacy.lists[0].options.userAgent === '', 'migration: auto-copied User-Agent cleared');
  ok(legacy.lists[0].options.dedupe === false && legacy.settings.dedupeGlobal === false, 'migration: duplicate removal defaults off');
  ok(legacy.lists[0].options.protocols.ace === false && legacy.lists[0].options.protocols.http === true, 'migration: only AceStream disabled');

  const keptCfg = normalizeConfig({
    version: 2,
    settings: { dedupeGlobal: true },
    lists: [{ id: 'kept', url: 'http://127.0.0.1:9/x.m3u', options: { dedupe: true, userAgent: 'Mine/1', protocols: { http: true, ace: true } } }],
  });
  ok(keptCfg.lists[0].options.userAgent === 'Mine/1' && keptCfg.lists[0].options.dedupe === true && keptCfg.lists[0].options.protocols.ace === true, 'version 2: explicit user choices preserved');

  const bareProxy = normalizeList({ id: 'proxy', url: 'http://127.0.0.1:9/x.m3u', options: { easyProxy: '192.168.1.5:7860' } });
  ok(bareProxy.options.easyProxy === 'http://192.168.1.5:7860', 'EasyProxy: bare IP/DNS gets http://');

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
  ok(up, 'server started');
  if (!up){ app.kill(); process.exit(1); }

  // ---- configuration page: lightweight HTML + external CSS/JS assets ----
  const pageRes = await fetch(`${BASE}/configure`);
  const pageHtml = await pageRes.text();
  ok(pageRes.status === 200, 'page /configure served');
  ok(/name="wm-ui-version" content="\d+\.\d+\.\d+"/.test(pageHtml), 'version injected into meta');
  ok(!pageHtml.includes('__WM_UI_VERSION__'), 'no residual version placeholder');
  ok(pageHtml.includes('/configure.css') && pageHtml.includes('/configure.js'), 'page linked to external CSS and JS');
  ok(pageHtml.includes('id="s_refreshMinutes"') && !pageHtml.includes('s_cacheTtlMinutes') && !pageHtml.includes('s_autoRefreshMinutes'), 'settings expose one refresh interval only');
  ok(pageHtml.includes('id="manifestLink"') && pageHtml.includes('id="m3uLink"'), 'header exposes copyable manifest and m3u links');
  ok(!pageHtml.includes('channelsLink') && !pageHtml.includes('channels.json'), 'channels.json link removed from the header');
  ok(!pageHtml.includes('>healthz<'), 'healthz link removed from the header');
  ok(!pageHtml.includes('⏸') && !pageHtml.includes('⭳') && !pageHtml.includes('🔎'), 'log controls use text labels without glyphs');
  ok(pageHtml.includes('id="activeModal"'), 'active playlists modal is present');
  ok(pageHtml.includes('<h2 class="secttl" data-collapsed="0"><span class="n">3</span> Your lists</h2>'), 'lists section is collapsible');
  ok(!pageHtml.includes('btnCopyManifest') && !pageHtml.includes('btnCopyM3u'), 'old copy buttons removed with section 3');
  ok(!pageHtml.includes('Connect Nuvio, Stremio'), 'connect section removed');
  ok(pageHtml.includes('<span class="n">3</span> Your lists'), 'sections renumbered after removing section 3');
  ok(!pageHtml.includes('btnReload') && !pageHtml.includes('fabReload'), 'reload buttons removed');
  ok(!pageHtml.includes('<style>') && !pageHtml.includes('<script>'), 'page without inline CSS/JS');
  const cssRes = await fetch(`${BASE}/configure.css`);
  ok(cssRes.status === 200 && /text\/css/.test(cssRes.headers.get('content-type') || ''), 'configure.css served');
  const jsRes = await fetch(`${BASE}/configure.js`);
  const jsText = await jsRes.text();
  ok(jsRes.status === 200 && /javascript/.test(jsRes.headers.get('content-type') || ''), 'configure.js served');
  ok(jsText.includes('data-refresh-custom-box') && jsText.includes('data-sdhandle'), 'custom interval and list drag handle rendered by the UI');
  ok(jsText.includes('Copiato manifest') && jsText.includes('Copiato m3u'), 'header links copy their URL');
  ok(jsText.includes('data-active-count') && jsText.includes('openActiveModal'), 'active playlist count opens a preview modal');
  ok(jsText.includes('data-copyurl'), 'list URL lines copy their link');
  ok(jsText.includes('wm-ui-version') && !jsText.includes('__WM_UI_VERSION__'), 'JS reads the version from meta');

  // v1: list A with order [X,Y], list B
  const listA = mkList('l_a', 'List A', { order: ['X', 'Y'], renames: { X: 'Old name' } });
  const listB = mkList('l_b', 'List B');
  let r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: { addonName: 'WiseM3U-test', token: 'legacy', publicBaseUrl: 'https://old.example' }, lists: [listA, listB], reason: 'first version',
  }) });
  ok(r.status === 200, 'v1 saved');

  let hist = (await api('/api/history')).body.entries;
  ok(hist.length === 1, `first snapshot recorded (${hist.length})`);
  ok(hist[0].reason === 'first version', 'snapshot reason preserved');
  const idV1 = hist[0].id;

  await sleep(15);

  // v2: changes order, names, list B name and settings
  const listA2 = mkList('l_a', 'List A', { order: ['Y', 'X'], renames: { X: 'New name' } });
  const listB2 = mkList('l_b', 'List B renamed');
  r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: { addonName: 'WiseM3U-due' }, lists: [listA2, listB2], reason: 'second version',
  }) });
  ok(r.status === 200, 'v2 saved');
  await sleep(15);

  // identical save: no new snapshot (dedupe). The config read back from the
  // server (with createdAt) is deferred, exactly as the UI does.
  const cfgNow = (await api('/api/config')).body;
  await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: cfgNow.settings, lists: cfgNow.lists, reason: 'identico',
  }) });
  hist = (await api('/api/history')).body.entries;
  ok(hist.length === 2, `identical save does not create a snapshot (${hist.length})`);
  ok(hist[0].reason === 'second version', 'order: most recent first');
  const changes = hist[0].changes;
  ok(changes.settings === true, 'diff detects general settings');
  ok(changes.lists === true, 'diff detects a list name');
  ok((changes.options.l_a || []).includes('order'), 'diff detects the order of l_a');
  ok((changes.options.l_a || []).includes('names'), 'diff detects the names of l_a');

  // filter by list
  const filtered = (await api('/api/history?list=l_b')).body.entries;
  ok(filtered.length >= 1 && filtered.every(e=>!e.changes.options.l_a || Object.keys(e.changes.options).length === 0 || e.changes.lists),
     'filter by list: no differences for l_a');
  const onlyA = (await api('/api/history?list=l_a')).body.entries;
  ok(onlyA.length === 2, `l_a filter shows the states that change it (${onlyA.length})`);

  // restore only the order of l_a from snapshot v1
  r = await api(`/api/history/${idV1}/restore`, { method:'POST', body: JSON.stringify({
    listId: 'l_a', options: ['order'],
  }) });
  ok(r.status === 200 && r.body.ok, 'selective restore responds ok');
  ok(Array.isArray(r.body.restored.options.l_a), 'restore returns the applied categories');

  let cfg = (await api('/api/config')).body;
  const a = cfg.lists.find(l=>l.id==='l_a');
  ok(JSON.stringify(a.options.order) === JSON.stringify(['X', 'Y']), 'order restored from v1');
  ok(a.options.renames.X === 'New name', 'names (unselected category) stay the new ones');
  ok(cfg.settings.addonName === 'WiseM3U-due', 'general settings untouched');
  hist = (await api('/api/history')).body.entries;
  ok(hist.length === 3 && hist[0].reason === 'history restore', 'restore creates a new undoable state');

  // restore settings + list set from v1
  const v1 = hist.find(e=>e.id === idV1);
  ok(!!v1, 'snapshot v1 still present');
  r = await api(`/api/history/${idV1}/restore`, { method:'POST', body: JSON.stringify({
    settings: true, lists: true,
  }) });
  ok(r.status === 200, 'settings+lists restore ok');
  cfg = (await api('/api/config')).body;
  ok(cfg.settings.addonName === 'WiseM3U-test', 'general settings restored');
  ok(!('token' in cfg.settings) && !('publicBaseUrl' in cfg.settings), 'legacy token/public URL are dropped');
  ok(cfg.lists.find(l=>l.id==='l_b').name === 'List B', 'list name restored');

  // categorie vuote / id inesistente
  r = await api(`/api/history/${idV1}/restore`, { method:'POST', body: '{}' });
  ok(r.status === 400, 'no category -> 400');
  r = await api('/api/history/nonesiste/restore', { method:'POST', body: JSON.stringify({ options: ['order'] }) });
  ok(r.status === 404, 'nonexistent snapshot -> 404');
  r = await api('/api/history/../config/restore', { method:'POST', body: JSON.stringify({ options: ['order'] }) });
  ok(r.status === 404, 'invalid id -> 404');

  // ---- revision: saves based on an old state -> 409 ----
  let cfgRev = (await api('/api/config')).body;
  ok(typeof cfgRev.rev === 'number' && cfgRev.rev > 0, 'config exposes the revision');
  const rev0 = cfgRev.rev;
  r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: cfgRev.settings, lists: cfgRev.lists, reason:'identical with rev', baseRev: rev0,
  }) });
  ok(r.status === 200 && r.body.rev === rev0, 'correct rev and no change: revision unchanged');
  r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: cfgRev.settings, lists: cfgRev.lists, reason:'old state', baseRev: rev0 - 1,
  }) });
  ok(r.status === 409 && r.body.rev === rev0 && r.body.config && r.body.config.settings,
    'old rev -> 409 with server state');
  r = await api('/api/config', { method:'PUT', body: JSON.stringify({
    settings: { ...cfgRev.settings, addonName:'WiseM3U-rev' }, lists: cfgRev.lists, reason:'change with rev', baseRev: rev0,
  }) });
  ok(r.status === 200 && r.body.rev > rev0, 'correct rev + change -> new revision');

  // ---- undo of destructive operations ----
  let beforeU = (await api('/api/config')).body;
  const delBefore = beforeU.lists.find((l)=>l.id === 'l_b').options.deletedBranches || [];
  r = await api('/api/lists/l_b/delete', { method:'POST', body: JSON.stringify({ paths:['X'] }) });
  ok(r.status === 200 && r.body.undo && r.body.undo.id, 'deletion provides the undo point');
  ok(((await api('/api/config')).body.lists.find((l)=>l.id === 'l_b').options.deletedBranches || []).includes('X'),
    'deleted playlist goes to trash');
  const undoDel = await api(`/api/history/${encodeURIComponent(r.body.undo.id)}/undo`, {
    method:'POST', body: JSON.stringify({ listIds: r.body.undo.listIds }),
  });
  ok(undoDel.status === 200, 'deletion undo responds ok');
  let afterU = (await api('/api/config')).body;
  ok(JSON.stringify(afterU.lists.find((l)=>l.id === 'l_b').options.deletedBranches || []) === JSON.stringify(delBefore),
    'undo restores the trash to the previous state');

  const nameB = afterU.lists.find((l)=>l.id === 'l_b').name;
  r = await api('/api/lists/l_b', { method:'DELETE' });
  ok(((await api('/api/config')).body.lists.some((l)=>l.id === 'l_b') === false), 'list actually deleted');
  ok(r.body.undo && r.body.undo.id, 'list deletion provides the undo point');
  const undoList = await api(`/api/history/${encodeURIComponent(r.body.undo.id)}/undo`, {
    method:'POST', body: JSON.stringify({ listIds: r.body.undo.listIds }),
  });
  ok(undoList.status === 200, 'list deletion undo responds ok');
  afterU = (await api('/api/config')).body;
  const backB = afterU.lists.find((l)=>l.id === 'l_b');
  ok(!!backB && backB.name === nameB, 'undo recreates the deleted list with the same name');

  // undoable empty trash (items become restorable again)
  r = await api('/api/lists/l_b/delete', { method:'POST', body: JSON.stringify({ path:'Y' }) });
  const purgedBefore = JSON.stringify(((await api('/api/config')).body.lists.find((l)=>l.id === 'l_b').options.purgedBranches) || []);
  r = await api('/api/lists/l_b/emptytrash', { method:'POST', body:'{}' });
  ok(r.status === 200 && r.body.undo && r.body.undo.id, 'empty trash provides the undo point');
  ok(((await api('/api/config')).body.lists.find((l)=>l.id === 'l_b').options.purgedBranches || []).includes('Y'),
    'emptied item is permanently deleted');
  const undoTrash = await api(`/api/history/${encodeURIComponent(r.body.undo.id)}/undo`, {
    method:'POST', body: JSON.stringify({ listIds: r.body.undo.listIds }),
  });
  ok(undoTrash.status === 200, 'empty trash undo responds ok');
  afterU = (await api('/api/config')).body;
  ok(JSON.stringify(afterU.lists.find((l)=>l.id === 'l_b').options.purgedBranches || []) === purgedBefore,
    'empty trash undo re-enables items in the trash');

  // ---- checkpoint nominati ----
  const cpBefore = (await api('/api/history')).body.entries.length;
  r = await api('/api/history/checkpoints', { method:'POST', body: JSON.stringify({ name:'before merge' }) });
  ok(r.status === 200 && r.body.entry && r.body.entry.id, 'checkpoint created');
  hist = (await api('/api/history')).body.entries;
  const cp = hist.find((e)=>e.id === r.body.entry.id);
  ok(!!cp && cp.name === 'before merge', 'checkpoint preserves the name');
  ok(hist.length === cpBefore + 1, 'checkpoint creates an entry even with unchanged config');
  r = await api('/api/history/checkpoints', { method:'POST', body:'{}' });
  ok(r.status === 400, 'checkpoint without name -> 400');

  // ---- retention: named checkpoints do not expire like automatic states ----
  const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-hist-ret-'));
  const script = `
    const h = require(${JSON.stringify(path.join(REPO, 'src', 'history.js'))});
    const cfg = (n) => ({ settings: { addonName: 'x' + n }, lists: [] });
    const wait = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* ms distinti */ } };
    h.record(cfg(1), { reason: 'v1' });
    wait(3);
    h.checkpoint(cfg(1), 'old');
    for (let n = 2; n <= 8; n++) { wait(3); h.record(cfg(n), { reason: 'v' + n }); }
    console.log(JSON.stringify(h.listEntries({ limit: 50 }).map((e) => ({ name: e.name, reason: e.reason }))));
  `;
  const raw = execFileSync('node', ['-e', script], {
    env: { ...process.env, HISTORY_DIR: hdir, HISTORY_MAX: '5', HISTORY_DAYS: '1' },
    encoding: 'utf8',
  });
  const kept = JSON.parse(raw.trim().split('\n').pop());
  ok(kept.length === 6, `retention: 5 automatic states + the checkpoint (${kept.length})`);
  ok(kept.some((e) => e.name === 'old'), 'named checkpoint survives retention');
  ok(kept.filter((e) => !e.name).map((e) => e.reason).join(',') === 'v8,v7,v6,v5,v4', 'the most recent automatic states remain');

  // manual cleanup not provided: files stay on the volume
  const files = fs.readdirSync(path.join(dir, 'history')).filter(f=>f.endsWith('.json'));
  ok(files.length >= 3, `snapshot on disk (${files.length})`);

  app.kill();
  console.log('');
  console.log(fail === 0 ? `ALL HISTORY TESTS PASSED (${pass})` : `${fail} HISTORY TESTS FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e=>{ console.error(e); process.exit(1); });
