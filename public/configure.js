'use strict';

/* WiseM3U — configuration page: browser-side logic */
// version injected by the server into the meta tag (never hardcoded in the source)
const WM_UI_VERSION = (document.querySelector('meta[name="wm-ui-version"]') || {}).content || '';
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
let CFG = null;
let TREES = {};   // id -> { meta, fetchedAt, branches:[{path,name,displayName,stations,image,enabled}] }

const PROTO_LABEL = { http:'HTTP/HLS', ace:'AceStream', rtmp:'RTMP', rtsp:'RTSP', other:'other' };

// Common User-Agent strings suggested per list. The input stays free-form:
// these are only shortcuts for panels/CDNs that block the WiseM3U UA.
const UA_PRESETS = [
  { name: 'Default (WiseM3U)', value: '', note: 'Chrome 126 + WiseM3U/…' },
  { name: 'Chrome · Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', note: 'Chrome/126 · Windows' },
  { name: 'Chrome · Android', value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', note: 'Chrome/126 · Android 14' },
  { name: 'Safari · macOS', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', note: 'Safari/17.5 · macOS' },
  { name: 'Firefox · Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0', note: 'Firefox/127 · Windows' },
  { name: 'Edge · Windows', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', note: 'Edg/126 · Windows' },
  { name: 'VLC', value: 'VLC/3.0.21 LibVLC/3.0.21', note: 'LibVLC/3.0.21' },
  { name: 'Kodi', value: 'Kodi/20.5 (Windows NT 10.0; Win64; x64) App_Bitness/64 Version/20.5.0', note: 'Kodi/20.5' },
  { name: 'okhttp', value: 'okhttp/4.12.0', note: 'OkHttp/4.12' },
  { name: 'IPTV Smarters', value: 'IPTVSmartersPro', note: 'IPTV Smarters Pro' },
  { name: 'FFmpeg / Lavf', value: 'Lavf/60.16.100', note: 'Lavf/60.16.100' },
];

function toast(msg, ms=2600, opts={}){
  const t = $('#toast');
  if (!t) return;
  clearTimeout(t._h);
  const hide = () => { clearTimeout(t._h); t.classList.remove('show'); };
  t.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  const act = opts && opts.action;
  if (act && typeof act.onClick === 'function'){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = act.label || '↩ Undo';
    b.addEventListener('click', () => { hide(); act.onClick(); });
    t.appendChild(b);
    t.classList.add('has-act');
  } else {
    t.classList.remove('has-act');
  }
  t.classList.add('show');
  if (ms > 0) t._h = setTimeout(hide, ms);
}

/** Reloads the UI after an undo: config, trees, trash and history. */
async function reloadAfterUndo(ids){
  await loadConfig();
  for (const id of ids || []){
    if (!CFG.lists.some((l)=>l.id === id)) continue;
    if (TRASHOPEN.has(id)) await refreshTrash(id);
  }
  renderLists();
  loadHistory();
}

/** Shows the toast with «Undo»; if the server did not provide a restore
 *  point (null undo) it shows the normal message. */
function showUndo(msg, undo){
  if (!undo || !undo.id){ toast(msg); return; }
  toast(msg, 9000, { action: { label: 'Cancel', onClick: async () => {
    try {
      const r = await api(`/api/history/${encodeURIComponent(undo.id)}/undo`, {
        method: 'POST',
        body: JSON.stringify({ listIds: undo.listIds || [] }),
      });
      toast('Operation undone ✔');
      await reloadAfterUndo(r.lists || undo.listIds || []);
    } catch (e){ toast('Error: ' + e.message, 5000); }
  }}});
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function apiUrl(p){
  const a = localStorage.getItem('wisem3u_admin') || '';
  const parts = [];
  if (p.includes('?')) parts.push(p.split('?')[1]);
  if (a) parts.push(`token=${encodeURIComponent(a)}`);
  return parts.length ? `${p.split('?')[0]}?${parts.join('&')}` : p;
}
const sleep = (ms) => new Promise(r=>setTimeout(r, ms));

/* ---------------- branches: local state ---------------- */
/* The displayed order is the server's (already sorted by options.order).
   Local changes (enable/disable, rename, move) update
   options.disabledPaths / options.renames / options.order; the final
   save goes through PUT /api/config like everything else. */

function branchesOf(id){ return (TREES[id] && TREES[id].branches) || null; }

function branchEnabled(list, path){
  return !(list.options.disabledPaths || []).includes(path);
}
function setBranchEnabled(list, path, on){
  const dis = new Set(list.options.disabledPaths || []);
  if (on) dis.delete(path); else dis.add(path);
  list.options.disabledPaths = Array.from(dis);
}
function setBranchName(list, path, original, value){
  const v = String(value || '').trim();
  list.options.renames = list.options.renames || {};
  if (!v || v === original) delete list.options.renames[path];
  else list.options.renames[path] = v;
}
function branchDisplayName(list, b){
  return (list.options.renames && list.options.renames[b.path]) || b.name;
}
function rebuildOrder(list){
  const bs = branchesOf(list.id);
  if (bs) list.options.order = bs.map(b=>b.path);
}
/* ---------------- render ---------------- */

const EXPANDED = new Set();  // "listId|path" of branches with the channel list open
const CHANS = {};            // "listId|path" -> [{name, shown, enabled}]
const BRSQ = {};             // listId -> playlist filter text (persists across re-renders)
const BRONLY = new Set();    // listId with "Show enabled" active
const OPEN_LISTS = new Set();      // open list cards (all closed by default)
const PLAYLISTS_OPEN = new Set();  // ids of lists with the "List playlists" block open

/** Playlists (non-personal branches) that match the current tab filter.
 *  This is the scope for All / None / Delete selected: during
 *  a search, hidden playlists are not touched. */
function visibleBranches(list){
  const q = (BRSQ[list.id] || '').trim().toLowerCase();
  const onlyActive = BRONLY.has(list.id);
  return (branchesOf(list.id) || []).filter((b)=>{
    if (onlyActive && !branchEnabled(list, b.path)) return false;
    if (!q) return true;
    return (b.name + ' ' + branchDisplayName(list, b)).toLowerCase().includes(q);
  });
}

function renderBranches(list){
  const bs = branchesOf(list.id);
  const st = (list.state && list.state.status) || 'idle';
  if (!bs){
    if (st === 'fetching') return '<div class="hint" style="margin-top:10px">⏳ Downloading the list… the playlist section appears as soon as it is ready.</div>';
    if (st === 'error'){
      const fatal = !!(list.state && list.state.fatal);
      // "inherent" error (URL pointing to a video, an HTML page, a huge playlist):
      // retrying yields the same error, better to say it clearly
      return `<div class="err">Download failed: ${esc((list.state&&list.state.error)||'')} — ${
        fatal
          ? 'this error <b>cannot be fixed with Refresh</b>: fix the list URL and save.'
          : 'retry with <b>Refresh</b>.'
      }</div>`;
    }
    return '<div class="hint" style="margin-top:10px">Branches not loaded: press <b>Refresh</b> to download the list.</div>';
  }
  const q = (BRSQ[list.id] || '').trim().toLowerCase();
  const onlyActive = BRONLY.has(list.id);
  const visible = bs.filter((b)=>
    (!onlyActive || branchEnabled(list, b.path)) &&
    (!q || (b.name + ' ' + branchDisplayName(list, b)).toLowerCase().includes(q))
  );
  const rows = visible.map((b)=>{
    const on = branchEnabled(list, b.path);
    const shown = branchDisplayName(list, b);
    const renamed = shown !== b.name;
    const open = EXPANDED.has(`${list.id}|${b.path}`);
    const custom = !!b.custom;
    let html = `<div class="brow ${on?'':'off'}" draggable="true" data-path="${esc(b.path)}" data-name="${esc(b.name)}" data-search="${esc((b.name+' '+shown).toLowerCase())}">
      <span class="bhandle" title="Drag to reorder">☰</span>
      ${custom
        ? '<input type="checkbox" checked disabled title="Custom group: move the channels elsewhere to empty it">'
        : `<input type="checkbox" data-cb="${esc(b.path)}" ${on?'checked':''} title="Include/exclude this branch">`}
      <input class="bname ${renamed?'renamed':''}" type="text" value="${esc(shown)}" placeholder="${esc(b.name)}" title="Branch name (becomes the genre in the catalog)">
      ${custom ? '<span class="badge">custom</span>' : ''}
      <span class="cnt bcount">${b.stations} channels${b.hidden?` <span style="color:var(--warn)">(${b.hidden} excluded)</span>`:''}</span>
      <button class="expbtn" data-exp="${esc(b.path)}" title="Manage individual channels">${open?'▾ channels':'\u25b8 channels'}</button>
      <button class="ghost small" data-bdel="${esc(b.path)}" title="Delete this playlist (recoverable from trash)">✕</button>
    </div>`;
    if (open) html += renderChannels(list, b);
    return html;
  }).join('');

  const purgedCh = new Set(list.options.purgedChannels || []);
  const purgedBr = new Set(list.options.purgedBranches || []);
  const nTrash = (list.options.deletedChannels || []).filter((k)=>!purgedCh.has(k)).length
    + (list.options.deletedBranches || []).filter((p)=>!purgedBr.has(p)).length;
  const plOpen = PLAYLISTS_OPEN.has(list.id);
  return `<div class="plwrap${plOpen ? '' : ' collapsed'}">
  <div class="plhead">
    <h2 data-ptgl="${esc(list.id)}" role="button" tabindex="0" aria-expanded="${plOpen}"
      title="${plOpen ? 'Collapse the playlists' : 'Expand the playlists'}"><span class="ttl">List playlists</span>${
      visible.length !== bs.length ? ` <span class="badge" title="Playlists shown with active filters">${visible.length} shown</span>` : ''
    }<span class="sectgl" aria-hidden="true">${plOpen ? '\u25be' : '\u25b8'}</span></h2>
    <div class="pltools">
      <button class="ghost small ${onlyActive?'on':''}" data-act="onlyactive"
        title="Show only enabled playlists (and, with a search, only matching ones)">👁 Show enabled</button>
      <input type="text" data-act="filter" value="${esc(BRSQ[list.id] || '')}" placeholder="🔎 Filter playlists…">
      <button class="ghost small" data-act="all" title="Enable all playlists">✓ All</button>
      <button class="ghost small" data-act="none" title="Disable all playlists">✗ None</button>
      <button class="ghost small" data-act="delsel" title="Move all checked playlists to trash (recoverable)">✕ Delete selected</button>
      <button class="ghost small" data-act="trash" title="Deleted channels and playlists: restore them here">🗑 Trash${nTrash ? ` (${nTrash})` : ''}</button>
    </div>
  </div>
  ${bs.length ? '' : '<div class="hint" style="margin-top:10px">No playlist (branch with channels) found in this list.</div>'}
  <details class="help">
    <summary>ℹ️ How to use it: rename, reorder, channels, moves, trash</summary>
    <div class="hint" data-i18n-html="hint.usage">Every row is a playlist: check it to include it, type in the field to <b>rename</b> it, drag it by the <b>☰</b> handle to <b>reorder</b>. With <b>▸ channels</b> you open the playlist and manage <b>individual channels</b>: exclude, rename, reorder and — with the <b>group field</b> on the right — <b>move them to another playlist or a custom group</b>. Then press <b>➜</b> to move the channel to the typed or selected group, or <b>↺</b> to move it back to its original playlist. Moves are <b>saved automatically</b>; for other changes remember <b>Save configuration</b>. You can also <b>drag a channel onto another playlist</b> (even across lists) or <b>drag a playlist to the center of another row</b> to move all its channels there. The <b>✕</b> button deletes the channel or the whole playlist; to delete <b>many at once</b>, check them and press <b>✕ Delete selected</b>. Nothing is lost: everything is in the <b>🗑 Trash</b>.</div>
  </details>
  <div class="branches">
    <div class="hint brsnone" style="margin-top:10px;${visible.length ? 'display:none' : ''}">No playlist matches the filter.
      <button class="ghost small" data-act="clearfilter">Show all</button></div>
    ${rows}
  </div>
  ${TRASHOPEN.has(list.id) ? renderTrash(list) : ''}
  <datalist id="dl-${list.id}">${bs.map((b) => `<option value="${esc(b.displayName)}">`).join('')}</datalist>
  </div>`;
}

/* ---------------- trash: recoverable deleted items ---------------- */
const TRASHOPEN = new Set(); // ids of lists with the trash open
const TRASH = {};            // id -> {branches:[], channels:[]}

function renderTrash(list){
  const t = TRASH[list.id];
  if (!t) return '<div class="trash" data-trash><div class="hint">Loading trash…</div></div>';
  const br = (t.branches || []).map((b)=>`<div class="trashrow">
      <span>📁</span><b>${esc(b.name)}</b><span class="cnt">${b.stations} channels</span>
      <div class="spacer" style="flex:1"></div>
      <button class="ghost small" data-rbranch="${esc(b.path)}">↩ Restore</button>
    </div>`).join('');
  const ch = (t.channels || []).map((c)=>`<div class="trashrow">
      <span>📺</span><b>${esc(c.shown || c.name)}</b><span class="cnt">was in «${esc(c.branch)}»</span>
      <div class="spacer" style="flex:1"></div>
      <button class="ghost small" data-rchan="1" data-rpath="${esc(c.path)}" data-rname="${esc(c.name)}">↩ Restore</button>
    </div>`).join('');
  const empty = !br && !ch ? '<div class="hint">The trash is empty.</div>' : '';
  const tot = (t.branches || []).length + (t.channels || []).length;
  return `<div class="trash" data-trash>
    <div class="row" style="align-items:center;gap:8px"><b>🗑 Trash</b><span class="cnt">items deleted from this list</span>
      <div class="spacer" style="flex:1"></div>
      ${tot ? `<button class="danger small" data-etrash="1" title="Permanently delete all trash items (they will no longer be restorable)">🗑 Empty trash</button>` : ''}
    </div>
    ${empty}${br}${ch}
  </div>`;
}

async function refreshTrash(id){
  try { TRASH[id] = await api(`/api/lists/${id}/deleted`); }
  catch (_){ TRASH[id] = { branches: [], channels: [] }; }
}

function renderChannels(list, b){
  const chans = CHANS[`${list.id}|${b.path}`];
  if (!chans) return `<div class="chans" data-chans="${esc(b.path)}"><div class="hint">Loading channels…</div></div>`;
  const on = chans.filter(c=>c.enabled).length;
  const bs = branchesOf(list.id) || [];
  const rows = chans.map((c, i)=>{
    const renamed = c.shown !== c.name;
    const curB = bs.find((x) => x.path === c.cur);
    const homeB = bs.find((x) => x.path === c.home);
    const curName = curB ? curB.displayName : (String(c.cur).startsWith('@') ? String(c.cur).slice(1) : c.cur);
    return `<div class="crow ${c.enabled?'':'off'}" draggable="true" data-ci="${i}" data-cname="${esc(c.name)}" data-csearch="${esc((c.name+' '+c.shown).toLowerCase())}">
      <span class="bhandle" title="Drag to reorder">☰</span>
      <input type="checkbox" data-cch="${i}" ${c.enabled?'checked':''} title="Include/exclude this channel">
      <input class="cname ${renamed?'renamed':''}" type="text" value="${esc(c.shown)}" placeholder="${esc(c.name)}" title="Channel name (as shown in playlist and catalog)">
      ${c.from ? `<span class="cnt" style="color:var(--warn)" title="Channel moved: comes from &quot;${esc(c.from)}&quot;">from ${esc(c.from)}</span>` : ''}
      <input class="cmove ${curName !== (homeB ? homeB.displayName : '') ? 'renamed' : ''}" data-cmove="${i}" list="dl-${list.id}" value="${esc(curName)}" placeholder="${esc(homeB ? homeB.displayName : '')}" title="Channel group: choose from the list or type a new name">
      <button class="ghost small" data-capply="${i}" title="Move the channel to the typed or selected group">➜</button>
      <button class="ghost small" data-creset="${i}" title="Move the channel back to its original playlist">↺</button>
      <button class="ghost small" data-cdel="${i}" title="Delete the channel (recoverable from trash)">✕</button>
    </div>`;
  }).join('');
  return `<div class="chans" data-chans="${esc(b.path)}">
    <div class="chead">
      <input type="text" class="cfilter" placeholder="🔎 Filter channels…" data-cfilter>
      <span class="cnt ccount">${on}/${chans.length} enabled</span>
    </div>
    <div class="chead">
      <input type="text" data-cadd list="dladd-${list.id}" placeholder="Add a channel from another playlist or another list…">
      <button class="ghost small" data-caddbtn="${esc(b.path)}" title="If the channel is from another playlist of this list it is moved here; if it is from another list it is imported here and removed from the source">➕ Add</button>
    </div>
    <datalist id="dladd-${list.id}" data-dladd></datalist>
    ${rows}
  </div>`;
}

let SKIP_TREE_RELOAD = false; // the drag already holds the order in memory: do not reload it from the server

function renderLists(){
  // make containers WITH their own scroll (.branches) rebuildable too:
  // their scrollTop must be preserved explicitly, otherwise the internal rebuild
  // brings the view back to the top of that card's "Playlist"
  const sy = window.scrollY;
  const bTops = {};
  document.querySelectorAll('#lists .listcard').forEach(c=>{
    const b = c.querySelector('.branches');
    if (b) bTops[c.dataset.id] = b.scrollTop;
  });
  const root = $('#lists');
  if (!CFG.lists.length){
    root.innerHTML = `<section class="card">
      <div class="hint">No lists. Add a URL above (a WisePlay list or a <code>.m3u</code>),
      or press <b>⭐ Create custom list</b> to build a list by choosing channels and playlists from your lists.</div></section>`;
    return;
  }
  root.innerHTML = CFG.lists.map(renderListCard).join('');
  bindListEvents();
  for (const card of document.querySelectorAll('#lists .listcard')) plPopulateBranches(card);
  renderSideMenu();
  decorateCards(root);
  for (const l of CFG.lists) fillXtreamBadge(l);
  requestAnimationFrame(() => {
    if (window.scrollY !== sy) window.scrollTo(0, sy);
    document.querySelectorAll('#lists .listcard').forEach(c=>{
      const b = c.querySelector('.branches');
      if (b && bTops[c.dataset.id] != null) b.scrollTop = bTops[c.dataset.id];
    });
  });
}

/* -------- Xtream account expiry (player_api.php) -------- */

function fmtDate(iso){
  try { return new Date(iso).toLocaleDateString((window.WM_I18N && WM_I18N.locale()) || 'en', { day:'numeric', month:'short', year:'numeric' }); }
  catch(_) { return iso; }
}

/** Same policy as src/config.js: custom override, or the global default.
 *  0 means manual only. */
function effectiveListRefresh(l){
  const o = (l && l.options) || {};
  if (o.refreshMode === 'manual') return 0;
  if (o.refreshMode === 'custom'){
    const n = Math.round(Number(o.refreshMinutes));
    return Number.isFinite(n) && n > 0 ? Math.max(5, n) : 5;
  }
  const g = Math.round(Number(CFG.settings && CFG.settings.refreshMinutes));
  return Number.isFinite(g) && g > 0 ? Math.max(5, g) : 0;
}

function uiLang(){
  return (window.WM_I18N && WM_I18N.locale()) || 'en';
}

function tr(text){
  return window.WM_I18N ? WM_I18N.translate(text) : text;
}

function humanMinutes(min){
  const n = Math.max(0, Math.round(Number(min) || 0));
  try {
    const unit = (value, u) => new Intl.NumberFormat(uiLang(), { style: 'unit', unit: u, unitDisplay: 'short' }).format(value);
    if (n < 60) return unit(n, 'minute');
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(h, 'hour');
  } catch (_) {
    if (n < 60) return `${n} min`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
}

const GLOBAL_REFRESH_PRESETS = [0, 15, 30, 60, 180, 360, 720, 1440];
const LIST_REFRESH_PRESETS = [5, 15, 30, 60, 180, 360, 720, 1440];

/** Preset values for the editable interval menu. The typed value is kept in
 *  the menu even when it is not a preset, so any interval can be entered. */
function refreshPresetValues(scope, current){
  const n = Math.round(Number(current));
  const values = (scope === 'global' ? GLOBAL_REFRESH_PRESETS : LIST_REFRESH_PRESETS).slice();
  const min = scope === 'global' ? 0 : 5;
  if (String(current).trim() !== '' && Number.isFinite(n) && n >= min && !values.includes(n)) values.push(n);
  return values.sort((a, b) => a - b);
}

function refreshMenuHtml(scope, current){
  const n = Math.round(Number(current));
  return refreshPresetValues(scope, current)
    .map((v) => {
      const label = v === 0 ? tr('Manual only') : humanMinutes(v);
      const selected = n === v ? ' sel' : '';
      return `<button type="button" class="uaOpt${selected}" role="option" aria-selected="${n === v}"
        data-refresh-opt="${v}">${esc(label)}</button>`;
    })
    .join('');
}

function relativeMinutes(minutes, future = false){
  const n = Math.max(0, Number(minutes) || 0);
  const sign = future ? 1 : -1;
  try {
    const rtf = new Intl.RelativeTimeFormat(uiLang(), { numeric: 'auto' });
    if (n < 60) return rtf.format(sign * Math.round(n), 'minute');
    return rtf.format(sign * Math.round(n / 60), 'hour');
  } catch (_) {
    const txt = humanMinutes(n);
    return future ? `in ${txt}` : `${txt} ago`;
  }
}

function refreshLabel(l){
  const eff = effectiveListRefresh(l);
  return eff > 0 ? tr(`Effective: every ${humanMinutes(eff)}`) : tr('Effective: manual only');
}

function refreshMeta(l){
  if (l.kind === 'personal') return tr('Personal list');
  const s = l.state || {};
  if (!s.fetchedAt) {
    const suffix = s.status === 'fetching' ? tr('refresh in progress…') : s.error ? tr('last attempt failed') : '';
    return `${tr('Never updated')}${suffix ? ' · ' + suffix : ''}`;
  }
  const t = new Date(s.fetchedAt);
  if (Number.isNaN(t.getTime())) return tr('Never updated');
  const age = Math.max(0, (Date.now() - t.getTime()) / 60000);
  let out = `${tr('Last update:')} <b>${esc(t.toLocaleString(uiLang()))}</b> · ${relativeMinutes(age)}`;
  if (s.status === 'fetching') out += ` · ${tr('refresh in progress…')}`;
  else {
    const every = effectiveListRefresh(l);
    if (every > 0) out += ` · ${tr(`Next update: ${relativeMinutes(Math.max(0, every - age), true)}`)}`;
    else out += ` · ${tr('manual refresh')}`;
  }
  if (s.error) out += ` · ${tr('last attempt failed')}`;
  return out;
}

function updateRefreshMeta(){
  if (!CFG || !CFG.lists) return;
  for (const el of $$('[data-refreshmeta]')){
    const l = (CFG.lists || []).find(x => x.id === el.dataset.refreshmeta);
    if (l) el.innerHTML = refreshMeta(l);
  }
}

/** Refreshes only the runtime state: the configuration being edited is not
 *  touched, so background downloads show their new timestamp without a reload. */
async function pollListStates(){
  if (document.hidden || !CFG || !CFG.lists) return;
  await Promise.all(CFG.lists.map(async (l) => {
    try {
      const s = await api(`/api/lists/${l.id}/state`);
      if (s && typeof s === 'object') l.state = s;
    } catch (_) { /* list removed or temporary error: keep the last state */ }
  }));
  updateRefreshMeta();
}

function updateRefreshHints(){
  if (!CFG || !CFG.lists) return;
  for (const card of $$('#lists .listcard')){
    const l = (CFG.lists || []).find(x => x.id === card.dataset.id);
    const hint = card.querySelector('[data-refresh-hint]');
    if (!l || !hint) continue;
    hint.textContent = `${refreshLabel(l)} · ${tr('minimum 5 minutes')}`;
    const box = card.querySelector('[data-refresh-custom-box]');
    const custom = card.querySelector('[data-refresh-custom]');
    const wantCustom = l.options && l.options.refreshMode === 'custom';
    if (box) box.hidden = !wantCustom;
    if (custom) custom.disabled = !wantCustom;
  }
}

async function fillXtreamBadge(l, force){
  if (!l || l.kind === 'personal') return;
  if (!/\/get\.php/i.test(l.url || '')) return;
  const el = document.getElementById('xt_' + l.id);
  if (!el) return;
  try {
    const r = await api(`/api/lists/${l.id}/xtream${force ? '?refresh=1' : ''}`);
    if (!r || !r.ok || !r.user) { el.innerHTML = ''; return; }
    const u = r.user;
    const days = u.daysLeft;
    const expTxt = u.expired
      ? '⛔ account EXPIRED'
      : days == null
        ? '⏳ no expiry'
        : `⏳ expires on ${fmtDate(u.expiryIso)} (${days} days)`;
    const conn = u.maxConnections ? ` · max ${u.maxConnections} conn` : '';
    const color = u.expired ? 'background:#3a0d14;color:#ffb4ab'
      : days == null ? 'background:#0e2a17;color:#50fa7b'
      : days <= 7 ? 'background:#3a0d14;color:#ffb4ab'
      : days <= 30 ? 'background:#2b2410;color:#f1fa8c'
      : 'background:#0e2a17;color:#50fa7b';
    el.innerHTML = `<span class="badge" data-xtream="${esc(l.id)}" style="${color};cursor:pointer" title="Account Xtream: ${esc(u.status)} · updated ${fmtDate(r.fetchedAt)} — click to refresh">${expTxt}${conn}</span>`;
  } catch (_) { /* no data: empty badge */ }
}
async function refreshXtreamBadge(id){
  const l = (CFG.lists || []).find(x => x.id === id);
  if (l) fillXtreamBadge(l, true);
}

/* --------- side menu: list reordering + quick access --------- */

let SD_DRAG = null; // {el, from, to, after}

function moveList(from, to, after){
  if (from === to || from < 0 || to < 0 || from >= CFG.lists.length || to >= CFG.lists.length) return false;
  const [moved] = CFG.lists.splice(from, 1);
  let idx = to;
  if (from < to) idx--;
  if (after) idx++;
  idx = Math.max(0, Math.min(CFG.lists.length, idx));
  CFG.lists.splice(idx, 0, moved);
  return true;
}

function renderSideMenu(){
  const el = $('#sidemenu');
  if (!el) return;
  const items = CFG.lists.map((l, i) => `<div class="sditem" data-sdid="${esc(l.id)}" data-sdindex="${i}">
    <span class="bhandle sdhandle" draggable="true" data-sdhandle title="Drag to reorder" role="button" tabindex="0" aria-label="Drag to reorder">☰</span>
    <button class="sdname" data-sdgo="${esc(l.id)}" title="Go to the list">${l.kind === 'personal' ? '⭐ ' : ''}${esc(l.name || l.url)}</button>
  </div>`).join('');
  el.innerHTML = '<div class="sdtitle">List order</div>' + (items || '<div class="hint">No lists</div>');
}


/* -------- personal lists: cascading dropdowns of the "add content" picker -------- */

async function plPopulateBranches(card){
  const lid = card.querySelector('[data-plsel="list"]').value;
  if (lid && !SKIP_TREE_RELOAD) await loadBranches(lid); // fresh: renames and new groups
  const bs = (lid && branchesOf(lid)) || [];
  card.querySelector('[data-plsel="branch"]').innerHTML =
    bs.map((b) => `<option value="${esc(b.path)}">${esc(b.displayName)}</option>`).join('');
  await plPopulateChans(card);
}

async function plPopulateChans(card){
  const lid = card.querySelector('[data-plsel="list"]').value;
  const bp = card.querySelector('[data-plsel="branch"]').value;
  const dl = card.querySelector('datalist[data-pldl]');
  if (!dl) return;
  if (!lid || bp == null || bp === ''){ dl.innerHTML = ''; return; }
  try {
    const r = await api(`/api/lists/${lid}/channels?path=${encodeURIComponent(bp)}`);
    dl.innerHTML = `<option value="— the whole playlist —">`
      + r.channels.filter((c) => c.enabled).map((c) => `<option value="${esc(c.shown)}">`).join('');
  } catch (e){ dl.innerHTML = ''; }
}

/** Resolves the channel field: '*' = whole playlist, otherwise the channel (typed or suggested name). */
async function plResolveChan(lid, bp, value){
  const v = String(value || '').trim();
  if (!v || v === '*' || v === '— the whole playlist —') return { wild: true };
  const r = await api(`/api/lists/${lid}/channels?path=${encodeURIComponent(bp)}`);
  const c = r.channels.find((x) => x.enabled && (x.shown === v || x.name === v));
  return c ? { wild: false, chan: c } : null;
}

async function createPersonalList(){
  const n = CFG.lists.filter((l) => l.kind === 'personal').length;
  const newId = 'l_p' + Math.random().toString(16).slice(2, 8);
  OPEN_LISTS.add(newId);
  CFG.lists.push({
    id: newId,
    name: `My list ${n + 1}`,
    kind: 'personal',
    url: '',
    state: { status: 'ready', stats: { nodes: 0, stations: 0, external: 0, m3u: 0, failed: 0 } },
    options: { enabled: true, inCatalog: false, personalEntries: [] },
  });
  await saveConfig();
  renderLists();
  toast('Personal list created: add channels or whole playlists from the "Add content" box');
}

function renderListCard(l){
  const o = l.options, s = l.state || {};
  const stats = s.stats || null;
  const bs = branchesOf(l.id);
  const activeN = bs ? bs.filter((b) => branchEnabled(l, b.path)).length : null;
  const activeLabel = bs ? `${activeN}/${bs.length} enabled` : 'playlist…';
  const personal = l.kind === 'personal';
  const purl = personal
    ? location.origin.replace(/\/+$/, '') + '/personal/' + l.id + '.m3u'
    : '';
  const collapsed = !OPEN_LISTS.has(l.id);
  // A personal list has no remote source: a custom UA would do nothing.
  const uaOptions = UA_PRESETS.map((p) => `<button type="button" class="uaOpt" role="option"
              data-ua-opt="${esc(p.value)}" title="${esc(p.value || p.note)}">
              <span class="uan">${esc(p.name)}</span><span class="uav">${esc(p.note)}</span>
            </button>`).join('');
  const uaField = personal ? '' : `<div>
            <label>Custom User-Agent (optional)</label>
            <div class="uaCombo">
              <input type="text" maxlength="300" spellcheck="false" data-f="options.userAgent" data-ua-input
                value="${esc(o.userAgent || '')}" placeholder="empty = default (Chrome 126 + WiseM3U)"
                autocomplete="off" aria-haspopup="listbox" aria-expanded="false">
              <button type="button" class="uaTgl" data-ua-toggle tabindex="-1"
                aria-label="Suggested User-Agents" aria-expanded="false">▾</button>
              <div class="uaMenu" role="listbox" aria-label="Suggested User-Agents" hidden>${uaOptions}</div>
            </div>
            <div class="hint" data-info data-i18n-html="hint.userAgent">Used to <b>download this list</b> and its branches, the Xtream panel and channel logos. Useful when a panel or CDN returns <code>403</code> because it recognizes WiseM3U: paste the UA of a browser, VLC or the app you normally use. One line only; empty = default behavior.</div>
          </div>`;
  return `<section class="card listcard${collapsed ? ' collapsed' : ''}" data-id="${esc(l.id)}" ${personal ? 'data-kind="personal"' : ''}>
    <div class="listhead">
      <div class="listtitle">
        <span class="name" data-ltgl="${esc(l.id)}" role="button" tabindex="0"
              aria-expanded="${collapsed ? 'false' : 'true'}"
              title="${collapsed ? 'Expand' : 'Collapse'} the list"><i class="listdot ${o.enabled ? 'on' : 'off'}" role="img" title="${o.enabled ? 'List enabled' : 'List disabled'}" aria-label="${o.enabled ? 'List enabled' : 'List disabled'}"></i>${personal ? '⭐ ' : ''}${esc(l.name || l.url)}</span>
        <button type="button" class="activeCount" data-act="activecount" data-active-count aria-haspopup="dialog"
          title="Show a preview of the enabled playlists">${activeLabel}</button>
        <div class="linfo"></div>
      </div>
      <span class="xtbadge" id="xt_${esc(l.id)}"></span>
      <div class="spacer" style="flex:1"></div>
      <div class="acts">
        <button class="ghost small" data-act="toggle" style="${o.enabled ? '' : 'opacity:.55;color:var(--warn)'}" title="Enable/disable the whole list">${o.enabled ? 'on' : 'off'}</button>
        <button class="ghost small" data-act="refresh">Refresh</button>
        <button class="ghost small" data-act="origin" title="Undo merges and moves: channels return to their original playlists">↩ Restore</button>
        <button class="danger small" data-act="del">Delete</button>
      </div>
    </div>
    ${personal
      ? `<div class="url copyurl" data-copyurl="${esc(purl)}" role="button" tabindex="0" title="Click to copy the M3U link">
         Personal list (no remote URL): you choose its content below.
         Link M3U: <code>${esc(purl)}</code> <button class="ghost small" data-act="copypl" style="margin-left:6px">⧉ copy</button></div>`
      : `<div class="url copyurl" data-copyurl="${esc(l.url)}" role="button" tabindex="0" title="Click to copy the list URL">${esc(l.url)}</div>`}
    <div class="kv" style="margin-top:6px">
      <span data-refreshmeta="${esc(l.id)}">${refreshMeta(l)}</span>
      ${stats ? ` · nodes <b>${stats.nodes}</b> · external branches <b>${stats.external}</b> · imported m3u <b>${stats.m3u}</b> · streams <b>${stats.stations}</b>${stats.failed?` · errors <b>${stats.failed}</b>`:''}` : ''}
    </div>
    ${stats && stats.truncated ? `<div class="hint" style="margin-top:6px;color:#f5c451">⚠︎ Very large list: imported the first <b>${stats.stations}</b> channels (safety limit). The rest is skipped to avoid exhausting container memory.</div>` : ''}
    ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}

    <details class="fold">
      <summary>⚙️ List settings</summary>
      <div class="foldbody">
        <div class="grid2">
          <div>
            <label>Display name</label>
            <input type="text" data-f="name" value="${esc(l.name)}">
          </div>
          <div>
            <label>group-title prefix</label>
            <select data-f="options.groupPrefix">
              <option value="list" ${o.groupPrefix==='list'?'selected':''}>List name</option>
              <option value="none" ${o.groupPrefix==='none'?'selected':''}>None</option>
              <option value="custom" ${o.groupPrefix==='custom'?'selected':''}>Custom</option>
            </select>
          </div>
          <div>
            <label>Custom prefix</label>
            <input type="text" data-f="options.customPrefix" value="${esc(o.customPrefix||'')}">
          </div>
          <div>
            <label>Levels in group-title</label>
            <input type="number" min="1" max="6" data-f="options.groupDepth" value="${o.groupDepth}">
          </div>
          ${personal ? '' : `<div>
            <label>${tr('Refresh policy')}</label>
            <select data-f="options.refreshMode">
              <option value="inherit" ${o.refreshMode==='inherit'?'selected':''}>${tr('Use global setting')}</option>
              <option value="custom" ${o.refreshMode==='custom'?'selected':''}>${tr('Custom interval')}</option>
              <option value="manual" ${o.refreshMode==='manual'?'selected':''}>${tr('Manual only')}</option>
            </select>
            <div class="hint" data-info data-refresh-hint>${refreshLabel(l)} · ${tr('minimum 5 minutes')}</div>
          </div>
          <div class="refreshCustom" data-refresh-custom-box ${o.refreshMode==='custom'?'':'hidden'}>
            <label>${tr('Custom interval (minutes)')}</label>
            <div class="refreshCombo" data-refresh-scope="list">
              <input type="number" min="5" max="525600" step="1" autocomplete="off"
                data-f="options.refreshMinutes" data-refresh-custom data-refresh-input
                value="${esc(o.refreshMinutes)}" ${o.refreshMode==='custom'?'':'disabled'}
                aria-haspopup="listbox" aria-expanded="false">
              <button type="button" class="refreshTgl" data-refresh-toggle tabindex="-1"
                aria-label="${esc(tr('Choose an interval'))}" aria-expanded="false">▾</button>
              <div class="refreshMenu" role="listbox" aria-label="${esc(tr('Choose an interval'))}" hidden></div>
            </div>
            <div class="hint">${tr('minimum 5 minutes')}</div>
          </div>`}
          ${uaField}
          <div>
            <label>List EPG</label>
            <input type="url" data-f="options.epgUrl" value="${esc(o.epgUrl||'')}" placeholder="https://example.com/guide.xml">
            <div class="hint" data-info data-i18n-html="hint.listEpg">Empty = EPG from the general settings; if that is empty too, the one detected in the list is used.</div>
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <label class="chk ${o.enabled?'on':''}"><input type="checkbox" data-f="options.enabled" ${o.enabled?'checked':''}> List enabled</label>
          <label class="chk ${o.inCatalog?'on':''}"><input type="checkbox" data-f="options.inCatalog" ${o.inCatalog?'checked':''}> Show as catalog in Stremio/Nuvio</label>
          <label class="chk ${o.dedupe?'on':''}"><input type="checkbox" data-f="options.dedupe" ${o.dedupe?'checked':''}> Remove duplicates</label>
          <label class="chk ${o.emitLogo?'on':''}"><input type="checkbox" data-f="options.emitLogo" ${o.emitLogo?'checked':''}> Use the group icon as logo (makes the playlist heavier)</label>
        </div>
      </div>
    </details>

    <details class="fold">
      <summary>🧪 Protocols, AceStream and exclusions</summary>
      <div class="foldbody">
        <div class="row">
          ${['http','ace','rtmp','rtsp','other'].map(k=>`
            <label class="chk ${o.protocols[k]?'on':''}"><input type="checkbox" data-f="options.protocols.${k}" ${o.protocols[k]?'checked':''}> ${PROTO_LABEL[k]}</label>`).join('')}
        </div>
        <div class="row" style="margin-top:12px">
          <div style="flex:1 1 220px">
            <label>AceStream</label>
            <select data-f="options.aceMode">
              <option value="keep" ${o.aceMode==='keep'?'selected':''}>acestream:// (requires Ace Player/Engine)</option>
              <option value="engine" ${o.aceMode==='engine'?'selected':''}>Rewrite to HTTP via Engine</option>
              <option value="off" ${o.aceMode==='off'?'selected':''}>Exclude AceStream</option>
            </select>
          </div>
          <div style="flex:1 1 260px">
            <label>AceStream Engine host (if "Rewrite to HTTP")</label>
            <input type="text" data-f="options.aceEngineHost" value="${esc(o.aceEngineHost||'')}" placeholder="http://IP:6878">
          </div>
        </div>
        <div style="margin-top:12px">
          <label>Exclude channels containing these words (one per line)</label>
          <textarea data-f="options.excludeKeywords" rows="2">${esc((o.excludeKeywords||[]).join('\n'))}</textarea>
        </div>
      </div>
    </details>

    <details class="fold">
      <summary>🌐 EasyProxy (optional)</summary>
      <div class="foldbody">
        <div class="hint" data-info data-i18n-html="hint.easyProxy" style="margin-top:2px"><b>“(dns)”</b> lists often do not work because the <b>client</b> (TV/phone) cannot resolve those domains, regardless of the server DNS. With <a class="lnk" href="https://github.com/realbestia1/EasyProxy" target="_blank">EasyProxy</a> streams go through the server (with its DNS/WARP/extractors): enter your instance URL (e.g. <code>http://192.168.1.10:7860</code>) and this list's streams will be rewritten. Warning: all video traffic goes through the server.</div>
        <div class="row" style="margin-top:10px">
          <div style="flex:2 1 260px">
            <label>EasyProxy URL (empty = disabled)</label>
            <input type="text" data-f="options.easyProxy" value="${esc(o.easyProxy||'')}" placeholder="IP/DNS">
          </div>
          <div style="flex:1 1 160px">
            <label>API_PASSWORD (if set)</label>
            <input type="text" data-f="options.easyProxyPassword" value="${esc(o.easyProxyPassword||'')}">
          </div>
          <div style="flex:1 1 160px">
            <label>Extra parameters (e.g. warp=off)</label>
            <input type="text" data-f="options.easyProxyParams" value="${esc(o.easyProxyParams||'')}">
          </div>
        </div>
        <div class="row" style="margin-top:10px">
          <div style="flex:0 0 auto;display:flex;align-items:flex-end">
            <button class="ghost small" data-act="eptest">Test</button>
          </div>
        </div>
        <details class="help">
          <summary>ℹ️ How to read the test (non-blocking warnings)</summary>
          <div class="hint" data-i18n-html="hint.easyProxyTest">Enter <b>IP or domain</b>: it works as is, with no special configuration. The addon only <b>rewrites streams</b> to EasyProxy: the <b>client</b> (TV/phone) connects. The <b>Test</b> is only indicative: on many home networks the Docker container cannot reach its public domain (no NAT hairpin) or does not trust the certificate; in those cases it shows a <b>non-blocking warning</b> and playback still works on the client.</div>
        </details>
        <div class="epbox" data-epbox></div>
      </div>
    </details>

    <details class="fold">
      <summary>➕ Add content from your lists</summary>
      <div class="foldbody">
        <div class="row" style="margin-top:2px">
          <div style="flex:1 1 140px"><label>List</label><select data-plsel="list">${CFG.lists.filter((x) => x.id !== l.id).map((x) => `<option value="${esc(x.id)}">${x.kind === 'personal' ? '⭐ ' : ''}${esc(x.name || x.url)}</option>`).join('')}</select></div>
          <div style="flex:1 1 150px"><label>Playlist/branch</label><select data-plsel="branch"></select></div>
          <div style="flex:1 1 190px"><label>Channel (type or choose)</label><input type="text" data-plchan list="pldl-${l.id}" placeholder="channel name or — the whole playlist —"></div>
          <div style="flex:0 0 auto;display:flex;gap:6px;align-items:flex-end">
            <button data-act="pladd">+ Add</button>
            <button class="ghost" data-act="plnew" title="Create an empty custom playlist in this list">+ New playlist</button>
          </div>
        </div>
        <div class="row" data-plnewrow style="display:none">
          <div style="flex:1 1 220px"><label>New playlist name</label><input type="text" data-plnewname placeholder="e.g. Favorites"></div>
          <div style="flex:0 0 auto;display:flex;gap:6px;align-items:flex-end">
            <button data-act="plnewok">Create</button>
            <button class="ghost" data-act="plnewno">Cancel</button>
          </div>
        </div>
        <datalist id="pldl-${l.id}" data-pldl></datalist>
        <details class="help">
          <summary>ℹ️ How importing works</summary>
          <div class="hint" data-i18n-html="hint.import">From <b>another</b> list you import channels or <b>— the whole playlist —</b> as additional playlists of this list. From the <b>same</b> list you move channels to another playlist or a <b>custom playlist</b> (create it with <b>+ New playlist</b>). The channel field is <b>editable</b>: suggestions come from the selected playlist.</div>
        </details>
      </div>
    </details>

    ${renderBranches(l)}
  </section>`;
}

/* ---------------- channels: state and changes ---------------- */
const chanKey = (path, name) => `${path}::${name}`;

function setChannelEnabled(list, path, name, on){
  const dis = new Set(list.options.disabledChannels || []);
  const k = chanKey(path, name);
  if (on) dis.delete(k); else dis.add(k);
  list.options.disabledChannels = Array.from(dis);
}
function setChannelName(list, path, name, value){
  const v = String(value || '').trim();
  list.options.channelRenames = list.options.channelRenames || {};
  const k = chanKey(path, name);
  if (!v || v === name) delete list.options.channelRenames[k];
  else list.options.channelRenames[k] = v;
}

/** Resolves the group field value: the name of an existing branch/group,
 *  or free text = new personal group. Empty = original branch. */
function resolveGroupTarget(list, value){
  const v = String(value || '').trim();
  if (!v) return null;
  const hit = (branchesOf(list.id) || []).find((b) => b.displayName === v);
  return hit ? hit.path : '@' + v;
}

/** Moves a channel to another branch or to a personal group ("@Name").
 *  The key remains the original one (home::name): rename/exclusions/order
 *  keep working even after the move. */
async function applyChannelMove(list, c, target, curPath){
  list.options.channelMoves = list.options.channelMoves || {};
  const key = chanKey(c.home, c.name);
  if (!target || target === c.home) delete list.options.channelMoves[key];
  else list.options.channelMoves[key] = target;
  // save immediately on the server: tree and channels are re-read from there, so
  // the move must already be recorded for the UI to show it
  try {
    const saved = await api('/api/config', {
      method:'PUT',
      body: JSON.stringify({ settings: CFG.settings, lists: CFG.lists, reason: 'channel move', baseRev: CFG.rev }),
    });
    CFG.rev = saved.rev;
  } catch(e){
    if (e.status === 409){
      toast('Configuration changed elsewhere: reloading the server state', 6000);
      await loadConfig();
    } else toast('Error: '+e.message, 4000);
    return;
  }
  await loadBranches(list.id); // refresh counts and custom groups
  for (const p of new Set([curPath, target])) {
    const k = `${list.id}|${p}`;
    if (EXPANDED.has(k)) {
      try {
        const r = await api(`/api/lists/${list.id}/channels?path=${encodeURIComponent(p)}`);
        CHANS[k] = r.channels;
      } catch(_){ /* it will refresh on the next open */ }
    }
  }
  renderLists();
}

/* reloads the channels of open branches (after moves/deletions across lists) */
async function reloadOpenChans(listIds){
  for (const key of [...EXPANDED]){
    const i = key.indexOf('|');
    const lid = key.slice(0, i), p = key.slice(i + 1);
    if (listIds && !listIds.includes(lid)) continue;
    try {
      const r = await api(`/api/lists/${lid}/channels?path=${encodeURIComponent(p)}`);
      CHANS[key] = r.channels;
    } catch (_){ CHANS[key] = []; }
  }
}

function updateChannelCounts(card, list, path){
  const key = `${list.id}|${path}`;
  const chans = CHANS[key] || [];
  const hidden = chans.filter(c=>!c.enabled).length;
  const chDiv = card.querySelector(`.chans[data-chans="${path}"]`);
  if (chDiv){
    const cc = chDiv.querySelector('.ccount');
    if (cc) cc.textContent = `${chans.length - hidden}/${chans.length} enabled`;
    const brow = chDiv.previousElementSibling;
    if (brow && brow.classList.contains('brow')){
      const b = (branchesOf(list.id) || []).find(x=>x.path===path);
      const bc = brow.querySelector('.bcount');
      if (b && bc) bc.innerHTML = `${b.stations} channels${hidden?` <span style="color:var(--warn)">(${hidden} excluded)</span>`:''}`;
    }
  }
}

async function toggleExpand(card, list, path){
  const key = `${list.id}|${path}`;
  const q = `.brow[data-path="${CSS.escape(path)}"]`;
  const row = card.querySelector(q);
  const btn = card.querySelector(`button[data-exp="${CSS.escape(path)}"]`);
  const existing = card.querySelector(`.chans[data-chans="${CSS.escape(path)}"]`);
  // scroll of the card's playlist container (handled by .branches): it must not move
  const brBox = card.querySelector('.branches');
  const bTop = brBox ? brBox.scrollTop : 0;

  if (EXPANDED.has(key)){
    EXPANDED.delete(key);
    if (existing) existing.remove();
    if (btn) btn.textContent = '\u25b8 channels';
    if (brBox) requestAnimationFrame(()=>{ brBox.scrollTop = bTop; });
    return; // no renderLists(): rebuilding everything broke the scroll position
  }
  EXPANDED.add(key);
  if (btn) btn.textContent = '▾ channels';
  if (row) row.insertAdjacentHTML('afterend',
    `<div class="chans" data-chans="${esc(path)}"><div class="hint">Loading channels…</div></div>`);
  if (brBox) brBox.scrollTop = bTop;

  try {
    const r = await api(`/api/lists/${list.id}/channels?path=${encodeURIComponent(path)}`);
    CHANS[key] = r.channels;
  } catch(e){
    EXPANDED.delete(key);
    toast('Error: ' + e.message, 4000);
    const el = card.querySelector(`.chans[data-chans="${CSS.escape(path)}"]`);
    if (el) el.remove();
    if (btn) btn.textContent = '\u25b8 channels';
    return;
  }
  const b = (branchesOf(list.id) || []).find(x=>x.path===path);
  const el = card.querySelector(`.chans[data-chans="${CSS.escape(path)}"]`);
  if (b && el) {
    el.outerHTML = renderChannels(list, b);
    // after replacing the content, explicitly restore scrollTop
    if (brBox) requestAnimationFrame(()=>{ brBox.scrollTop = bTop; });
  }
}

/* ---------------- drag & drop (branches and channels) ---------------- */
let DRAG = null; // {type:'branch'|'chan', el, chans?, target?, after?}

function dragCleanup(card){
  if (DRAG && DRAG.el) DRAG.el.classList.remove('dragging');
  $$('.drag-before, .drag-after, .drag-into', card).forEach(e=>e.classList.remove('drag-before','drag-after','drag-into'));
  DRAG = null;
}

function applyDrop(card, list){
  if (!DRAG || !DRAG.target){ dragCleanup(card); return; }
  const id = list.id;
  if (DRAG.into){
    // drop "inside" a playlist: the channel (or all channels of the dragged
    // branch) moves to the destination playlist
    const tPath = DRAG.target.classList.contains('brow')
      ? DRAG.target.dataset.path
      : ((DRAG.target.closest('.chans') || {}).dataset || {}).chans;
    const srcId = DRAG.listId;
    const type = DRAG.type;
    const c = DRAG.chan;
    const fromPath = type === 'branch' ? DRAG.el.dataset.path : '';
    // names are needed for confirmation: read them before clearing DRAG
    const srcName = type === 'branch' ? (DRAG.el.dataset.name || fromPath || 'playlist').trim() : '';
    const dstName = type === 'branch' ? (DRAG.target.dataset.name || tPath || 'playlist').trim() : '';
    dragCleanup(card);
    if (!tPath) return;
    if (type === 'branch' && !confirm(`Merge the playlist «${srcName}» into «${dstName}»?\nAll its channels will be moved to the destination playlist. You can undo with «↩ Restore».`)) return;
    (async ()=>{
      try {
        if (type === 'chan'){
          if (!c) return;
          if (srcId === id){
            if (tPath === (c.cur || '')){ toast('The channel is already in this playlist'); return; }
            const srcList = CFG.lists.find((l)=>l.id===srcId);
            await applyChannelMove(srcList, c, tPath, c.cur || '');
            toast('Channel moved');
          } else {
            const r = await api(`/api/lists/${id}/addchannel`, { method:'POST', body: JSON.stringify({ path: tPath, name: c.name, home: c.home, fromList: srcId }) });
            showUndo(r.revived ? 'Channel restored and moved here' : `Channel moved here (was in: ${r.from})`, r.undo);
            await loadConfig();
            await reloadOpenChans([id, srcId]);
            renderLists();
          }
        } else {
          if (srcId === id && fromPath === tPath){ toast('Same playlist'); return; }
          const r = await api(`/api/lists/${id}/mergebranch`, { method:'POST', body: JSON.stringify({ fromList: srcId, from: fromPath, to: tPath }) });
          showUndo(r.moved ? `${r.moved} channels moved into the playlist` : 'No channels to move', r.undo);
          await loadConfig();
          if (srcId !== id) { await loadBranches(id); await loadBranches(srcId); }
          await reloadOpenChans([id, srcId]);
          renderLists();
        }
      } catch (e){ toast(e.message, 4000); }
    })();
    return;
  }
  if (DRAG.listId !== id){ dragCleanup(card); return; } // reordering only within the same list
  if (DRAG.type === 'branch'){
    const bs = branchesOf(id);
    const from = bs.findIndex(b=>b.path===DRAG.el.dataset.path);
    let to = bs.findIndex(b=>b.path===DRAG.target.dataset.path);
    if (from >= 0 && to >= 0){
      if (DRAG.after) to += 1;
      const [item] = bs.splice(from, 1);
      if (from < to) to -= 1;
      bs.splice(to, 0, item);
      rebuildOrder(list);
    }
  } else {
    const path = DRAG.chans.dataset.chans;
    const chans = CHANS[`${id}|${path}`];
    const from = Number(DRAG.el.dataset.ci);
    let to = Number(DRAG.target.dataset.ci);
    if (chans && from >= 0 && to >= 0){
      if (DRAG.after) to += 1;
      const [item] = chans.splice(from, 1);
      if (from < to) to -= 1;
      chans.splice(to, 0, item);
      list.options.channelOrder[path] = chans.map(c=>c.name);
    }
  }
  dragCleanup(card);
  // reordering lives in list.options.order: reloading the tree from the server here
  // would bring branches back to the saved order, cancelling the drag just performed
  SKIP_TREE_RELOAD = true;
  renderLists();
  SKIP_TREE_RELOAD = false;
}

function bindListEvents(){
  $$('#lists .listcard').forEach(card=>{
    const id = card.dataset.id;
    const list = CFG.lists.find(l=>l.id===id);

    // interval and UA fields show their presets as soon as they get focus
    card.addEventListener('focusin', ev=>{
      if (ev.target.matches && ev.target.matches('[data-refresh-input]')){
        if (ev.target.dataset.skipOpen){ delete ev.target.dataset.skipOpen; return; }
        toggleRefreshMenu(ev.target.closest('.refreshCombo'), true);
        return;
      }
      if (!ev.target.matches || !ev.target.matches('[data-ua-input]')) return;
      // selecting a preset focuses the input again: do not reopen the menu
      if (ev.target.dataset.skipOpen){ delete ev.target.dataset.skipOpen; return; }
      toggleUaMenu(card, true);
    });

    card.addEventListener('change', async ev=>{
      const el = ev.target;
      if (el.dataset && el.dataset.plsel === 'list'){ await plPopulateBranches(card); return; }
      if (el.dataset && el.dataset.plsel === 'branch'){ await plPopulateChans(card); return; }
      if (el.dataset && el.dataset.cch !== undefined){
        // single channel checkbox
        const chDiv = el.closest('.chans');
        const path = chDiv.dataset.chans;
        const chans = CHANS[`${id}|${path}`];
        const c = chans && chans[Number(el.dataset.cch)];
        if (c){
          setChannelEnabled(list, c.home || path, c.name, el.checked);
          c.enabled = el.checked;
          el.closest('.crow').classList.toggle('off', !el.checked);
          updateChannelCounts(card, list, path);
        }
        return;
      }
      if (el.classList && el.classList.contains('cname')){
        // single channel rename
        const row = el.closest('.crow');
        const path = row.closest('.chans').dataset.chans;
        const orig = row.dataset.cname;
        const c = CHANS[`${id}|${path}`][Number(row.dataset.ci)];
        setChannelName(list, (c && c.home) || path, orig, el.value);
        const shown = (list.options.channelRenames || {})[chanKey((c && c.home) || path, orig)] || orig;
        if (c) c.shown = shown;
        el.classList.toggle('renamed', shown !== orig);
        return;
      }
      if (el.dataset && el.dataset.cb){
        setBranchEnabled(list, el.dataset.cb, el.checked);
        el.closest('.brow').classList.toggle('off', !el.checked);
        updateBadge(card, list);
        return;
      }
      if (el.classList && el.classList.contains('bname')){
        const row = el.closest('.brow');
        setBranchName(list, row.dataset.path, row.dataset.name, el.value);
        el.classList.toggle('renamed', branchDisplayName(list, {path:row.dataset.path, name:row.dataset.name}) !== row.dataset.name);
        return;
      }
      if (el.dataset && el.dataset.f){
        if (el.dataset.f === 'options.refreshMode'){
          const box = card.querySelector('[data-refresh-custom-box]');
          const custom = card.querySelector('[data-refresh-custom]');
          const wantCustom = el.value === 'custom';
          if (box) box.hidden = !wantCustom;
          if (custom) custom.disabled = !wantCustom;
          const info = card.querySelector('[data-refresh-hint]');
          if (info) info.textContent = `${refreshLabel({ ...list, options: { ...list.options, refreshMode: el.value } })} · ${tr('minimum 5 minutes')}`;
          if (wantCustom && custom) requestAnimationFrame(()=>custom.focus());
        }
        if (el.dataset.f === 'options.refreshMinutes'){
          const n = Math.max(5, Math.min(525600, Math.round(Number(el.value) || 5)));
          el.value = String(n);
          updateRefreshHints();
        }
        setPath(list, el.dataset.f, el.type==='checkbox' ? el.checked : el.value);
        if (el.dataset.f.startsWith('options.protocols') || ['options.enabled','options.inCatalog','options.dedupe','options.emitLogo'].includes(el.dataset.f)){
          el.closest('.chk').classList.toggle('on', el.checked);
        }
      }
    });

    card.addEventListener('keydown', ev=>{
      if (ev.key === 'Escape' && (card.querySelector('.uaMenu:not([hidden])') || card.querySelector('.refreshMenu:not([hidden])'))){
        closeUaMenus();
        closeRefreshMenus();
        return;
      }
      const copyurl = ev.target.closest('[data-copyurl]');
      if (copyurl && (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar')){
        ev.preventDefault();
        copyListLink(copyurl.dataset.copyurl, list.kind === 'personal' ? 'M3U link copied ✔' : 'List link copied ✔');
        return;
      }
      const tgl = ev.target.closest('[data-ltgl], [data-ptgl]');
      if (tgl && (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar')){ ev.preventDefault(); tgl.click(); }
    });

    card.addEventListener('input', ev=>{
      const el = ev.target;
      if (el.dataset && el.dataset.act === 'filter'){
        BRSQ[id] = el.value;
        const q = el.value.trim().toLowerCase();
        let anyVisible = false;
        $$('.brow', card).forEach(r=>{
          const show = !q || r.dataset.search.includes(q);
          r.style.display = show ? '' : 'none';
          if (show) anyVisible = true;
          const ch = r.nextElementSibling;
          if (ch && ch.classList.contains('chans')) ch.style.display = show ? '' : 'none';
        });
        const brsNone = card.querySelector('.brsnone');
        if (brsNone) brsNone.style.display = anyVisible ? 'none' : '';
        return;
      }
      if (el.dataset && el.dataset.refreshCustom !== undefined){
        closeRefreshMenus();
        setPath(list, 'options.refreshMinutes', el.value);
        updateRefreshHints();
        return;
      }
      if (el.dataset && el.dataset.cfilter !== undefined){
        const q = el.value.trim().toLowerCase();
        $$('.crow', el.closest('.chans')).forEach(r=>{
          r.style.display = !q || r.dataset.csearch.includes(q) ? '' : 'none';
        });
        return;
      }
      if (el.dataset && el.dataset.f && el.type !== 'checkbox') setPath(list, el.dataset.f, el.value);
      if (el.matches && el.matches('[data-ua-input]')) closeUaMenus();
    });

    card.addEventListener('click', async ev=>{
      const uaTgl = ev.target.closest('[data-ua-toggle]');
      if (uaTgl){ toggleUaMenu(card); return; }
      const uaOpt = ev.target.closest('[data-ua-opt]');
      if (uaOpt){
        const input = card.querySelector('[data-ua-input]');
        const value = uaOpt.dataset.uaOpt || '';
        setPath(list, 'options.userAgent', value);
        if (input){
          input.value = value;
          input.dataset.skipOpen = '1';
          input.focus();
        }
        closeUaMenus();
        return;
      }
      if (ev.target.closest('[data-ua-input]')){ toggleUaMenu(card, true); return; }
      const copyurl = ev.target.closest('[data-copyurl]');
      if (copyurl && !ev.target.closest('button, a')){
        // a click on the URL text copies it; the inner copy button keeps its own handler
        copyListLink(copyurl.dataset.copyurl, list.kind === 'personal' ? 'M3U link copied ✔' : 'List link copied ✔');
        return;
      }
      const ltl = ev.target.closest('[data-ltgl]');
      if (ltl){
        const lid = ltl.dataset.ltgl;
        if (OPEN_LISTS.has(lid)) OPEN_LISTS.delete(lid); else OPEN_LISTS.add(lid);
        const open = !card.classList.toggle('collapsed');
        ltl.setAttribute('aria-expanded', String(open));
        ltl.title = `${open ? 'Collapse' : 'Expand'} the list`;
        return;
      }
      const ptgl = ev.target.closest('[data-ptgl]');
      if (ptgl){
        // info notes live inside the title but must not squeeze the section
        if (ev.target.closest('details.info, a, button, input, select, label, summary')) return;
        const lid = ptgl.dataset.ptgl;
        if (PLAYLISTS_OPEN.has(lid)) PLAYLISTS_OPEN.delete(lid); else PLAYLISTS_OPEN.add(lid);
        const wrap = card.querySelector('.plwrap');
        if (wrap){
          const open = !wrap.classList.toggle('collapsed');
          const arrow = ptgl.querySelector('.sectgl');
          if (arrow) arrow.textContent = open ? '\u25be' : '\u25b8';
          ptgl.setAttribute('aria-expanded', String(open));
          ptgl.title = open ? 'Collapse the playlists' : 'Expand the playlists';
        }
        return;
      }
      const cab = ev.target.closest('button[data-caddbtn]');
      if (cab){
        const inp = cab.parentElement.querySelector('[data-cadd]');
        const v = (inp ? inp.value : '').trim();
        if (!v){ toast('Type the name of the channel to add'); return; }
        try {
          const r = await api(`/api/lists/${id}/addchannel`, {
            method: 'POST',
            body: JSON.stringify({ path: cab.dataset.caddbtn, name: v }),
          });
          showUndo(`Channel added here (taken from: ${r.from})`, r.undo);
          if (inp) inp.value = '';
          await loadConfig();          // resync the config (server-side moves/entries)
          await reloadOpenChans([id]);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      const et = ev.target.closest('button[data-etrash]');
      if (et){
        const t = TRASH[id] || { branches: [], channels: [] };
        const n = (t.branches || []).length + (t.channels || []).length;
        if (!n){ toast('The trash is already empty'); return; }
        if (!confirm(`Permanently delete ${n} items from the trash?\nThey will no longer be restorable: they will stay out of the list forever.`)) return;
        try {
          const r = await api(`/api/lists/${id}/emptytrash`, { method:'POST', body:'{}' });
          showUndo(`Trash emptied: ${r.removed} items permanently deleted`, r.undo);
          await loadConfig();
          await reloadOpenChans([id]);
          await refreshTrash(id);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      const rb = ev.target.closest('button[data-rbranch]');
      if (rb){
        try {
          await api(`/api/lists/${id}/restore`, { method:'POST', body: JSON.stringify({ path: rb.dataset.rbranch }) });
          toast('Playlist restored');
          await loadConfig();
          await reloadOpenChans([id]);
          await refreshTrash(id);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      const rc = ev.target.closest('button[data-rchan]');
      if (rc){
        try {
          await api(`/api/lists/${id}/restore`, { method:'POST', body: JSON.stringify({ path: rc.dataset.rpath, name: rc.dataset.rname }) });
          toast('Channel restored');
          await loadConfig();
          await reloadOpenChans([id]);
          await refreshTrash(id);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      const cdel = ev.target.closest('button[data-cdel]');
      if (cdel){
        const row = cdel.closest('.crow');
        const path = row.closest('.chans').dataset.chans;
        const c = (CHANS[`${id}|${path}`] || [])[Number(cdel.dataset.cdel)];
        if (!c) return;
        if (!confirm(`Delete "${c.shown || c.name}" from this list? You can restore it from the 🗑 Trash.`)) return;
        try {
          const r = await api(`/api/lists/${id}/delete`, { method:'POST', body: JSON.stringify({ path: c.home || path, name: c.name }) });
          showUndo('Channel deleted — recoverable from the 🗑 Trash', r.undo);
          await loadConfig();
          await reloadOpenChans([id]);
          if (TRASHOPEN.has(id)) await refreshTrash(id);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      const bdel = ev.target.closest('button[data-bdel]');
      if (bdel){
        const path = bdel.dataset.bdel;
        const b = (branchesOf(id) || []).find((x)=>x.path===path);
        const nm = b ? (b.displayName || b.name) : path;
        if (!confirm(`Delete the playlist "${nm}" and all its channels? You can restore it from the 🗑 Trash.`)) return;
        try {
          const r = await api(`/api/lists/${id}/delete`, { method:'POST', body: JSON.stringify({ path }) });
          EXPANDED.delete(`${id}|${path}`);
          delete CHANS[`${id}|${path}`];
          showUndo('Playlist deleted — recoverable from the 🗑 Trash', r.undo);
          await loadConfig();
          if (TRASHOPEN.has(id)) await refreshTrash(id);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      const ap = ev.target.closest('button[data-capply]');
      if (ap){
        // moves the channel to the group chosen/typed in the adjacent field
        const row = ap.closest('.crow');
        const path = row.closest('.chans').dataset.chans;
        const c = CHANS[`${id}|${path}`][Number(ap.dataset.capply)];
        const val = row.querySelector('.cmove') ? row.querySelector('.cmove').value : '';
        if (c) await applyChannelMove(list, c, resolveGroupTarget(list, val), path);
        return;
      }
      const rs = ev.target.closest('button[data-creset]');
      if (rs){
        // returns the channel to the original playlist
        const row = rs.closest('.crow');
        const path = row.closest('.chans').dataset.chans;
        const c = CHANS[`${id}|${path}`][Number(rs.dataset.creset)];
        if (c) await applyChannelMove(list, c, null, path);
        return;
      }
      const exp = ev.target.closest('button[data-exp]');
      if (exp){ await toggleExpand(card, list, exp.dataset.exp); return; }
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'activecount'){ openActiveModal(list); return; }
      if (act === 'trash'){
        if (TRASHOPEN.has(id)){ TRASHOPEN.delete(id); renderLists(); return; }
        TRASHOPEN.add(id);
        renderLists();
        await refreshTrash(id);
        renderLists();
        return;
      }
      if (act === 'delsel'){
        // bulk deletion of checked playlists (custom ones are not
        // checkable): same outcome as the single ✕ but in one call
        const sel = visibleBranches(list).filter((b) => !b.custom && branchEnabled(list, b.path));
        if (!sel.length){ toast('No checked playlist to delete'); return; }
        const few = sel.slice(0, 3).map((b) => b.displayName || b.name).join(', ');
        if (!confirm(`Delete ${sel.length} checked playlists (${few}${sel.length > 3 ? ', …' : ''}) and all their channels? You can restore them from the 🗑 Trash.`)) return;
        try {
          const r = await api(`/api/lists/${id}/delete`, { method:'POST', body: JSON.stringify({ paths: sel.map((b) => b.path) }) });
          for (const b of sel){ EXPANDED.delete(`${id}|${b.path}`); delete CHANS[`${id}|${b.path}`]; }
          showUndo(`${sel.length} playlists deleted — recoverable from the 🗑 Trash`, r.undo);
          await loadConfig();
          if (TRASHOPEN.has(id)) await refreshTrash(id);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      if (act === 'toggle'){
        list.options.enabled = !list.options.enabled;
        await saveConfig();
        renderLists();
        toast(list.options.enabled ? 'List enabled' : 'List disabled');
      }
      if (act === 'refresh') await refreshList(id, btn);
      if (act === 'del'){ if (confirm(`Permanently delete the list «${list.name || list.url}» and its configuration?`)) await delList(id); }
      if (act === 'origin'){
        if (!confirm(`Reset «${list.name || list.url}» to the state it had when it was added?\nAll customizations (renames, exclusions, order, merges, moves, trash) will be cleared and the list will be downloaded again.`)) return;
        try {
          const r = await api(`/api/lists/${id}/restoreorigin`, { method:'POST', body:'{}' });
          await loadConfig();
          for (const lid of r.lists || []) await loadBranches(lid);
          renderLists();
          showUndo('List restored: re-downloading…', r.undo);
          await pollUntilReady(id);
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      if (act === 'eptest') await testEasyProxy(card, list, btn);
      if (act === 'copypl'){
        const base = location.origin.replace(/\/+$/, '');
        copyText(base + '/personal/' + id + '.m3u').then(
          () => toast('Personal list M3U link copied ✔'),
          (e) => toast('Copy failed: ' + e.message, 4000)
        );
      }
      if (act === 'plnew'){
        card.querySelector('[data-plnewrow]').style.display = '';
        card.querySelector('[data-plnewname]').focus();
        return;
      }
      if (act === 'plnewno'){ card.querySelector('[data-plnewrow]').style.display = 'none'; return; }
      if (act === 'plnewok'){
        const nm = card.querySelector('[data-plnewname]').value.trim();
        if (!nm){ toast('Type a name for the playlist'); return; }
        list.options.customGroups = list.options.customGroups || [];
        if (list.options.customGroups.includes(nm)){ toast('A playlist with this name already exists'); return; }
        list.options.customGroups.push(nm);
        await saveConfig();
        await loadBranches(id);
        renderLists();
        toast(`Playlist "${nm}" created: choose it from the menu or move channels into it`);
        return;
      }
      if (act === 'pladd'){
        const lid = card.querySelector('[data-plsel="list"]').value;
        const bp = card.querySelector('[data-plsel="branch"]').value;
        const cv = card.querySelector('[data-plchan]').value;
        if (!lid || bp == null || bp === ''){ toast('Choose a list and a playlist/branch'); return; }
        if (lid === id){
          // same list: moves the channel to the chosen playlist/group
          const res = await plResolveChan(lid, bp, cv).catch(() => null);
          if (!res || res.wild){ toast('To move, type or choose a single channel'); return; }
          const c = res.chan;
          list.options.channelMoves = list.options.channelMoves || {};
          const key = `${c.home}::${c.name}`;
          if (!bp.startsWith('@') && bp === c.home){
            delete list.options.channelMoves[key];
            toast('The channel stays in its playlist');
          } else {
            list.options.channelMoves[key] = bp;
            toast(bp.startsWith('@') ? `Channel moved to the custom group` : 'Channel moved to the chosen playlist');
          }
          await saveConfig();
          await loadBranches(id);
          renderLists();
        } else {
          // other list: imports the channel or the whole playlist as a new branch
          const res = await plResolveChan(lid, bp, cv).catch(() => null);
          if (!res){ toast('Channel not found in the chosen playlist'); return; }
          const src = `${lid}::${bp}::${res.wild ? '*' : res.chan.name}`;
          list.options.personalEntries = list.options.personalEntries || [];
          if (list.options.personalEntries.some((e) => e.src === src)){ toast('Item already present'); return; }
          list.options.personalEntries.push({ id: 'e' + Math.random().toString(16).slice(2, 8), src });
          await saveConfig();
          await loadBranches(id);
          renderLists();
        }
        return;
      }
      if (act === 'onlyactive'){
        if (BRONLY.has(id)) BRONLY.delete(id); else BRONLY.add(id);
        renderLists();
        return;
      }
      if (act === 'clearfilter'){
        BRSQ[id] = '';
        BRONLY.delete(id);
        renderLists();
        return;
      }
      if (act === 'all' || act === 'none'){
        // during a search (or with "active only") act ONLY on
        // visible playlists: silently changing filtered ones was a trap
        const scoped = visibleBranches(list).filter((b) => !b.custom);
        if (!scoped.length){ toast('No playlist in the filter results'); return; }
        for (const b of scoped) setBranchEnabled(list, b.path, act === 'all');
        const filtered = !!String(BRSQ[id] || '').trim() || BRONLY.has(id);
        renderLists();
        toast(`${act === 'all' ? 'Enabled' : 'Disabled'} ${scoped.length} playlists` +
          (filtered ? ' (filter results only)' : ''));
      }
    });

    /* --- drag & drop --- */
    card.addEventListener('dragstart', ev=>{
      const row = ev.target.closest('.brow, .crow');
      if (!row) return;
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', ''); } catch(e){}
      if (row.classList.contains('crow')){
        const chDiv = row.closest('.chans');
        DRAG = { type:'chan', el: row, chans: chDiv, listId: id,
                 chan: (CHANS[`${id}|${chDiv.dataset.chans}`] || [])[Number(row.dataset.ci)] };
      } else {
        DRAG = { type:'branch', el: row, listId: id };
      }
      row.classList.add('dragging');
    });

    card.addEventListener('dragover', ev=>{
      if (!DRAG) return;
      $$('.drag-before, .drag-after, .drag-into', card).forEach(e=>e.classList.remove('drag-before','drag-after','drag-into'));
      DRAG.target = null; DRAG.into = false; DRAG.after = false;
      if (DRAG.type === 'chan'){
        const brow = ev.target.closest('.brow');
        const crow = ev.target.closest('.crow');
        let target = null;
        if (brow){ target = brow; DRAG.into = true; }            // channel dropped onto a playlist
        else if (crow && crow !== DRAG.el){
          target = crow;
          DRAG.into = crow.closest('.chans') !== DRAG.chans;     // another open branch: move it there
        }
        if (!target) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        if (DRAG.into){ target.classList.add('drag-into'); }
        else {
          const rect = target.getBoundingClientRect();
          DRAG.after = ev.clientY > rect.top + rect.height / 2;
          target.classList.add(DRAG.after ? 'drag-after' : 'drag-before');
        }
        DRAG.target = target;
        return;
      }
      // branch: edges = reorder, center = move all channels inside
      const brow = ev.target.closest('.brow');
      if (!brow || brow === DRAG.el) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const rect = brow.getBoundingClientRect();
      const rel = (ev.clientY - rect.top) / rect.height;
      if (rel < 0.3){ brow.classList.add('drag-before'); DRAG.after = false; }
      else if (rel > 0.7){ brow.classList.add('drag-after'); DRAG.after = true; }
      else { brow.classList.add('drag-into'); DRAG.into = true; }
      DRAG.target = brow;
    });

    card.addEventListener('drop', ev=>{
      ev.preventDefault();
      applyDrop(card, list);
    });

    card.addEventListener('dragend', ()=>dragCleanup(card));

    // on first focus of the "add channel" field, load suggestions
    card.addEventListener('focusin', async ev=>{
      const inp = ev.target.closest('[data-cadd]');
      if (inp){
        const dl = card.querySelector('[data-dladd]');
        if (dl && !dl.dataset.filled){
          dl.dataset.filled = '1';
          const ch = inp.closest('.chans');
          const pth = ch ? ch.dataset.chans : '';
          try {
            const r = await api(`/api/lists/${id}/suggest?path=${encodeURIComponent(pth)}`);
            dl.innerHTML = r.names.map((n) => `<option value="${esc(n)}">`).join('');
          } catch (_) { /* suggestions unavailable */ }
        }
        return;
      }
      const row = ev.target.closest('.brow, .crow');
      if (row) row.draggable = false;
    });
    card.addEventListener('focusout', ev=>{
      const row = ev.target.closest('.brow, .crow');
      if (row) row.draggable = true;
    });
  });
}

function updateBadge(card, list){
  const bs = branchesOf(list.id) || [];
  const active = bs.filter(b=>branchEnabled(list, b.path)).length;
  const badge = card.querySelector('[data-active-count]');
  if (badge) badge.textContent = `${active}/${bs.length} enabled`;
}

/* ---------- active playlists preview ---------- */

let MODAL_PREV_FOCUS = null;

function closeActiveModal(){
  const modal = $('#activeModal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  if (MODAL_PREV_FOCUS && document.contains(MODAL_PREV_FOCUS)) MODAL_PREV_FOCUS.focus();
  MODAL_PREV_FOCUS = null;
}

function openActiveModal(list){
  const modal = $('#activeModal');
  const body = $('#activeModalBody');
  const title = $('#activeModalTitle');
  if (!modal || !body || !title) return;
  const bs = branchesOf(list.id);
  const active = (bs || []).filter((b) => branchEnabled(list, b.path));
  title.textContent = `Enabled playlists · ${list.name || list.url || list.id}`;
  if (!bs){
    body.innerHTML = '<div class="hint">Playlists not loaded yet: wait for the list download or press <b>Refresh</b>.</div>';
  } else if (!active.length){
    body.innerHTML = '<div class="hint">No enabled playlist in this list.</div>';
  } else {
    body.innerHTML = `<div class="hint" style="margin:0 0 8px">${active.length} of ${bs.length} playlists enabled</div>`
      + active.map((b) => `<div class="activePrevRow"><b>${esc(branchDisplayName(list, b))}</b>`
        + `<span class="cnt">${Number(b.stations) || 0} channels${b.hidden ? ` · ${b.hidden} excluded` : ''}</span></div>`).join('');
  }
  MODAL_PREV_FOCUS = document.activeElement;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    const close = modal.querySelector('.modal-close');
    if (close) close.focus();
  });
}

function copyListLink(value, message){
  if (!value) return;
  copyText(value).then(
    () => toast(message),
    (e) => toast('Copy failed: ' + e.message, 4000)
  );
}

/** Closes the UA suggestion menus (all, or all except `keep`). */
function closeUaMenus(keep){
  $$('.uaCombo').forEach((combo) => {
    const menu = combo.querySelector('.uaMenu');
    if (!menu || menu === keep) return;
    menu.hidden = true;
    combo.classList.remove('open');
    const input = combo.querySelector('[data-ua-input]');
    const tgl = combo.querySelector('[data-ua-toggle]');
    if (input) input.setAttribute('aria-expanded', 'false');
    if (tgl) tgl.setAttribute('aria-expanded', 'false');
  });
}

/** Opens/closes the preset dropdown of a list; the input remains editable. */
function toggleUaMenu(card, force){
  const menu = card.querySelector('.uaMenu');
  if (!menu) return;
  closeRefreshMenus();
  const open = force === undefined ? menu.hidden : force;
  closeUaMenus(open ? menu : null);
  menu.hidden = !open;
  const combo = menu.closest('.uaCombo');
  if (combo) combo.classList.toggle('open', open);
  const input = card.querySelector('[data-ua-input]');
  const tgl = card.querySelector('[data-ua-toggle]');
  if (input) input.setAttribute('aria-expanded', String(open));
  if (tgl) tgl.setAttribute('aria-expanded', String(open));
  if (open) {
    const current = input ? input.value.trim() : '';
    $$('.uaOpt', menu).forEach((opt) => opt.classList.toggle('sel', opt.dataset.uaOpt === current));
  }
}

/** Closes the interval suggestion menus (all, or all except `keep`). */
function closeRefreshMenus(keep){
  $$('.refreshCombo').forEach((combo) => {
    const menu = combo.querySelector('.refreshMenu');
    if (!menu || menu === keep) return;
    menu.hidden = true;
    combo.classList.remove('open');
    const input = combo.querySelector('[data-refresh-input]');
    const tgl = combo.querySelector('[data-refresh-toggle]');
    if (input) input.setAttribute('aria-expanded', 'false');
    if (tgl) tgl.setAttribute('aria-expanded', 'false');
  });
}

/** Opens/closes the interval dropdown; the input stays editable. */
function toggleRefreshMenu(combo, force){
  if (!combo) return;
  const menu = combo.querySelector('.refreshMenu');
  const input = combo.querySelector('[data-refresh-input]');
  const tgl = combo.querySelector('[data-refresh-toggle]');
  if (!menu) return;
  const open = force === undefined ? menu.hidden : force;
  closeUaMenus();
  closeRefreshMenus(open ? menu : null);
  if (open) menu.innerHTML = refreshMenuHtml(combo.dataset.refreshScope || 'list', input ? input.value : '');
  menu.hidden = !open;
  combo.classList.toggle('open', open);
  if (input) input.setAttribute('aria-expanded', String(open));
  if (tgl) tgl.setAttribute('aria-expanded', String(open));
}

/** Applies a preset to the editable interval input. */
function applyRefreshPreset(btn){
  const combo = btn.closest('.refreshCombo');
  const input = combo && combo.querySelector('[data-refresh-input]');
  if (!combo || !input) return;
  const n = Math.max(0, Math.min(525600, Math.round(Number(btn.dataset.refreshOpt) || 0)));
  input.value = String(n);
  if (combo.dataset.refreshScope === 'global'){
    CFG.settings.refreshMinutes = n;
    updateRefreshHints();
    updateRefreshMeta();
  } else {
    const card = combo.closest('.listcard');
    const list = card && CFG.lists.find((l) => l.id === card.dataset.id);
    if (list){
      setPath(list, 'options.refreshMinutes', n);
      updateRefreshHints();
    }
  }
  closeRefreshMenus();
  input.dataset.skipOpen = '1';
  input.focus();
}

function setPath(obj, pathStr, value){
  const parts = pathStr.split('.');
  let cur = obj;
  for (let i=0;i<parts.length-1;i++) cur = cur[parts[i]];
  const key = parts[parts.length-1];
  if (key === 'excludeKeywords'){
    cur[key] = String(value).split('\n').map(s=>s.trim()).filter(Boolean);
  } else if (key === 'userAgent'){
    // one line only (header injection); the server sanitizes again on save
    cur[key] = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
  } else if (key === 'groupDepth' || key === 'refreshMinutes' || key === 'maxDepth'){
    cur[key] = Number(value) || 0;
  } else {
    cur[key] = value;
  }
}

/* ---------------- API ---------------- */
async function api(path, opts={}){
  const res = await fetch(apiUrl(path), {
    headers: {'Content-Type':'application/json'},
    ...opts
  });
  if (res.status === 401){
    const t = prompt('Admin token (ADMIN_TOKEN):') || '';
    localStorage.setItem('wisem3u_admin', t);
    return api(path, opts);
  }
  const ct = res.headers.get('content-type')||'';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok){
    const err = new Error((body && body.error) || res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ---------------- log live ---------------- */
const LOG = { since: 0, pause: false, lines: [] };
const LOG_MAX_LINES = 600; // DOM limit (the server keeps 1000)

function fmtLogTs(ts){
  const d = new Date(ts);
  const p = (n, l=2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(),3)}`;
}

async function pollLogs(){
  if (LOG.pause) return;
  try {
    const r = await api(`/api/logs?since=${LOG.since}&limit=300`);
    for (const e of (r.entries || [])){
      if (e.id > LOG.since) LOG.since = e.id;
      if (!LOG.lines.some(x => x.id === e.id)) LOG.lines.push(e);
    }
    if (LOG.lines.length > LOG_MAX_LINES) LOG.lines.splice(0, LOG.lines.length - LOG_MAX_LINES);
    if (r.entries && r.entries.length) renderLogs();
  } catch (_) { /* silent log: never disturb the UI with polling */ }
}

function renderLogs(){
  const box = $('#logBox');
  const scope = $('#logScope').value;
  const f = ($('#logFilter').value || '').trim().toLowerCase();
  const rows = LOG.lines.filter(e =>
    (scope === 'all' || e.scope === scope) &&
    (!f || e.msg.toLowerCase().includes(f) || e.scope.includes(f))
  );
  // auto-scroll only if the user is already at the bottom
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = rows.length
    ? rows.map(e =>
        `<span class="lgline ${e.level}"><span class="lgts">${fmtLogTs(e.ts)}</span><span class="lgscope">${esc(e.scope)}</span>${esc(e.msg)}</span>`
      ).join('')
    : `<div class="hint">${LOG.lines.length ? 'No event matches the filters.' : 'Waiting for events…'}</div>`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function exportLogs(){
  const scope = $('#logScope').value;
  const f = ($('#logFilter').value || '').trim().toLowerCase();
  const rows = LOG.lines.filter(e =>
    (scope === 'all' || e.scope === scope) &&
    (!f || e.msg.toLowerCase().includes(f) || e.scope.includes(f))
  );
  const text = rows.map(e => `${e.ts} [${e.level}] [${e.scope}] ${e.msg}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = `wisem3u-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('#logPause').addEventListener('click', () => {
  LOG.pause = !LOG.pause;
  $('#logPause').textContent = LOG.pause ? 'Resume' : 'Pause';
  $('#logPause').classList.toggle('on', LOG.pause);
});
$('#logClear').addEventListener('click', async () => {
  try { await api('/api/logs/clear', { method: 'POST', body: '{}' }); } catch (_) { /* ignore */ }
  LOG.lines.length = 0;
  LOG.since = 0;
  renderLogs();
});
$('#logScope').addEventListener('change', renderLogs);
$('#logFilter').addEventListener('input', renderLogs);
$('#logDownload').addEventListener('click', exportLogs);
setInterval(pollLogs, 1500);
pollLogs();
setInterval(pollListStates, 30000);

async function loadBranches(id){
  try {
    const r = await api(`/api/lists/${id}/tree`);
    if (r.fetching){ TREES[id] = null; return; }
    // the server sorts branches by the SAVED options.order: reapply the local
    // order (even if not yet saved) to avoid cancelling drags in progress
    const l = CFG && CFG.lists ? CFG.lists.find((x)=>x.id===id) : null;
    const order = (l && l.options && l.options.order) || [];
    if (order.length && Array.isArray(r.branches)){
      const pos = new Map(order.map((p,i)=>[p,i]));
      r.branches.sort((a,b)=>{
        const pa = pos.has(a.path) ? pos.get(a.path) : 1e9;
        const pb = pos.has(b.path) ? pos.get(b.path) : 1e9;
        return pa - pb;
      });
    }
    TREES[id] = r;
  } catch(e){ TREES[id] = null; }
}

/** Waits for the background download to finish, updating the UI.
 *  Polls /api/config: it always exists and the server also uses it to resume
 *  interrupted downloads by itself (e.g. after a restart). */
const POLLING = new Map(); // id -> promise, one polling loop per list

async function waitReady(id){
  const start = Date.now();
  let last = null;
  let fails = 0;
  while (Date.now() - start < 15*60*1000){
    await sleep(2500);
    let cfg;
    try { cfg = await api('/api/config'); fails = 0; }
    catch(e){
      if (++fails >= 10){ toast('The server is not responding: reload the page.', 6000); return false; }
      continue; // transient error: keep trying
    }
    const fresh = cfg.lists.find(x=>x.id===id);
    if (!fresh) return false; // list deleted
    const mine = CFG.lists.find(x=>x.id===id);
    const s = fresh.state || {};
    if (mine) mine.state = s;
    if (s.status !== last){ last = s.status; renderLists(); }
    if (s.status === 'ready'){
      if (mine && !mine.name && fresh.name){
        mine.name = fresh.name; // name assigned by the server...
        if (cfg.rev) CFG.rev = cfg.rev; // ...which also incremented the revision
      }
      await loadBranches(id);
      renderLists();
      return true;
    }
    if (s.status === 'error'){ toast('Error: ' + (s.error || 'sconosciuto'), 6000); renderLists(); return false; }
  }
  toast('The download is taking a long time: try again later with Refresh.', 6000);
  return false;
}

function pollUntilReady(id){
  if (POLLING.has(id)) return POLLING.get(id);
  const p = waitReady(id).finally(()=>POLLING.delete(id));
  POLLING.set(id, p);
  return p;
}

/** Starts polling for lists already downloading (e.g. page just opened). */
function monitorFetching(){
  for (const l of CFG.lists){
    if (l.state && l.state.status === 'fetching') pollUntilReady(l.id);
  }
}

async function loadConfig(){
  CFG = await api('/api/config');
  renderAll();
  await Promise.all(CFG.lists.map(l=>loadBranches(l.id)));
  renderAll();
  monitorFetching();
}

function renderAll(){
  $('#s_addonName').value = CFG.settings.addonName || '';
  $('#s_addonId').value = CFG.settings.addonId || '';
  const globalMinutes = Math.max(0, Math.round(Number(CFG.settings.refreshMinutes) || 0));
  $('#s_refreshMinutes').value = String(globalMinutes);
  $('#s_maxDepth').value = CFG.settings.maxDepth;
  $('#s_epgUrl').value = CFG.settings.epgUrl || '';
  const globalChecks = [
    ['#s_dedupeGlobal', !!CFG.settings.dedupeGlobal],
    ['#s_fitLogos', CFG.settings.fitLogos !== false],
    ['#s_streamDiag', !!CFG.settings.streamDiag],
  ];
  for (const [sel, on] of globalChecks){
    const el = $(sel);
    el.checked = on;
    const box = el.closest('.chk');
    if (box) box.classList.toggle('on', on);
  }
  const base = location.origin.replace(/\/+$/, '');
  $('#manifestLink').href = base + '/manifest.json';
  $('#m3uLink').href = base + '/playlist.m3u';
  renderLists();
  const activeLists = CFG.lists.filter(l=>l.options.enabled).length;
  $('#status').textContent = `${activeLists} enabled · ${CFG.lists.length} total`;
  if (CFG.version && String(CFG.version) !== WM_UI_VERSION){
    // page stale in the browser: UI and server are not aligned (possible "ghost" bugs)
    const el = $('#appVersion');
    el.textContent = `WiseM3U v${CFG.version} ⚠ UI page v${WM_UI_VERSION}: reload with Ctrl+Shift+R`;
    el.style.color = 'var(--warn)';
    toast('Stale configuration page (browser cache): press Ctrl+Shift+R to update it', 6000);
  } else {
    $('#appVersion').textContent = CFG.version ? `WiseM3U v${CFG.version}` : '';
  }
}

function readSettings(){
  CFG.settings.addonName = $('#s_addonName').value.trim() || 'WiseM3U';
  CFG.settings.addonId = $('#s_addonId').value.trim() || 'community.wisem3u';
  CFG.settings.refreshMinutes = Number($('#s_refreshMinutes').value) || 0;
  CFG.settings.maxDepth = Number($('#s_maxDepth').value) || 8;
  CFG.settings.epgUrl = $('#s_epgUrl').value.trim();
  CFG.settings.dedupeGlobal = $('#s_dedupeGlobal').checked;
  CFG.settings.fitLogos = $('#s_fitLogos').checked;
  CFG.settings.streamDiag = $('#s_streamDiag').checked;
}

async function saveConfig(){
  readSettings();
  const payload = { settings: CFG.settings, lists: CFG.lists, reason: 'manual save', baseRev: CFG.rev };
  try {
    const saved = await api('/api/config', { method:'PUT', body: JSON.stringify(payload) });
    CFG = saved;
    renderAll();
    loadHistory();
    toast('Configuration saved ✔');
  } catch(e){
    if (e.status === 409){
      // someone else (another tab, automatic merge, refresh) changed the
      // configuration: do not overwrite, ask whether to realign with the server
      if (confirm('The configuration changed elsewhere (another tab or an automatic operation).\nReload the server version? Unsaved changes on this page will be lost.')){
        await loadConfig();
        loadHistory();
        toast('Configuration reloaded from the server');
      } else {
        toast('Save cancelled: the server has a newer version', 6000);
      }
      return;
    }
    toast('Error: '+e.message, 4000);
  }
}

async function refreshList(id, btn){
  if (btn){ btn.disabled = true; btn.textContent = 'Refreshing…'; }
  const l = CFG.lists.find(x=>x.id===id);
  try {
    await api(`/api/lists/${id}/refresh`, { method:'POST' });
    if (l) l.state = { status:'fetching' };
    renderLists();
    const ok = await pollUntilReady(id);
    if (ok) toast('List refreshed ✔');
  } catch(e){ toast('Error: '+e.message, 4000); }
  finally { renderLists(); }
}

async function delList(id){
  try {
    const r = await api(`/api/lists/${id}`, { method:'DELETE' });
    delete TREES[id];
    await loadConfig();
    showUndo('List deleted', r.undo);
  } catch(e){ toast('Error: '+e.message); }
}

/** URL pasted from HTML pages/messages: &amp;/&#38; go back to & (see also server side). */
function cleanListUrl(s){
  return String(s || '').trim().replace(/&amp;/gi, '&').replace(/&#0?38;/gi, '&');
}

async function addList(){
  const url = cleanListUrl($('#newUrl').value);
  const name = $('#newName').value.trim();
  if (!url) return toast('Enter a URL');
  const btn = $('#btnAdd'); btn.disabled = true; btn.textContent = 'Adding…';
  try {
    const r = await api('/api/lists', { method:'POST', body: JSON.stringify({ url, name }) });
    OPEN_LISTS.add(r.list.id);   // the newly created list opens by itself
    $('#newUrl').value = ''; $('#newName').value = '';
    await loadConfig();
    toast('List added: downloading in background…');
    const ok = await pollUntilReady(r.list.id);
    if (ok) toast('List ready: set up the branches below ✔');
  } catch(e){ toast('Error: '+e.message, 5000); }
  finally { btn.disabled=false; btn.textContent='Add'; renderLists(); }
}

async function testEasyProxy(card, list, btn){
  const box = card.querySelector('[data-epbox]');
  if (!list.options.easyProxy){
    box.innerHTML = '<div class="err">Enter the EasyProxy URL first.</div>';
    return;
  }
  btn.disabled = true;
  box.innerHTML = '<div class="hint">Testing the connection…</div>';
  try {
    const r = await api('/api/easyproxy/test', { method:'POST', body: JSON.stringify({
      base: String(list.options.easyProxy || '').trim().replace(/\/+$/, ''),
      password: list.options.easyProxyPassword || '',
      testUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    })});
    if (!r.ok){
      if (epNetErr(r.error)) {
        box.innerHTML = `<div class="warn"><b>Non-blocking warning.</b> ${esc(r.error || 'Connection failed')}${epHint(r.error)}</div>`;
      } else {
        box.innerHTML = `<div class="err">${esc(r.error || 'Connection failed')}${epHint(r.error)}</div>`;
      }
    } else {
      const v = r.info || {};
      const pt = r.proxyTest;
      const ptHtml = pt
        ? (pt.error
          ? `<span class="pill">proxy test <b style="color:#ffb4ab">KO</b></span><div class="${epNetErr(pt.error)?'warn':'err'}" style="margin-top:6px">${epNetErr(pt.error)?'<b>Non-blocking warning.</b> ':''}${esc(pt.error)}${epHint(pt.error)}</div>`
          : `<span class="pill">proxy test <b style="color:#9be7b4">HTTP ${pt.status}</b> (${pt.ms} ms)</span>`)
        : '';
      box.innerHTML = `<div class="hint" style="margin-top:8px">
        <span class="pill">EasyProxy <b style="color:#9be7b4">reachable</b></span>
        ${v.version?`<span class="pill">version <b style="color:#fff">${esc(v.version)}</b></span>`:''}
        ${v.public_ip?`<span class="pill">exit IP <b style="color:#fff">${esc(v.public_ip)}</b></span>`:''}
        ${ptHtml}
      </div>
      <div class="hint">If the proxy test returns <b>HTTP 200</b> streams go through EasyProxy.
        Remember to <b>Save configuration</b> to apply the URL rewrite.</div>`;
    }
  } catch(e){
    box.innerHTML = `<div class="${epNetErr(e.message)?'warn':'err'}">${epNetErr(e.message)?'<b>Non-blocking warning.</b> ':''}${esc(e.message)}${epHint(e.message)}</div>`;
  }
  finally { btn.disabled = false; }
}

/** True if the test error is network/certificate: non-blocking, because the client is the one connecting. */
function epNetErr(err){
  return /timeout|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|getaddrinfo|certificate|self signed|self-signed|unable to verify|SSL routines|public DNS/i.test(String(err || ''));
}

/** Targeted hint based on the EasyProxy test error type. */
function epHint(err){
  const e = String(err || '');
  if (/certificate|self signed|self-signed|unable to verify|SSL routines/i.test(e)) {
    return ' The container does not trust the certificate: this is non-blocking; what matters is that the client (TV/phone) trusts it. With a Let\'s Encrypt certificate this is automatic.';
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|timeout/i.test(e)) {
    return ' On home networks the container often cannot reach its own public domain (no NAT hairpin): this is non-blocking; check playback on the client.';
  }
  return '';
}

async function probe(){
  const url = cleanListUrl($('#newUrl').value);
  if (!url) return toast('Enter a URL');
  const box = $('#probeBox');
  box.innerHTML = '<div class="hint">Downloading and analyzing…</div>';
  try {
    const r = await api('/api/probe', { method:'POST', body: JSON.stringify({ url }) });
    const t = r.tree;
    box.innerHTML = `<div class="hint" style="margin-top:10px">
      <span class="pill">name <b style="color:#fff">${esc(t.meta.name)}</b></span>
      <span class="pill">format <b style="color:#fff">${esc(t.meta.kind || 'wiseplay')}</b></span>
      <span class="pill">nodes <b style="color:#fff">${t.stats.nodes}</b></span>
      <span class="pill">stream <b style="color:#fff">${t.stats.stations}</b></span>
      <span class="pill">imported m3u <b style="color:#fff">${t.stats.m3u}</b></span>
      ${t.errors.length?`<span class="pill">errors <b style="color:#fff">${t.errors.length}</b></span>`:''}
    </div>`;
  } catch(e){ box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ---------------- clipboard copy ---------------- */
function copyText(t){
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
  return new Promise((res, rej) => {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy') ? res() : rej(new Error('copy failed')); }
    catch(e){ rej(e); }
    finally { ta.remove(); }
  });
}

/* ---------------- init ---------------- */
$('#manifestLink').addEventListener('click', (ev) => {
  ev.preventDefault();
  copyText(ev.currentTarget.href).then(
    () => toast('manifest copied ✔'),
    (e) => toast('Copy failed: ' + e.message, 4000)
  );
});
$('#m3uLink').addEventListener('click', (ev) => {
  ev.preventDefault();
  copyText(ev.currentTarget.href).then(
    () => toast('m3u copied ✔'),
    (e) => toast('Copy failed: ' + e.message, 4000)
  );
});

$('#activeModal').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-modal-close]')) closeActiveModal();
});
document.addEventListener('keydown', (ev) => {
  const modal = $('#activeModal');
  if (ev.key === 'Escape' && modal && !modal.hidden) closeActiveModal();
});
$('#btnAdd').addEventListener('click', addList);
$('#newUrl').addEventListener('keydown', e=>{ if(e.key==='Enter') addList(); });
$('#btnNewPList').addEventListener('click', createPersonalList);
const sdToggle = $('#sdToggle');
const sidemenu = $('#sidemenu');
function setSideMenu(open){
  sidemenu.hidden = !open;
  sdToggle.setAttribute('aria-expanded', String(!!open));
}
sdToggle.addEventListener('click', (ev) => {
  ev.stopPropagation();
  setSideMenu(sidemenu.hidden);
});
// Tapping outside the floating menu (or pressing Escape) closes it: on phones
// it is a bottom sheet and must not stay over the page while scrolling.
document.addEventListener('click', (ev) => {
  if (!sidemenu.hidden && !ev.target.closest('#sidemenu,#sdToggle')) setSideMenu(false);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !sidemenu.hidden) setSideMenu(false);
});
$('#sidemenu').addEventListener('click', async (ev) => {
  const go = ev.target.closest('[data-sdgo]');
  if (go){
    const card = document.querySelector(`#lists [data-id="${CSS.escape(go.dataset.sdgo)}"]`);
    if (card){
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
    }
    // on smartphones the menu is a bottom sheet: close it, otherwise it covers the reached list
    setSideMenu(false);
    return;
  }
});
function sdDragCleanup(){
  $$('#sidemenu .sditem').forEach(el => el.classList.remove('dragging','drag-before','drag-after'));
  SD_DRAG = null;
}

$('#sidemenu').addEventListener('dragstart', (ev) => {
  if (!ev.target.closest('[data-sdhandle]')) { ev.preventDefault(); return; }
  const item = ev.target.closest('.sditem');
  if (!item) return;
  SD_DRAG = { el: item, from: Number(item.dataset.sdindex), to: null, after: false };
  if (ev.dataTransfer){
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', String(SD_DRAG.from)); } catch (_) { /* ignore */ }
  }
  item.classList.add('dragging');
});
$('#sidemenu').addEventListener('dragover', (ev) => {
  if (!SD_DRAG) return;
  const item = ev.target.closest('.sditem');
  if (!item || item === SD_DRAG.el) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  $$('#sidemenu .sditem').forEach(el => el.classList.remove('drag-before','drag-after'));
  const rect = item.getBoundingClientRect();
  SD_DRAG.to = Number(item.dataset.sdindex);
  SD_DRAG.after = ev.clientY > rect.top + rect.height / 2;
  item.classList.add(SD_DRAG.after ? 'drag-after' : 'drag-before');
});
$('#sidemenu').addEventListener('drop', async (ev) => {
  if (!SD_DRAG) return;
  ev.preventDefault();
  const drag = SD_DRAG;
  sdDragCleanup();
  if (drag.to == null || drag.to === drag.from) return;
  if (!moveList(drag.from, drag.to, drag.after)) return;
  await saveConfig();
});
$('#sidemenu').addEventListener('dragend', sdDragCleanup);

// Touch/pen: native HTML5 drag does not work on most mobile browsers, so the
// same handle also supports pointer dragging.
let SD_PTR = null;
$('#sidemenu').addEventListener('pointerdown', (ev) => {
  if (ev.pointerType === 'mouse') return; // mouse uses native drag & drop above
  const handle = ev.target.closest('[data-sdhandle]');
  const item = handle && handle.closest('.sditem');
  if (!item) return;
  SD_PTR = { id: ev.pointerId, el: item, from: Number(item.dataset.sdindex), to: null, after: false, moved: false, x: ev.clientX, y: ev.clientY };
  try { handle.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
  ev.preventDefault();
});
$('#sidemenu').addEventListener('pointermove', (ev) => {
  if (!SD_PTR || ev.pointerId !== SD_PTR.id) return;
  if (!SD_PTR.moved && Math.hypot(ev.clientX - SD_PTR.x, ev.clientY - SD_PTR.y) < 6) return;
  SD_PTR.moved = true;
  ev.preventDefault();
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const item = under && under.closest && under.closest('#sidemenu .sditem');
  $$('#sidemenu .sditem').forEach(el => el.classList.remove('drag-before','drag-after'));
  if (!item || item === SD_PTR.el){ SD_PTR.to = null; return; }
  const rect = item.getBoundingClientRect();
  SD_PTR.to = Number(item.dataset.sdindex);
  SD_PTR.after = ev.clientY > rect.top + rect.height / 2;
  item.classList.add(SD_PTR.after ? 'drag-after' : 'drag-before');
  SD_PTR.el.classList.add('dragging');
});
async function sdPointerEnd(ev){
  if (!SD_PTR || (ev && ev.pointerId !== SD_PTR.id)) return;
  const drag = SD_PTR;
  SD_PTR = null;
  $$('#sidemenu .sditem').forEach(el => el.classList.remove('dragging','drag-before','drag-after'));
  if (!drag.moved || drag.to == null || drag.to === drag.from) return;
  if (!moveList(drag.from, drag.to, drag.after)) return;
  await saveConfig();
}
$('#sidemenu').addEventListener('pointerup', sdPointerEnd);
$('#sidemenu').addEventListener('pointercancel', sdPointerEnd);

$('#sidemenu').addEventListener('keydown', async (ev) => {
  if (!ev.target.closest('[data-sdhandle]')) return;
  const item = ev.target.closest('.sditem');
  if (!item) return;
  const from = Number(item.dataset.sdindex);
  const delta = ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0;
  if (!delta) return;
  ev.preventDefault();
  const to = from + delta;
  if (!moveList(from, to, delta > 0)) return;
  await saveConfig();
  const next = document.querySelector('#sidemenu .sditem[data-sdindex="' + to + '"] [data-sdhandle]');
  if (next) next.focus();
});

$('#btnProbe').addEventListener('click', probe);
$('#btnSave').addEventListener('click', saveConfig);
$('#btnClearCache').addEventListener('click', async ()=>{
  if(!confirm('Clear the cache of all lists?')) return;
  try { await api('/api/cache/clear',{method:'POST'}); toast('Cache cleared'); } catch(e){ toast(e.message); }
});

/* ---------------- configuration history ---------------- */

const HIST = { entries: [] };

const HIST_CATS = [
  ['settings', 'General settings'],
  ['lists', 'List collection (names and URLs)'],
  ['order', 'Playlist order'],
  ['names', 'Playlist and channel names'],
  ['exclusions', 'Esclusioni'],
  ['moves', 'Merges and moves'],
  ['trash', 'Trash'],
  ['groups', 'Custom groups'],
  ['listSettings', 'List settings'],
];
const HIST_LABEL = Object.fromEntries(HIST_CATS);

function histListOptions(){
  const sel = $('#histList');
  if (!sel || typeof CFG === 'undefined' || !CFG) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All lists</option>' +
    CFG.lists.map((l)=>`<option value="${esc(l.id)}">${esc(l.name || l.url || l.id)}</option>`).join('');
  if (cur && CFG.lists.some((l)=>l.id===cur)) sel.value = cur;
}

function describeChanges(ch){
  if (!ch) return 'no differences computed';
  const parts = [];
  if (ch.settings) parts.push('general settings');
  if (ch.lists) parts.push('list collection');
  const cats = new Set();
  for (const arr of Object.values(ch.options || {})) (arr || []).forEach((c)=>cats.add(c));
  for (const c of cats){
    const label = HIST_LABEL[c] || c;
    parts.push((window.WM_I18N && WM_I18N.translate(label)) || label);
  }
  return parts.length ? `Changes: ${parts.join(', ')}` : 'No differences';
}

function renderHistory(){
  const box = $('#histBody');
  if (!box) return;
  if (!HIST.entries.length){
    box.innerHTML = '<div class="hint">No changes recorded: history starts with the next save.</div>';
    return;
  }
  box.innerHTML = HIST.entries.map((e)=>{
    const when = new Date(e.ts).toLocaleString((window.WM_I18N && WM_I18N.locale()) || 'en');
    return `<div class="histrow" data-hrow="${esc(e.id)}">
      <div class="histhead">
        <b>${esc(when)}</b>
        ${e.name ? `<span class="badge ready">★ ${esc(e.name)}</span>` : ''}
        ${e.reason ? `<span class="badge idle">${esc(e.reason)}</span>` : ''}
        ${e.listName ? `<span class="cnt">${esc(e.listName)}</span>` : ''}
        <div class="histactions"><button class="ghost small" data-hpick="${esc(e.id)}">${e.name ? '↩ Restore checkpoint…' : '↩ Restore…'}</button></div>
      </div>
      <div class="histchanges">${esc(describeChanges(e.changes))}</div>
      <div class="histrestore" hidden data-hpanel="${esc(e.id)}"></div>
    </div>`;
  }).join('');
}

function histPanelHtml(entry){
  const listId = $('#histList').value;
  // a checkpoint represents the full state: start with all categories
  // checked (the user can still uncheck some)
  const all = !!entry.name;
  const cats = HIST_CATS
    .filter(([k])=>!(k === 'lists' && listId))
    .map(([k,label])=>`<label class="hopt"><input type="checkbox" name="hcat" value="${k}" ${
      (all || (k !== 'settings' && k !== 'lists')) ? 'checked' : ''}>${esc(label)}</label>`)
    .join('');
  const when = new Date(entry.ts).toLocaleString((window.WM_I18N && WM_I18N.locale()) || 'en');
  return `<div class="hint">${all ? `Checkpoint <b>★ ${esc(entry.name)}</b> from <b>${esc(when)}</b>. All categories are checked: uncheck the ones you do not want to restore.` : `State from <b>${esc(when)}</b>${entry.listName ? ` · ${esc(entry.listName)}` : ''}.`}
      ${listId ? 'The categories apply only to the selected list.' : 'Option categories apply to all lists.'}
      <br>The restore will be recorded as a new state: you can undo it.</div>
    <div class="hcats">${cats}</div>
    <div class="hrow">
      <button class="danger small" data-hgo="${esc(entry.id)}">Restore selected</button>
      <button class="ghost small" data-hcancel="1">Cancel</button>
    </div>`;
}

async function saveCheckpoint(){
  const name = (prompt('Checkpoint name (e.g. “before the merge”):') || '').trim().slice(0, 80);
  if (!name) return;
  try {
    await api('/api/history/checkpoints', { method:'POST', body: JSON.stringify({ name }) });
    // the checkpoint is global: remove the filter to see it immediately in the list
    $('#histList').value = '';
    toast('Checkpoint «' + name + '» saved ✔');
    await loadHistory();
  } catch(e){ toast('Error: '+e.message, 4000); }
}

async function loadHistory(){
  const box = $('#histBody');
  if (!box) return;
  histListOptions();
  const listId = $('#histList').value;
  $('#histStatus').textContent = 'Loading…';
  try {
    const r = await api('/api/history' + (listId ? `?list=${encodeURIComponent(listId)}` : ''));
    HIST.entries = r.entries || [];
    renderHistory();
    $('#histStatus').textContent = `${HIST.entries.length} states`;
  } catch (e){
    HIST.entries = [];
    box.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    $('#histStatus').textContent = '';
  }
}

(function bindHistory(){
  const card = $('#historyCard');
  if (!card) return;
  $('#histReload').addEventListener('click', loadHistory);
  $('#histCheckpoint').addEventListener('click', saveCheckpoint);
  $('#histList').addEventListener('change', loadHistory);
  card.addEventListener('click', async (ev)=>{
    const pick = ev.target.closest('[data-hpick]');
    if (pick){
      const panel = card.querySelector(`[data-hpanel="${CSS.escape(pick.dataset.hpick)}"]`);
      const entry = HIST.entries.find((e)=>e.id === pick.dataset.hpick);
      if (!panel || !entry) return;
      if (!panel.hidden){ panel.hidden = true; panel.innerHTML = ''; return; }
      card.querySelectorAll('[data-hpanel]').forEach((p)=>{ p.hidden = true; p.innerHTML = ''; });
      panel.innerHTML = histPanelHtml(entry);
      panel.hidden = false;
      return;
    }
    if (ev.target.closest('[data-hcancel]')){
      card.querySelectorAll('[data-hpanel]').forEach((p)=>{ p.hidden = true; p.innerHTML = ''; });
      return;
    }
    const go = ev.target.closest('[data-hgo]');
    if (!go) return;
    const panel = go.closest('[data-hpanel]');
    const entry = HIST.entries.find((e)=>e.id === go.dataset.hgo);
    if (!panel || !entry) return;
    const listId = $('#histList').value;
    const cats = [...panel.querySelectorAll('input[name="hcat"]:checked')].map((i)=>i.value);
    if (!cats.length){ toast('Check at least one category to restore'); return; }
    const when = new Date(entry.ts).toLocaleString((window.WM_I18N && WM_I18N.locale()) || 'en');
    const msg = entry.name
      ? `Restore the selected categories from checkpoint «${entry.name}»?`
      : `Restore the selected categories from the state of ${when}?`;
    if (!confirm(msg + '\nA new state will be created, so you can undo this restore too.')) return;
    go.disabled = true;
    try {
      const r = await api(`/api/history/${encodeURIComponent(entry.id)}/restore`, {
        method: 'POST',
        body: JSON.stringify({
          settings: cats.includes('settings'),
          lists: cats.includes('lists'),
          options: cats.filter((c)=>c !== 'settings' && c !== 'lists'),
          listId,
        }),
      });
      await loadConfig();
      for (const lid of Object.keys((r.restored && r.restored.options) || {})) await loadBranches(lid);
      renderLists();
      for (const lid of [...TRASHOPEN]) await refreshTrash(lid);
      renderLists();
      toast('Restore completed ✔');
      await loadHistory();
    } catch (e){ toast(e.message, 4000); go.disabled = false; }
  });
})();

/* language change: redraw the parts with dates/numbers formatted in the chosen locale */
document.addEventListener('wm:language', () => {
  if (CFG) { renderLists(); renderSideMenu(); }
  if (typeof HIST !== 'undefined' && HIST.entries.length) renderHistory();
  renderLogs();
});

/* ---------------- info icons and collapsible sections ---------------- */

/** Wraps the title text in a span (.ttl) so that number, title,
 *  info icon and expand button always stay on the same line. */
function wrapHeadingText(h2){
  if (!h2 || h2.querySelector(':scope > .ttl')) return;
  const texts = [...h2.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
  if (!texts.length) return;
  const ttl = document.createElement('span');
  ttl.className = 'ttl';
  texts[0].before(ttl);
  texts.forEach(n => ttl.appendChild(n));
}

/** Moves all info notes of a container next to its title,
 *  into a single panel (i) that opens on tap. */
function collectInfo(container, host, { skip }={}){
  if (!container || !host || host.querySelector(':scope > .sectinfo')) return;
  const items = [...container.querySelectorAll('[data-info], details.help')]
    .filter(el => !el.closest('details.info') && !(skip && el.closest(skip)));
  if (!items.length) return;

  const panel = document.createElement('details');
  panel.className = 'info sectinfo';
  const sum = document.createElement('summary');
  sum.textContent = 'i';
  sum.title = 'Information';
  sum.setAttribute('aria-label', 'Information');
  const body = document.createElement('div');
  body.className = 'ibody';

  for (const el of items){
    let label = '';
    let content = null;
    if (el.matches('details.help')){
      const s = el.querySelector('summary');
      label = (s ? s.textContent : '').trim().replace(/^[^\p{L}\p{N}]+/u, '');
      content = el.querySelector('.hint');
      el.remove();                       // the help block becomes a note in the panel
    } else {
      const p = el.parentElement;
      const lab = (p && p !== container) ? p.querySelector('label') : null;
      label = lab ? lab.textContent.trim() : '';
      content = el;
    }
    if (!content) continue;
    const note = document.createElement('div');
    note.className = 'inote';
    if (label){
      const l = document.createElement('div');
      l.className = 'ilabel';
      l.textContent = label;
      note.appendChild(l);
    }
    note.appendChild(content);
    body.appendChild(note);
  }
  if (!body.children.length) return;
  panel.append(sum, body);
  host.appendChild(panel);
}

/** Static sections (1, 2, 3, 5): info in the title. */
function decorateSections(){
  document.querySelectorAll('main > section.card').forEach(sec=>{
    const h2 = sec.querySelector(':scope > h2');
    if (!h2 || h2.dataset.deco) return;
    h2.dataset.deco = '1';
    wrapHeadingText(h2);
    collectInfo(sec, h2);
  });
  document.querySelectorAll('main > h2.secttl').forEach(h2=>{
    if (h2.dataset.deco) return;
    h2.dataset.deco = '1';
    wrapHeadingText(h2);
    const sec = h2.nextElementSibling;
    if (sec && sec.matches('section.card') && !sec.querySelector(':scope > h2')) collectInfo(sec, h2);
  });
}

/** List cards: info next to the name; the playlist block has its own panel. */
function decorateCards(root=document){
  root.querySelectorAll('.listcard').forEach(card=>{
    if (card.dataset.deco) return;
    card.dataset.deco = '1';
    const slot = card.querySelector('.linfo');
    collectInfo(card, slot, { skip: '.plwrap' });
    const plwrap = card.querySelector('.plwrap');
    const plh = card.querySelector('.plhead h2');
    if (plh){ wrapHeadingText(plh); if (plwrap) collectInfo(plwrap, plh); }
  });
}

/** Makes the section title clickable (▾/▸ is just an indicator). */
function makeSectionToggle(h2, apply, initiallyCollapsed=false){
  if (!h2 || h2.querySelector('.sectgl')) return;
  let collapsed = false;
  const b = document.createElement('span');
  b.className = 'sectgl';
  b.setAttribute('aria-hidden', 'true');
  const sync = ()=>{
    apply(collapsed);
    b.textContent = collapsed ? '\u25b8' : '\u25be';
    h2.setAttribute('aria-expanded', String(!collapsed));
    h2.title = collapsed ? 'Expand the section' : 'Collapse the section';
  };
  const toggle = ()=>{ collapsed = !collapsed; sync(); };
  h2.setAttribute('role', 'button');
  h2.tabIndex = 0;
  h2.addEventListener('click', ev=>{
    // the info icon and any controls inside the title do not squeeze the section
    if (ev.target.closest('details.info, a, button, input, select, label, summary')) return;
    toggle();
  });
  h2.addEventListener('keydown', ev=>{
    if (ev.target.closest('details.info')) return;
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar'){ ev.preventDefault(); toggle(); }
  });
  h2.appendChild(b);
  collapsed = !!initiallyCollapsed;
  sync();
}

function initCollapsibleSections(){
  // sections with the title inside (1, 2, 3): the content collapses, the title stays
  document.querySelectorAll('main > section.card').forEach(sec=>{
    const h2 = sec.querySelector(':scope > h2');
    if (h2) makeSectionToggle(h2, (c)=>sec.classList.toggle('collapsed', c), sec.dataset.collapsed === '1');
  });
  // Section titles outside a card (3 Your lists, 4 history, 5 logs): the
  // whole following block is hidden. This also closes every list card inside.
  document.querySelectorAll('main > h2.secttl').forEach(h2=>{
    const sec = h2.nextElementSibling;
    if (sec) makeSectionToggle(h2, (c)=>{ sec.hidden = c; }, h2.dataset.collapsed === '1');
  });
}

decorateSections();
initCollapsibleSections();

/* ---- info: panel anchoring without leaving the screen ---- */
(function placeInfoPanels(){
  document.addEventListener('toggle', (ev)=>{
    const p = ev.target;
    if (!p || !p.classList || !p.classList.contains('sectinfo') || !p.open) return;
    if (window.matchMedia && window.matchMedia('(max-width:560px)').matches) return; // mobile: fixed sheet
    requestAnimationFrame(()=>{
      const body = p.querySelector('.ibody');
      if (!body) return;
      body.style.left = '0'; body.style.right = 'auto';
      const r = p.getBoundingClientRect();
      const w = body.getBoundingClientRect().width;
      const vw = document.documentElement.clientWidth;
      if (r.left + w > vw - 12){ body.style.left = 'auto'; body.style.right = '0'; }
    });
  }, true);

  // only one panel open at a time
  document.addEventListener('toggle', (ev)=>{
    const p = ev.target;
    if (!p || !p.classList || !p.classList.contains('sectinfo') || !p.open) return;
    document.querySelectorAll('details.sectinfo[open]').forEach(d=>{ if (d !== p) d.open = false; });
  }, true);
})();

/* ---- info: close on tap outside the panel or with Esc ---- */
(function closeInfoPanels(){
  const closeAll = ()=>{ document.querySelectorAll('details.sectinfo[open]').forEach(d=>{ d.open = false; }); };
  document.addEventListener('pointerdown', (ev)=>{
    document.querySelectorAll('details.sectinfo[open]').forEach(d=>{
      if (!d.contains(ev.target)) d.open = false;
    });
  }, true);
  document.addEventListener('keydown', (ev)=>{ if (ev.key === 'Escape') closeAll(); });
})();

/* ---- keyboard: floating buttons must not float above the keys ---- */
(function watchKeyboard(){
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = ()=>{
    // on iOS the layout viewport does not change: the drop in visualViewport.height is the signal
    const shrunk = (window.innerHeight - vv.height) > 120;
    document.body.classList.toggle('kbd', shrunk);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', ()=>setTimeout(apply, 300));
  document.addEventListener('focusout', ()=>setTimeout(apply, 50));
  apply();
})();

$('#fabSave').addEventListener('click', saveConfig);

/* back to top: always floating on mobile, smooth scroll unless user preference */
$('#toTop').addEventListener('click', ()=>{
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try { window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); }
  catch (_) { window.scrollTo(0, 0); }
});

// Keep the Material 3 "on" style in sync for every checkbox card.
document.addEventListener('change', (ev) => {
  const box = ev.target.closest && ev.target.closest('.chk');
  if (box && ev.target.type === 'checkbox') box.classList.toggle('on', ev.target.checked);
});

// Close the UA/interval presets when clicking outside their combo.
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.uaCombo')) closeUaMenus();
  if (!ev.target.closest('.refreshCombo')) closeRefreshMenus();
});

// Interval combo: the input remains editable, the arrow/hover opens presets.
document.addEventListener('click', (ev) => {
  const tgl = ev.target.closest('[data-refresh-toggle]');
  if (tgl){ toggleRefreshMenu(tgl.closest('.refreshCombo')); return; }
  const opt = ev.target.closest('[data-refresh-opt]');
  if (opt){ applyRefreshPreset(opt); return; }
  const input = ev.target.closest('[data-refresh-input]');
  if (input){
    if (input.dataset.skipOpen){ delete input.dataset.skipOpen; return; }
    toggleRefreshMenu(input.closest('.refreshCombo'), true);
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  closeUaMenus();
  closeRefreshMenus();
});

const globalRefreshInput = $('#s_refreshMinutes');
globalRefreshInput.addEventListener('focus', () => {
  if (globalRefreshInput.dataset.skipOpen){ delete globalRefreshInput.dataset.skipOpen; return; }
  toggleRefreshMenu($('#globalRefreshCombo'), true);
});

// Xtream badge: click to re-read the data (no inline handler in the markup)
document.addEventListener('click', (ev) => {
  const badge = ev.target.closest('[data-xtream]');
  if (badge) refreshXtreamBadge(badge.dataset.xtream);
});

$('#s_refreshMinutes').addEventListener('input', (ev)=>{
  closeRefreshMenus();
  CFG.settings.refreshMinutes = Math.max(0, Math.round(Number(ev.target.value) || 0));
  updateRefreshHints();
  updateRefreshMeta();
});

$('#s_refreshMinutes').addEventListener('change', (ev)=>{
  let n = Math.round(Number(ev.target.value) || 0);
  if (n < 0) n = 0;
  if (n > 0 && n < 5) n = 5;
  n = Math.min(525600, n);
  ev.target.value = String(n);
  CFG.settings.refreshMinutes = n;
  updateRefreshHints();
  updateRefreshMeta();
});

loadConfig().then(()=>{ loadHistory(); }).catch(e=>{
  $('#lists').innerHTML = `<section class="card"><div class="err">Unable to load the configuration: ${esc(e.message)}</div></section>`;
});
