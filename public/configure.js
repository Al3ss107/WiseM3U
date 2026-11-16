'use strict';

/* WiseM3U — pagina di configurazione: logica lato browser */
// versione iniettata dal server nella meta tag (mai hardcoded nel sorgente)
const WM_UI_VERSION = (document.querySelector('meta[name="wm-ui-version"]') || {}).content || '';
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
let CFG = null;
let TREES = {};   // id -> { meta, fetchedAt, branches:[{path,name,displayName,stations,image,enabled}] }

const PROTO_LABEL = { http:'HTTP/HLS', ace:'AceStream', rtmp:'RTMP', rtsp:'RTSP', other:'altri' };

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
    b.textContent = act.label || 'Annulla';
    b.addEventListener('click', () => { hide(); act.onClick(); });
    t.appendChild(b);
    t.classList.add('has-act');
  } else {
    t.classList.remove('has-act');
  }
  t.classList.add('show');
  if (ms > 0) t._h = setTimeout(hide, ms);
}

/** Ricarica la UI dopo un annullamento: config, alberi, cestino e cronologia. */
async function reloadAfterUndo(ids){
  await loadConfig();
  for (const id of ids || []){
    if (!CFG.lists.some((l)=>l.id === id)) continue;
    if (TRASHOPEN.has(id)) await refreshTrash(id);
  }
  renderLists();
  loadHistory();
}

/** Mostra il toast con «Annulla»; se il server non ha fornito un punto di
 *  ripristino (undo nullo) mostra il messaggio normale. */
function showUndo(msg, undo){
  if (!undo || !undo.id){ toast(msg); return; }
  toast(msg, 9000, { action: { label: 'Annulla', onClick: async () => {
    try {
      const r = await api(`/api/history/${encodeURIComponent(undo.id)}/undo`, {
        method: 'POST',
        body: JSON.stringify({ listIds: undo.listIds || [] }),
      });
      toast('Operazione annullata ✔');
      await reloadAfterUndo(r.lists || undo.listIds || []);
    } catch (e){ toast('Errore: ' + e.message, 5000); }
  }}});
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function tokenQs(){ const t = CFG && CFG.settings.token; return t ? `?token=${encodeURIComponent(t)}` : ''; }
function apiUrl(p){
  const a = localStorage.getItem('wisem3u_admin') || '';
  const parts = [];
  if (p.includes('?')) parts.push(p.split('?')[1]);
  if (a) parts.push(`token=${encodeURIComponent(a)}`);
  return parts.length ? `${p.split('?')[0]}?${parts.join('&')}` : p;
}
const sleep = (ms) => new Promise(r=>setTimeout(r, ms));

/* ---------------- rami: stato locale ---------------- */
/* L'ordine mostrato è quello del server (già ordinato secondo options.order).
   Le modifiche locali (attiva/disattiva, rinomina, sposta) aggiornano
   options.disabledPaths / options.renames / options.order; il salvataggio
   finale passa da PUT /api/config come tutto il resto. */

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

const EXPANDED = new Set();  // "listId|path" dei rami con la lista canali aperta
const CHANS = {};            // "listId|path" -> [{name, shown, enabled}]
const BRSQ = {};             // listId -> testo del filtro playlist (persiste ai re-render)
const BRONLY = new Set();    // listId con "Visualizza attive" attivo
const OPEN_LISTS = new Set();      // schede lista aperte (di default sono tutte chiuse)
const PLAYLISTS_OPEN = new Set();  // id delle liste con il blocco "Playlist della lista" aperto

/** Playlist (rami non personali) che rispettano il filtro corrente della scheda.
 *  E' lo scope su cui agiscono Tutto / Nulla / Cancella selezionate: durante
 *  una ricerca non si toccano le playlist nascoste. */
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
    if (st === 'fetching') return '<div class="hint" style="margin-top:10px">⏳ Scaricamento della lista in corso… la sezione delle playlist appare appena è pronto.</div>';
    if (st === 'error'){
      const fatal = !!(list.state && list.state.fatal);
      // errore "di natura" (URL che punta a un video, a una pagina HTML, playlist
      // enorme): ritentare produce lo stesso errore, meglio dirlo chiaramente
      return `<div class="err">Scaricamento fallito: ${esc((list.state&&list.state.error)||'')} — ${
        fatal
          ? 'questo errore <b>non si risolve con Aggiorna</b>: correggi l\'URL della lista e salva.'
          : 'riprova con <b>Aggiorna</b>.'
      }</div>`;
    }
    return '<div class="hint" style="margin-top:10px">Rami non caricati: premi <b>Aggiorna</b> per scaricare la lista.</div>';
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
      <span class="bhandle" title="Trascina per riordinare">☰</span>
      ${custom
        ? '<input type="checkbox" checked disabled title="Gruppo personale: per svuotarlo riporta altrove i canali">'
        : `<input type="checkbox" data-cb="${esc(b.path)}" ${on?'checked':''} title="Includi/escludi questo ramo">`}
      <input class="bname ${renamed?'renamed':''}" type="text" value="${esc(shown)}" placeholder="${esc(b.name)}" title="Nome del ramo (diventa il genere nel catalogo)">
      ${custom ? '<span class="badge">personale</span>' : ''}
      <span class="cnt bcount">${b.stations} canali${b.hidden?` <span style="color:var(--warn)">(${b.hidden} esclusi)</span>`:''}</span>
      <button class="expbtn" data-exp="${esc(b.path)}" title="Gestisci i singoli canali">${open?'▾ canali':'\u25b8 canali'}</button>
      <button class="ghost small" data-bdel="${esc(b.path)}" title="Elimina questa playlist (recuperabile nel cestino)">✕</button>
    </div>`;
    if (open) html += renderChannels(list, b);
    return html;
  }).join('');

  const active = bs.filter(b=>branchEnabled(list, b.path)).length;
  const purgedCh = new Set(list.options.purgedChannels || []);
  const purgedBr = new Set(list.options.purgedBranches || []);
  const nTrash = (list.options.deletedChannels || []).filter((k)=>!purgedCh.has(k)).length
    + (list.options.deletedBranches || []).filter((p)=>!purgedBr.has(p)).length;
  const plOpen = PLAYLISTS_OPEN.has(list.id);
  return `<div class="plwrap${plOpen ? '' : ' collapsed'}">
  <div class="plhead">
    <h2 data-ptgl="${esc(list.id)}" role="button" tabindex="0" aria-expanded="${plOpen}"
      title="${plOpen ? 'Comprimi le playlist' : 'Espandi le playlist'}"><span class="ttl">Playlist della lista</span> <span class="badge">${active}/${bs.length} attive</span>${
      visible.length !== bs.length ? ` <span class="badge" title="Playlist mostrate con i filtri attivi">${visible.length} in vista</span>` : ''
    }<span class="sectgl" aria-hidden="true">${plOpen ? '\u25be' : '\u25b8'}</span></h2>
    <div class="pltools">
      <button class="ghost small ${onlyActive?'on':''}" data-act="onlyactive"
        title="Mostra solo le playlist attive (e, se c'e' una ricerca, solo quelle che corrispondono)">👁 Visualizza attive</button>
      <input type="text" data-act="filter" value="${esc(BRSQ[list.id] || '')}" placeholder="🔎 Filtra playlist…">
      <button class="ghost small" data-act="all" title="Attiva tutte le playlist">✓ Tutto</button>
      <button class="ghost small" data-act="none" title="Disattiva tutte le playlist">✗ Nulla</button>
      <button class="ghost small" data-act="delsel" title="Sposta nel cestino tutte le playlist spuntate (recuperabili)">✕ Cancella selezionate</button>
      <button class="ghost small" data-act="trash" title="Canali e playlist eliminati: da qui li ripristini">🗑 Cestino${nTrash ? ` (${nTrash})` : ''}</button>
    </div>
  </div>
  ${bs.length ? '' : '<div class="hint" style="margin-top:10px">Nessuna playlist (ramo con canali) trovata nella lista.</div>'}
  <details class="help">
    <summary>ℹ️ Come si usa: rinomina, riordina, canali, spostamenti, cestino</summary>
    <div class="hint">Ogni riga è una playlist: spuntala per includerla, scrivi nel campo per <b>rinominarla</b>,
    trascinala dalla maniglia <b>☰</b> per <b>riordinare</b>. Con <b>▸ canali</b> apri la playlist e gestisci i
    <b>singoli canali</b>: escludi, rinomina, riordina e — col <b>campo gruppo</b> a destra —
    <b>spostali in un'altra playlist o in un gruppo personale</b>: la tendina suggerisce i gruppi
    esistenti, ma il campo è sempre libero. Poi premi <b>➜</b> per spostare il canale nel gruppo
    scritto o scelto (un gruppo inesistente viene creato al volo) oppure <b>↺</b> per riportarlo
    alla playlist originale (i canali spostati hanno il badge "da …"). Lo spostamento si
    <b>salva automaticamente</b>; per le altre modifiche ricorda <b>Salva configurazione</b>
    in fondo alla pagina. In alternativa <b>trascina un canale sopra un'altra playlist</b> per
    spostarvelo (funziona anche tra liste diverse) e <b>trascina una playlist al centro di
    un'altra riga</b> per spostarci dentro tutti i suoi canali (ai bordi invece la riordini).
    Il pulsante <b>✕</b> elimina il canale o l'intera playlist; se vuoi buttare <b>tante
    playlist in una volta</b>, spuntale e premi <b>✕ Cancella selezionate</b> in alto.
    Il tasto <b>👁 Visualizza attive</b> (a sinistra della ricerca) mostra solo le playlist
    attive; <b>✓ Tutto</b>, <b>✗ Nulla</b> e <b>✕ Cancella selezionate</b> agiscono
    <b>solo sulle playlist visibili</b>: con una ricerca attiva non toccano quelle nascoste.
    Nulla è perduto: trovi tutto nel <b>🗑 Cestino</b> da cui puoi ripristinare con un clic.</div>
  </details>
  <div class="branches">
    <div class="hint brsnone" style="margin-top:10px;${visible.length ? 'display:none' : ''}">Nessuna playlist corrisponde al filtro.
      <button class="ghost small" data-act="clearfilter">Mostra tutte</button></div>
    ${rows}
  </div>
  ${TRASHOPEN.has(list.id) ? renderTrash(list) : ''}
  <datalist id="dl-${list.id}">${bs.map((b) => `<option value="${esc(b.displayName)}">`).join('')}</datalist>
  </div>`;
}

/* ---------------- cestino: eliminati recuperabili ---------------- */
const TRASHOPEN = new Set(); // id delle liste col cestino aperto
const TRASH = {};            // id -> {branches:[], channels:[]}

function renderTrash(list){
  const t = TRASH[list.id];
  if (!t) return '<div class="trash" data-trash><div class="hint">Caricamento cestino…</div></div>';
  const br = (t.branches || []).map((b)=>`<div class="trashrow">
      <span>📁</span><b>${esc(b.name)}</b><span class="cnt">${b.stations} canali</span>
      <div class="spacer" style="flex:1"></div>
      <button class="ghost small" data-rbranch="${esc(b.path)}">↩ Ripristina</button>
    </div>`).join('');
  const ch = (t.channels || []).map((c)=>`<div class="trashrow">
      <span>📺</span><b>${esc(c.shown || c.name)}</b><span class="cnt">era in «${esc(c.branch)}»</span>
      <div class="spacer" style="flex:1"></div>
      <button class="ghost small" data-rchan="1" data-rpath="${esc(c.path)}" data-rname="${esc(c.name)}">↩ Ripristina</button>
    </div>`).join('');
  const empty = !br && !ch ? '<div class="hint">Il cestino è vuoto.</div>' : '';
  const tot = (t.branches || []).length + (t.channels || []).length;
  return `<div class="trash" data-trash>
    <div class="row" style="align-items:center;gap:8px"><b>🗑 Cestino</b><span class="cnt">elementi eliminati da questa lista</span>
      <div class="spacer" style="flex:1"></div>
      ${tot ? `<button class="danger small" data-etrash="1" title="Elimina definitivamente tutte le voci del cestino (non saranno piu' ripristinabili)">🗑 Svuota cestino</button>` : ''}
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
  if (!chans) return `<div class="chans" data-chans="${esc(b.path)}"><div class="hint">Caricamento canali…</div></div>`;
  const on = chans.filter(c=>c.enabled).length;
  const bs = branchesOf(list.id) || [];
  const rows = chans.map((c, i)=>{
    const renamed = c.shown !== c.name;
    const curB = bs.find((x) => x.path === c.cur);
    const homeB = bs.find((x) => x.path === c.home);
    const curName = curB ? curB.displayName : (String(c.cur).startsWith('@') ? String(c.cur).slice(1) : c.cur);
    return `<div class="crow ${c.enabled?'':'off'}" draggable="true" data-ci="${i}" data-cname="${esc(c.name)}" data-csearch="${esc((c.name+' '+c.shown).toLowerCase())}">
      <span class="bhandle" title="Trascina per riordinare">☰</span>
      <input type="checkbox" data-cch="${i}" ${c.enabled?'checked':''} title="Includi/escludi questo canale">
      <input class="cname ${renamed?'renamed':''}" type="text" value="${esc(c.shown)}" placeholder="${esc(c.name)}" title="Nome del canale (come lo vedi in playlist e catalogo)">
      ${c.from ? `<span class="cnt" style="color:var(--warn)" title="Canale spostato: proviene da &quot;${esc(c.from)}&quot;">da ${esc(c.from)}</span>` : ''}
      <input class="cmove ${curName !== (homeB ? homeB.displayName : '') ? 'renamed' : ''}" data-cmove="${i}" list="dl-${list.id}" value="${esc(curName)}" placeholder="${esc(homeB ? homeB.displayName : '')}" title="Gruppo del canale: scegli dalla tendina oppure scrivi un nome nuovo">
      <button class="ghost small" data-capply="${i}" title="Sposta il canale nel gruppo scritto o scelto">➜</button>
      <button class="ghost small" data-creset="${i}" title="Riporta il canale nella sua playlist originale">↺</button>
      <button class="ghost small" data-cdel="${i}" title="Elimina il canale (recuperabile nel cestino)">✕</button>
    </div>`;
  }).join('');
  return `<div class="chans" data-chans="${esc(b.path)}">
    <div class="chead">
      <input type="text" class="cfilter" placeholder="🔎 Filtra canali…" data-cfilter>
      <span class="cnt ccount">${on}/${chans.length} attivi</span>
    </div>
    <div class="chead">
      <input type="text" data-cadd list="dladd-${list.id}" placeholder="Aggiungi un canale da un'altra playlist o da un'altra lista…">
      <button class="ghost small" data-caddbtn="${esc(b.path)}" title="Se il canale e' di un'altra playlist di questa lista viene spostato qui; se e' di un'altra lista viene importato qui e tolto dalla sorgente">➕ Aggiungi</button>
    </div>
    <datalist id="dladd-${list.id}" data-dladd></datalist>
    ${rows}
  </div>`;
}

let SKIP_TREE_RELOAD = false; // il drag ha gia' l'ordine in memoria: non rileggerlo dal server

function renderLists(){
  // rendere ricostruibili anche i container CON scroll proprio (.branches):
  // la loro scrollTop va preservata esplicitamente, altrimenti la rebuild interna
  // riporta la vista in cima alla "Playlist della lista" di quella scheda
  const sy = window.scrollY;
  const bTops = {};
  document.querySelectorAll('#lists .listcard').forEach(c=>{
    const b = c.querySelector('.branches');
    if (b) bTops[c.dataset.id] = b.scrollTop;
  });
  const root = $('#lists');
  if (!CFG.lists.length){
    root.innerHTML = `<section class="card">
      <div class="hint">Nessuna lista. Aggiungi un URL qui sopra (una lista WisePlay o un link <code>.m3u</code>),
      oppure premi <b>⭐ Crea lista personalizzata</b> per comporre una lista scegliendo canali e playlist dalle tue liste.</div></section>`;
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

/* -------- scadenza account Xtream (player_api.php) -------- */

function fmtItDate(iso){
  try { return new Date(iso).toLocaleDateString('it-IT', { day:'numeric', month:'short', year:'numeric' }); }
  catch(_) { return iso; }
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
      ? '⛔ account SCADUTO'
      : days == null
        ? '⏳ senza scadenza'
        : `⏳ scade il ${fmtItDate(u.expiryIso)} (${days} gg)`;
    const conn = u.maxConnections ? ` · max ${u.maxConnections} conn` : '';
    const color = u.expired ? 'background:#3b1519;color:#ffb4ab'
      : days == null ? 'background:#173823;color:#9be7b4'
      : days <= 7 ? 'background:#3b1519;color:#ffb4ab'
      : days <= 30 ? 'background:#3a2c0d;color:#ffd479'
      : 'background:#173823;color:#9be7b4';
    el.innerHTML = `<span class="badge" data-xtream="${esc(l.id)}" style="${color};cursor:pointer" title="Account Xtream: ${esc(u.status)} · aggiornato ${fmtItDate(r.fetchedAt)} — click per rileggere">${expTxt}${conn}</span>`;
  } catch (_) { /* nessun dato: badge vuoto */ }
}
async function refreshXtreamBadge(id){
  const l = (CFG.lists || []).find(x => x.id === id);
  if (l) fillXtreamBadge(l, true);
}

/* --------- menu laterale: riordino liste + accesso rapido --------- */

function renderSideMenu(){
  const el = $('#sidemenu');
  if (!el) return;
  const items = CFG.lists.map((l, i) => `<div class="sditem">
    <button class="updn" data-sdup="${i}" title="Sposta su">▲</button>
    <button class="updn" data-sddn="${i}" title="Sposta giu">▼</button>
    <button class="sdname" data-sdgo="${esc(l.id)}" title="Vai alla lista">${l.kind === 'personal' ? '⭐ ' : ''}${esc(l.name || l.url)}</button>
  </div>`).join('');
  el.innerHTML = '<div class="sdtitle">Ordine delle liste</div>' + (items || '<div class="hint">Nessuna lista</div>');
}


/* -------- liste personali: tendine a cascata del picker "aggiungi contenuto" -------- */

async function plPopulateBranches(card){
  const lid = card.querySelector('[data-plsel="list"]').value;
  if (lid && !SKIP_TREE_RELOAD) await loadBranches(lid); // fresco: rinomine e gruppi nuovi
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
    dl.innerHTML = `<option value="— tutta la playlist —">`
      + r.channels.filter((c) => c.enabled).map((c) => `<option value="${esc(c.shown)}">`).join('');
  } catch (e){ dl.innerHTML = ''; }
}

/** Risolve il campo canale: '*' = playlist intera, altrimenti il canale (nome scritto o suggerito). */
async function plResolveChan(lid, bp, value){
  const v = String(value || '').trim();
  if (!v || v === '*' || v === '— tutta la playlist —') return { wild: true };
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
    name: `La mia lista ${n + 1}`,
    kind: 'personal',
    url: '',
    state: { status: 'ready', stats: { nodes: 0, stations: 0, external: 0, m3u: 0, failed: 0 } },
    options: { enabled: true, inCatalog: false, personalEntries: [] },
  });
  await saveConfig();
  renderLists();
  toast('Lista personale creata: aggiungi canali o playlist intere dal riquadro "Aggiungi contenuto"');
}

function renderListCard(l){
  const o = l.options, s = l.state || {};
  const st = s.status || 'idle';
  const stats = s.stats || null;
  const personal = l.kind === 'personal';
  const purl = personal
    ? (CFG.settings.publicBaseUrl || location.origin).replace(/\/+$/, '') + '/personal/' + l.id + '.m3u' + tokenQs()
    : '';
  const collapsed = !OPEN_LISTS.has(l.id);
  return `<section class="card listcard${collapsed ? ' collapsed' : ''}" data-id="${esc(l.id)}" ${personal ? 'data-kind="personal"' : ''}>
    <div class="listhead">
      <div class="listtitle">
        <span class="name" data-ltgl="${esc(l.id)}" role="button" tabindex="0"
              aria-expanded="${collapsed ? 'false' : 'true'}"
              title="${collapsed ? 'Espandi' : 'Comprimi'} la lista">${personal ? '⭐ ' : ''}${esc(l.name || l.url)}</span>
        <div class="linfo"></div>
      </div>
      ${personal ? '<span class="badge ready" title="Lista personale: composta da canali e playlist delle tue liste">personale</span>' : ''}
      ${s.kind === 'm3u' ? '<span class="badge ready" title="Sorgente playlist M3U">m3u</span>' : ''}
      <span class="badge ${st}">${st}</span>
      <span class="xtbadge" id="xt_${esc(l.id)}"></span>
      <div class="spacer" style="flex:1"></div>
      <div class="acts">
        <button class="ghost small" data-act="toggle" style="${o.enabled ? '' : 'opacity:.55;color:var(--warn)'}" title="Attiva/disattiva completamente la lista">${o.enabled ? '⏻ attiva' : '⏻ spenta'}</button>
        <button class="ghost small" data-act="refresh">Aggiorna</button>
        <button class="ghost small" data-act="origin" title="Annulla unioni e spostamenti: i canali tornano nelle playlist di origine">↩ Ripristina</button>
        <button class="danger small" data-act="del">Elimina</button>
      </div>
    </div>
    ${personal
      ? `<div class="url">Lista personale (senza URL remoto): il contenuto lo scegli tu qui sotto.
         Link M3U: <code>${esc(purl)}</code> <button class="ghost small" data-act="copypl" style="margin-left:6px">⧉ copia</button></div>`
      : `<div class="url">${esc(l.url)}</div>`}
    <div class="kv" style="margin-top:6px">
      ${s.fetchedAt ? `Ultimo aggiornamento: <b>${esc(new Date(s.fetchedAt).toLocaleString('it-IT'))}</b>` : 'Mai aggiornata'}
      ${stats ? ` · nodi <b>${stats.nodes}</b> · rami esterni <b>${stats.external}</b> · m3u importate <b>${stats.m3u}</b> · stream <b>${stats.stations}</b>${stats.failed?` · errori <b>${stats.failed}</b>`:''}` : ''}
    </div>
    ${stats && stats.truncated ? `<div class="hint" style="margin-top:6px;color:#f5c451">⚠︎ Lista molto grande: importati i primi <b>${stats.stations}</b> canali (limite di sicurezza). Il resto viene saltato per non esaurire la memoria del container.</div>` : ''}
    ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}

    <details class="fold">
      <summary>⚙️ Impostazioni della lista</summary>
      <div class="foldbody">
        <div class="grid2">
          <div>
            <label>Nome visualizzato</label>
            <input type="text" data-f="name" value="${esc(l.name)}">
          </div>
          <div>
            <label>Prefisso group-title</label>
            <select data-f="options.groupPrefix">
              <option value="list" ${o.groupPrefix==='list'?'selected':''}>Nome della lista</option>
              <option value="none" ${o.groupPrefix==='none'?'selected':''}>Nessuno</option>
              <option value="custom" ${o.groupPrefix==='custom'?'selected':''}>Personalizzato</option>
            </select>
          </div>
          <div>
            <label>Prefisso personalizzato</label>
            <input type="text" data-f="options.customPrefix" value="${esc(o.customPrefix||'')}">
          </div>
          <div>
            <label>Livelli nel group-title</label>
            <input type="number" min="1" max="6" data-f="options.groupDepth" value="${o.groupDepth}">
          </div>
          <div>
            <label>Aggiornamento lista (minuti)</label>
            <input type="number" min="5" data-f="options.refreshMinutes" value="${o.refreshMinutes}">
            <div class="hint" data-info>1440 = giornaliero</div>
          </div>
          <div>
            <label>Nome catalogo</label>
            <input type="text" data-f="options.catalogName" value="${esc(o.catalogName||'')}">
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <label class="chk ${o.enabled?'on':''}"><input type="checkbox" data-f="options.enabled" ${o.enabled?'checked':''}> Lista attiva</label>
          <label class="chk ${o.inCatalog?'on':''}"><input type="checkbox" data-f="options.inCatalog" ${o.inCatalog?'checked':''}> Mostra come catalogo in Stremio/Nuvio</label>
          <label class="chk ${o.dedupe?'on':''}"><input type="checkbox" data-f="options.dedupe" ${o.dedupe?'checked':''}> Rimuovi duplicati</label>
          <label class="chk ${o.emitLogo?'on':''}"><input type="checkbox" data-f="options.emitLogo" ${o.emitLogo?'checked':''}> Usa l'icona del gruppo come logo (appesantisce la playlist)</label>
        </div>
      </div>
    </details>

    <details class="fold">
      <summary>🧪 Protocolli, AceStream ed esclusioni</summary>
      <div class="foldbody">
        <div class="row">
          ${['http','ace','rtmp','rtsp','other'].map(k=>`
            <label class="chk ${o.protocols[k]?'on':''}"><input type="checkbox" data-f="options.protocols.${k}" ${o.protocols[k]?'checked':''}> ${PROTO_LABEL[k]}</label>`).join('')}
        </div>
        <div class="row" style="margin-top:12px">
          <div style="flex:1 1 220px">
            <label>AceStream</label>
            <select data-f="options.aceMode">
              <option value="keep" ${o.aceMode==='keep'?'selected':''}>acestream:// (serve Ace Player/Engine)</option>
              <option value="engine" ${o.aceMode==='engine'?'selected':''}>Riscrivi in HTTP via Engine</option>
              <option value="off" ${o.aceMode==='off'?'selected':''}>Escludi AceStream</option>
            </select>
          </div>
          <div style="flex:1 1 260px">
            <label>Host AceStream Engine (se "Riscrivi in HTTP")</label>
            <input type="text" data-f="options.aceEngineHost" value="${esc(o.aceEngineHost||'')}" placeholder="http://IP:6878">
          </div>
        </div>
        <div style="margin-top:12px">
          <label>Escludi canali contenenti queste parole (una per riga)</label>
          <textarea data-f="options.excludeKeywords" rows="2">${esc((o.excludeKeywords||[]).join('\n'))}</textarea>
        </div>
      </div>
    </details>

    <details class="fold">
      <summary>🌐 EasyProxy (opzionale)</summary>
      <div class="foldbody">
        <div class="hint" data-info style="margin-top:2px">Le liste <b>"(dns)"</b> spesso non funzionano perche' il <b>client</b>
          (TV/telefono) non risolve quei domini, indipendentemente dal DNS del server. Con
          <a class="lnk" href="https://github.com/realbestia1/EasyProxy" target="_blank">EasyProxy</a> i flussi
          passano dal server (con il suo DNS/WARP/estrattori): compila l'URL della tua istanza
          (es. <code>http://192.168.1.10:7860</code>) e gli stream di questa lista verranno riscritti.
          Attenzione: tutto il traffico video passa dal server.</div>
        <div class="row" style="margin-top:10px">
          <div style="flex:2 1 260px">
            <label>URL di EasyProxy (vuoto = disattivato)</label>
            <input type="text" data-f="options.easyProxy" value="${esc(o.easyProxy||'')}" placeholder="http://192.168.10.10:7860 oppure https://proxy.tuodominio.it">
          </div>
          <div style="flex:1 1 160px">
            <label>API_PASSWORD (se impostata)</label>
            <input type="text" data-f="options.easyProxyPassword" value="${esc(o.easyProxyPassword||'')}">
          </div>
          <div style="flex:1 1 160px">
            <label>Parametri extra (es. warp=off)</label>
            <input type="text" data-f="options.easyProxyParams" value="${esc(o.easyProxyParams||'')}">
          </div>
        </div>
        <div class="row" style="margin-top:10px">
          <div style="flex:0 0 auto;display:flex;align-items:flex-end">
            <button class="ghost small" data-act="eptest">Test</button>
          </div>
        </div>
        <details class="help">
          <summary>ℹ️ Come interpretare il test (avvisi non bloccanti)</summary>
          <div class="hint">Scrivi <b>IP oppure dominio</b>: funziona cosi' com'e', senza configurazioni speciali.
            L'addon si limita a <b>riscrivere gli stream</b> verso EasyProxy: sara' il <b>client</b> (TV/telefono) a
            connettersi. Il <b>Test</b> qui sotto e' solo indicativo: su molte reti di
            casa il container Docker non riesce a raggiungere il proprio dominio pubblico (manca il NAT hairpin) o non
            si fida del certificato; in quei casi mostra un <b>avviso non bloccante</b> e la riproduzione funziona
            comunque sul client.</div>
        </details>
        <div class="epbox" data-epbox></div>
      </div>
    </details>

    <details class="fold">
      <summary>➕ Aggiungi contenuto dalle tue liste</summary>
      <div class="foldbody">
        <div class="row" style="margin-top:2px">
          <div style="flex:1 1 140px"><label>Lista</label><select data-plsel="list">${CFG.lists.filter((x) => x.id !== l.id).map((x) => `<option value="${esc(x.id)}">${x.kind === 'personal' ? '⭐ ' : ''}${esc(x.name || x.url)}</option>`).join('')}</select></div>
          <div style="flex:1 1 150px"><label>Playlist/ramo</label><select data-plsel="branch"></select></div>
          <div style="flex:1 1 190px"><label>Canale (scrivi o scegli)</label><input type="text" data-plchan list="pldl-${l.id}" placeholder="nome canale o — tutta la playlist —"></div>
          <div style="flex:0 0 auto;display:flex;gap:6px;align-items:flex-end">
            <button data-act="pladd">+ Aggiungi</button>
            <button class="ghost" data-act="plnew" title="Crea una playlist personalizzata vuota in questa lista">+ Nuova playlist</button>
          </div>
        </div>
        <div class="row" data-plnewrow style="display:none">
          <div style="flex:1 1 220px"><label>Nome della nuova playlist</label><input type="text" data-plnewname placeholder="es. Preferiti"></div>
          <div style="flex:0 0 auto;display:flex;gap:6px;align-items:flex-end">
            <button data-act="plnewok">Crea</button>
            <button class="ghost" data-act="plnewno">Annulla</button>
          </div>
        </div>
        <datalist id="pldl-${l.id}" data-pldl></datalist>
        <details class="help">
          <summary>ℹ️ Come funziona l'importazione</summary>
          <div class="hint">Da un'<b>altra</b> lista importi canali o <b>— tutta la playlist —</b> come playlist aggiuntive
            di questa lista. Dalla <b>stessa</b> lista sposti i canali in un'altra playlist o in una
            <b>playlist personalizzata</b> (creala con <b>+ Nuova playlist</b>: compare tra le playlist e ci porti i
            canali anche col campo gruppo e ➜). Il campo canale e' <b>scrivibile</b>: i suggerimenti arrivano dalla
            playlist scelta (vedi anche i nomi personalizzati).</div>
        </details>
      </div>
    </details>

    ${renderBranches(l)}
  </section>`;
}

/* ---------------- canali: stato e modifiche ---------------- */
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

/** Risolve il valore del campo gruppo: il nome di un ramo/gruppo esistente,
 *  oppure testo libero = nuovo gruppo personale. Vuoto = ramo originale. */
function resolveGroupTarget(list, value){
  const v = String(value || '').trim();
  if (!v) return null;
  const hit = (branchesOf(list.id) || []).find((b) => b.displayName === v);
  return hit ? hit.path : '@' + v;
}

/** Sposta un canale in un altro ramo o in un gruppo personale ("@Nome").
 *  La chiave resta quella originale (home::nome): rename/esclusioni/ordini
 *  continuano a funzionare anche dopo lo spostamento. */
async function applyChannelMove(list, c, target, curPath){
  list.options.channelMoves = list.options.channelMoves || {};
  const key = chanKey(c.home, c.name);
  if (!target || target === c.home) delete list.options.channelMoves[key];
  else list.options.channelMoves[key] = target;
  // salva subito sul server: albero e canali vengono riletti da li', quindi
  // lo spostamento deve gia' essere registrato perche' la UI lo mostri
  try {
    const saved = await api('/api/config', {
      method:'PUT',
      body: JSON.stringify({ settings: CFG.settings, lists: CFG.lists, reason: 'spostamento canale', baseRev: CFG.rev }),
    });
    CFG.rev = saved.rev;
  } catch(e){
    if (e.status === 409){
      toast('Configurazione cambiata altrove: ricarico lo stato del server', 6000);
      await loadConfig();
    } else toast('Errore: '+e.message, 4000);
    return;
  }
  await loadBranches(list.id); // aggiorna conteggi e gruppi personali
  for (const p of new Set([curPath, target])) {
    const k = `${list.id}|${p}`;
    if (EXPANDED.has(k)) {
      try {
        const r = await api(`/api/lists/${list.id}/channels?path=${encodeURIComponent(p)}`);
        CHANS[k] = r.channels;
      } catch(_){ /* si aggiornera' alla prossima apertura */ }
    }
  }
  renderLists();
}

/* ricarica i canali dei rami aperti (dopo spostamenti/eliminazioni tra liste) */
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
    if (cc) cc.textContent = `${chans.length - hidden}/${chans.length} attivi`;
    const brow = chDiv.previousElementSibling;
    if (brow && brow.classList.contains('brow')){
      const b = (branchesOf(list.id) || []).find(x=>x.path===path);
      const bc = brow.querySelector('.bcount');
      if (b && bc) bc.innerHTML = `${b.stations} canali${hidden?` <span style="color:var(--warn)">(${hidden} esclusi)</span>`:''}`;
    }
  }
}

async function toggleExpand(card, list, path){
  const key = `${list.id}|${path}`;
  const q = `.brow[data-path="${CSS.escape(path)}"]`;
  const row = card.querySelector(q);
  const btn = card.querySelector(`button[data-exp="${CSS.escape(path)}"]`);
  const existing = card.querySelector(`.chans[data-chans="${CSS.escape(path)}"]`);
  // scroll del container playlist della scheda (agiato da .branches): non deve muoversi
  const brBox = card.querySelector('.branches');
  const bTop = brBox ? brBox.scrollTop : 0;

  if (EXPANDED.has(key)){
    EXPANDED.delete(key);
    if (existing) existing.remove();
    if (btn) btn.textContent = '\u25b8 canali';
    if (brBox) requestAnimationFrame(()=>{ brBox.scrollTop = bTop; });
    return; // niente renderLists(): ricostruire tutto faceva saltare lo scroll
  }
  EXPANDED.add(key);
  if (btn) btn.textContent = '▾ canali';
  if (row) row.insertAdjacentHTML('afterend',
    `<div class="chans" data-chans="${esc(path)}"><div class="hint">Caricamento canali…</div></div>`);
  if (brBox) brBox.scrollTop = bTop;

  try {
    const r = await api(`/api/lists/${list.id}/channels?path=${encodeURIComponent(path)}`);
    CHANS[key] = r.channels;
  } catch(e){
    EXPANDED.delete(key);
    toast('Errore: ' + e.message, 4000);
    const el = card.querySelector(`.chans[data-chans="${CSS.escape(path)}"]`);
    if (el) el.remove();
    if (btn) btn.textContent = '\u25b8 canali';
    return;
  }
  const b = (branchesOf(list.id) || []).find(x=>x.path===path);
  const el = card.querySelector(`.chans[data-chans="${CSS.escape(path)}"]`);
  if (b && el) {
    el.outerHTML = renderChannels(list, b);
    // dopo la sostituzione del contenuto ripristina esplicitamente la scrollTop
    if (brBox) requestAnimationFrame(()=>{ brBox.scrollTop = bTop; });
  }
}

/* ---------------- drag & drop (rami e canali) ---------------- */
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
    // rilascio "dentro" una playlist: il canale (o tutti i canali del ramo
    // trascinato) si sposta nella playlist di destinazione
    const tPath = DRAG.target.classList.contains('brow')
      ? DRAG.target.dataset.path
      : ((DRAG.target.closest('.chans') || {}).dataset || {}).chans;
    const srcId = DRAG.listId;
    const type = DRAG.type;
    const c = DRAG.chan;
    const fromPath = type === 'branch' ? DRAG.el.dataset.path : '';
    // i nomi servono per la conferma: vanno letti prima di azzerare DRAG
    const srcName = type === 'branch' ? (DRAG.el.dataset.name || fromPath || 'playlist').trim() : '';
    const dstName = type === 'branch' ? (DRAG.target.dataset.name || tPath || 'playlist').trim() : '';
    dragCleanup(card);
    if (!tPath) return;
    if (type === 'branch' && !confirm(`Unire la playlist «${srcName}» dentro «${dstName}»?\nTutti i suoi canali verranno spostati nella playlist di destinazione. Potrai annullare con «↩ Ripristina».`)) return;
    (async ()=>{
      try {
        if (type === 'chan'){
          if (!c) return;
          if (srcId === id){
            if (tPath === (c.cur || '')){ toast('Il canale e\' gia\' in questa playlist'); return; }
            const srcList = CFG.lists.find((l)=>l.id===srcId);
            await applyChannelMove(srcList, c, tPath, c.cur || '');
            toast('Canale spostato');
          } else {
            const r = await api(`/api/lists/${id}/addchannel`, { method:'POST', body: JSON.stringify({ path: tPath, name: c.name, home: c.home, fromList: srcId }) });
            showUndo(r.revived ? 'Canale ripristinato e spostato qui' : `Canale spostato qui (era in: ${r.from})`, r.undo);
            await loadConfig();
            await reloadOpenChans([id, srcId]);
            renderLists();
          }
        } else {
          if (srcId === id && fromPath === tPath){ toast('Stessa playlist'); return; }
          const r = await api(`/api/lists/${id}/mergebranch`, { method:'POST', body: JSON.stringify({ fromList: srcId, from: fromPath, to: tPath }) });
          showUndo(r.moved ? `${r.moved} canali spostati dentro la playlist` : 'Nessun canale da spostare', r.undo);
          await loadConfig();
          if (srcId !== id) { await loadBranches(id); await loadBranches(srcId); }
          await reloadOpenChans([id, srcId]);
          renderLists();
        }
      } catch (e){ toast(e.message, 4000); }
    })();
    return;
  }
  if (DRAG.listId !== id){ dragCleanup(card); return; } // riordino solo dentro la stessa lista
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
  // il riordino vive in list.options.order: ricaricare l'albero dal server qui
  // riporterebbe i rami all'ordine salvato, cancellando il trascinamento appena fatto
  SKIP_TREE_RELOAD = true;
  renderLists();
  SKIP_TREE_RELOAD = false;
}

function bindListEvents(){
  $$('#lists .listcard').forEach(card=>{
    const id = card.dataset.id;
    const list = CFG.lists.find(l=>l.id===id);

    card.addEventListener('change', async ev=>{
      const el = ev.target;
      if (el.dataset && el.dataset.plsel === 'list'){ await plPopulateBranches(card); return; }
      if (el.dataset && el.dataset.plsel === 'branch'){ await plPopulateChans(card); return; }
      if (el.dataset && el.dataset.cch !== undefined){
        // spunta di un singolo canale
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
        // rinomina di un singolo canale
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
        setPath(list, el.dataset.f, el.type==='checkbox' ? el.checked : el.value);
        if (el.dataset.f.startsWith('options.protocols') || ['options.enabled','options.inCatalog','options.dedupe','options.emitLogo'].includes(el.dataset.f)){
          el.closest('.chk').classList.toggle('on', el.checked);
        }
      }
    });

    card.addEventListener('keydown', ev=>{
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
      if (el.dataset && el.dataset.cfilter !== undefined){
        const q = el.value.trim().toLowerCase();
        $$('.crow', el.closest('.chans')).forEach(r=>{
          r.style.display = !q || r.dataset.csearch.includes(q) ? '' : 'none';
        });
        return;
      }
      if (el.dataset && el.dataset.f && el.type !== 'checkbox') setPath(list, el.dataset.f, el.value);
    });

    card.addEventListener('click', async ev=>{
      const ltl = ev.target.closest('[data-ltgl]');
      if (ltl){
        const lid = ltl.dataset.ltgl;
        if (OPEN_LISTS.has(lid)) OPEN_LISTS.delete(lid); else OPEN_LISTS.add(lid);
        const open = !card.classList.toggle('collapsed');
        ltl.setAttribute('aria-expanded', String(open));
        ltl.title = `${open ? 'Comprimi' : 'Espandi'} la lista`;
        return;
      }
      const ptgl = ev.target.closest('[data-ptgl]');
      if (ptgl){
        // le note info stanno dentro il titolo ma non devono comprimere la sezione
        if (ev.target.closest('details.info, a, button, input, select, label, summary')) return;
        const lid = ptgl.dataset.ptgl;
        if (PLAYLISTS_OPEN.has(lid)) PLAYLISTS_OPEN.delete(lid); else PLAYLISTS_OPEN.add(lid);
        const wrap = card.querySelector('.plwrap');
        if (wrap){
          const open = !wrap.classList.toggle('collapsed');
          const arrow = ptgl.querySelector('.sectgl');
          if (arrow) arrow.textContent = open ? '\u25be' : '\u25b8';
          ptgl.setAttribute('aria-expanded', String(open));
          ptgl.title = open ? 'Comprimi le playlist' : 'Espandi le playlist';
        }
        return;
      }
      const cab = ev.target.closest('button[data-caddbtn]');
      if (cab){
        const inp = cab.parentElement.querySelector('[data-cadd]');
        const v = (inp ? inp.value : '').trim();
        if (!v){ toast('Scrivi il nome del canale da aggiungere'); return; }
        try {
          const r = await api(`/api/lists/${id}/addchannel`, {
            method: 'POST',
            body: JSON.stringify({ path: cab.dataset.caddbtn, name: v }),
          });
          showUndo(`Canale aggiunto qui (presi da: ${r.from})`, r.undo);
          if (inp) inp.value = '';
          await loadConfig();          // risincronizza la config (mosse/voci lato server)
          await reloadOpenChans([id]);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      const et = ev.target.closest('button[data-etrash]');
      if (et){
        const t = TRASH[id] || { branches: [], channels: [] };
        const n = (t.branches || []).length + (t.channels || []).length;
        if (!n){ toast('Il cestino e\' gia\' vuoto'); return; }
        if (!confirm(`Eliminare definitivamente ${n} voci dal cestino?\nNon saranno piu' ripristinabili: resteranno fuori dalla lista per sempre.`)) return;
        try {
          const r = await api(`/api/lists/${id}/emptytrash`, { method:'POST', body:'{}' });
          showUndo(`Cestino svuotato: ${r.removed} voci eliminate definitivamente`, r.undo);
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
          toast('Playlist ripristinata');
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
          toast('Canale ripristinato');
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
        if (!confirm(`Eliminare "${c.shown || c.name}" da questa lista? Potrai ripristinarlo dal 🗑 Cestino.`)) return;
        try {
          const r = await api(`/api/lists/${id}/delete`, { method:'POST', body: JSON.stringify({ path: c.home || path, name: c.name }) });
          showUndo('Canale eliminato — recuperabile nel 🗑 Cestino', r.undo);
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
        if (!confirm(`Eliminare la playlist "${nm}" e tutti i suoi canali? Potrai ripristinarla dal 🗑 Cestino.`)) return;
        try {
          const r = await api(`/api/lists/${id}/delete`, { method:'POST', body: JSON.stringify({ path }) });
          EXPANDED.delete(`${id}|${path}`);
          delete CHANS[`${id}|${path}`];
          showUndo('Playlist eliminata — recuperabile nel 🗑 Cestino', r.undo);
          await loadConfig();
          if (TRASHOPEN.has(id)) await refreshTrash(id);
          renderLists();
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      const ap = ev.target.closest('button[data-capply]');
      if (ap){
        // sposta il canale nel gruppo scelto/scritto nel campo accanto
        const row = ap.closest('.crow');
        const path = row.closest('.chans').dataset.chans;
        const c = CHANS[`${id}|${path}`][Number(ap.dataset.capply)];
        const val = row.querySelector('.cmove') ? row.querySelector('.cmove').value : '';
        if (c) await applyChannelMove(list, c, resolveGroupTarget(list, val), path);
        return;
      }
      const rs = ev.target.closest('button[data-creset]');
      if (rs){
        // riporta il canale nella playlist originale
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
      if (act === 'trash'){
        if (TRASHOPEN.has(id)){ TRASHOPEN.delete(id); renderLists(); return; }
        TRASHOPEN.add(id);
        renderLists();
        await refreshTrash(id);
        renderLists();
        return;
      }
      if (act === 'delsel'){
        // cancellazione in blocco delle playlist spuntate (le custom non sono
        // spuntabili): stesso esito del ✕ singolo ma in una sola chiamata
        const sel = visibleBranches(list).filter((b) => !b.custom && branchEnabled(list, b.path));
        if (!sel.length){ toast('Nessuna playlist spuntata da eliminare'); return; }
        const few = sel.slice(0, 3).map((b) => b.displayName || b.name).join(', ');
        if (!confirm(`Eliminare ${sel.length} playlist spuntate (${few}${sel.length > 3 ? ', …' : ''}) e tutti i loro canali? Potrai ripristinarle dal 🗑 Cestino.`)) return;
        try {
          const r = await api(`/api/lists/${id}/delete`, { method:'POST', body: JSON.stringify({ paths: sel.map((b) => b.path) }) });
          for (const b of sel){ EXPANDED.delete(`${id}|${b.path}`); delete CHANS[`${id}|${b.path}`]; }
          showUndo(`${sel.length} playlist eliminate — recuperabili nel 🗑 Cestino`, r.undo);
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
        toast(list.options.enabled ? 'Lista attivata' : 'Lista disattivata');
      }
      if (act === 'refresh') await refreshList(id, btn);
      if (act === 'del'){ if (confirm(`Eliminare definitivamente la lista «${list.name || list.url}» e la sua configurazione?`)) await delList(id); }
      if (act === 'origin'){
        if (!confirm(`Riportare «${list.name || list.url}» allo stato di quando e' stata aggiunta?\nVerranno azzerate tutte le personalizzazioni (rinomine, esclusioni, ordine, unioni, spostamenti, cestino) e la lista verra' riscaricata.`)) return;
        try {
          const r = await api(`/api/lists/${id}/restoreorigin`, { method:'POST', body:'{}' });
          await loadConfig();
          for (const lid of r.lists || []) await loadBranches(lid);
          renderLists();
          showUndo('Lista ripristinata: riscaricamento in corso…', r.undo);
          await pollUntilReady(id);
        } catch (e){ toast(e.message, 4000); }
        return;
      }
      if (act === 'eptest') await testEasyProxy(card, list, btn);
      if (act === 'copypl'){
        const base = (CFG.settings.publicBaseUrl || location.origin).replace(/\/+$/, '');
        copyText(base + '/personal/' + id + '.m3u' + tokenQs()).then(
          () => toast('Link M3U della lista personale copiato ✔'),
          (e) => toast('Copia non riuscita: ' + e.message, 4000)
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
        if (!nm){ toast('Scrivi un nome per la playlist'); return; }
        list.options.customGroups = list.options.customGroups || [];
        if (list.options.customGroups.includes(nm)){ toast('Esiste gia\' una playlist con questo nome'); return; }
        list.options.customGroups.push(nm);
        await saveConfig();
        await loadBranches(id);
        renderLists();
        toast(`Playlist "${nm}" creata: sceglila nella tendina o spostaci i canali`);
        return;
      }
      if (act === 'pladd'){
        const lid = card.querySelector('[data-plsel="list"]').value;
        const bp = card.querySelector('[data-plsel="branch"]').value;
        const cv = card.querySelector('[data-plchan]').value;
        if (!lid || bp == null || bp === ''){ toast('Scegli lista e playlist/ramo'); return; }
        if (lid === id){
          // stessa lista: sposta il canale nella playlist/gruppo scelto
          const res = await plResolveChan(lid, bp, cv).catch(() => null);
          if (!res || res.wild){ toast('Per spostare, scrivi o scegli un singolo canale'); return; }
          const c = res.chan;
          list.options.channelMoves = list.options.channelMoves || {};
          const key = `${c.home}::${c.name}`;
          if (!bp.startsWith('@') && bp === c.home){
            delete list.options.channelMoves[key];
            toast('Il canale resta nella sua playlist');
          } else {
            list.options.channelMoves[key] = bp;
            toast(bp.startsWith('@') ? `Canale spostato nel gruppo personale` : 'Canale spostato nella playlist scelta');
          }
          await saveConfig();
          await loadBranches(id);
          renderLists();
        } else {
          // altra lista: importa il canale o l'intera playlist come ramo nuovo
          const res = await plResolveChan(lid, bp, cv).catch(() => null);
          if (!res){ toast('Canale non trovato nella playlist scelta'); return; }
          const src = `${lid}::${bp}::${res.wild ? '*' : res.chan.name}`;
          list.options.personalEntries = list.options.personalEntries || [];
          if (list.options.personalEntries.some((e) => e.src === src)){ toast('Voce gia\' presente'); return; }
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
        // durante una ricerca (o con "solo attive") si agisce SOLO sulle
        // playlist visibili: cambiare di nascosto quelle filtrate era una trappola
        const scoped = visibleBranches(list).filter((b) => !b.custom);
        if (!scoped.length){ toast('Nessuna playlist nei risultati del filtro'); return; }
        for (const b of scoped) setBranchEnabled(list, b.path, act === 'all');
        const filtered = !!String(BRSQ[id] || '').trim() || BRONLY.has(id);
        renderLists();
        toast(`${act === 'all' ? 'Attivate' : 'Disattivate'} ${scoped.length} playlist` +
          (filtered ? ' (solo i risultati del filtro)' : ''));
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
        if (brow){ target = brow; DRAG.into = true; }            // canale sopra una playlist
        else if (crow && crow !== DRAG.el){
          target = crow;
          DRAG.into = crow.closest('.chans') !== DRAG.chans;     // altro ramo aperto: sposta li'
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
      // ramo: bordi = riordina, centro = sposta tutti i canali dentro
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

    // al primo focus sul campo "aggiungi canale" carica i suggerimenti
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
          } catch (_) { /* suggerimenti non disponibili */ }
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
  const badge = card.querySelector('h2 .badge');
  if (badge) badge.textContent = `${active}/${bs.length} attive`;
}

function setPath(obj, pathStr, value){
  const parts = pathStr.split('.');
  let cur = obj;
  for (let i=0;i<parts.length-1;i++) cur = cur[parts[i]];
  const key = parts[parts.length-1];
  if (key === 'excludeKeywords'){
    cur[key] = String(value).split('\n').map(s=>s.trim()).filter(Boolean);
  } else if (key === 'groupDepth' || key === 'refreshMinutes' || key === 'maxDepth' || key === 'cacheTtlMinutes' || key === 'autoRefreshMinutes'){
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
    const t = prompt('Token amministratore (ADMIN_TOKEN):') || '';
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
const LOG_MAX_LINES = 600; // limite nel DOM (il server ne tiene 1000)

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
  } catch (_) { /* log silenzioso: mai disturbare con il polling */ }
}

function renderLogs(){
  const box = $('#logBox');
  const scope = $('#logScope').value;
  const f = ($('#logFilter').value || '').trim().toLowerCase();
  const rows = LOG.lines.filter(e =>
    (scope === 'all' || e.scope === scope) &&
    (!f || e.msg.toLowerCase().includes(f) || e.scope.includes(f))
  );
  // auto-scroll solo se l'utente e' gia' in fondo
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = rows.length
    ? rows.map(e =>
        `<span class="lgline ${e.level}"><span class="lgts">${fmtLogTs(e.ts)}</span><span class="lgscope">${esc(e.scope)}</span>${esc(e.msg)}</span>`
      ).join('')
    : `<div class="hint">${LOG.lines.length ? 'Nessun evento corrisponde ai filtri.' : 'In attesa di eventi…'}</div>`;
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
  $('#logPause').textContent = LOG.pause ? '▶ Riprendi' : '⏸ Pausa';
  $('#logPause').classList.toggle('on', LOG.pause);
});
$('#logClear').addEventListener('click', async () => {
  try { await api('/api/logs/clear', { method: 'POST', body: '{}' }); } catch (_) { /* niente */ }
  LOG.lines.length = 0;
  LOG.since = 0;
  renderLogs();
});
$('#logScope').addEventListener('change', renderLogs);
$('#logFilter').addEventListener('input', renderLogs);
$('#logDownload').addEventListener('click', exportLogs);
setInterval(pollLogs, 1500);
pollLogs();

async function loadBranches(id){
  try {
    const r = await api(`/api/lists/${id}/tree`);
    if (r.fetching){ TREES[id] = null; return; }
    // il server ordina i rami secondo options.order SALVATO: riapplica l'ordine
    // locale (anche non ancora salvato) per non cancellare i trascinamenti in corso
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

/** Attende che lo scaricamento in background finisca, aggiornando la UI.
 *  Interroga /api/config: esiste sempre e il server lo usa anche per far
 *  ripartire da solo gli scaricamenti interrotti (es. dopo un riavvio). */
const POLLING = new Map(); // id -> promise, un solo polling per lista

async function waitReady(id){
  const start = Date.now();
  let last = null;
  let fails = 0;
  while (Date.now() - start < 15*60*1000){
    await sleep(2500);
    let cfg;
    try { cfg = await api('/api/config'); fails = 0; }
    catch(e){
      if (++fails >= 10){ toast('Il server non risponde: ricarica la pagina.', 6000); return false; }
      continue; // errore transitorio: continua a provare
    }
    const fresh = cfg.lists.find(x=>x.id===id);
    if (!fresh) return false; // lista eliminata
    const mine = CFG.lists.find(x=>x.id===id);
    const s = fresh.state || {};
    if (mine) mine.state = s;
    if (s.status !== last){ last = s.status; renderLists(); }
    if (s.status === 'ready'){
      if (mine && !mine.name && fresh.name){
        mine.name = fresh.name; // nome assegnato dal server...
        if (cfg.rev) CFG.rev = cfg.rev; // ...che ha anche incrementato la revisione
      }
      await loadBranches(id);
      renderLists();
      return true;
    }
    if (s.status === 'error'){ toast('Errore: ' + (s.error || 'sconosciuto'), 6000); renderLists(); return false; }
  }
  toast('Lo scaricamento sta impiegando molto: riprova più tardi con Aggiorna.', 6000);
  return false;
}

function pollUntilReady(id){
  if (POLLING.has(id)) return POLLING.get(id);
  const p = waitReady(id).finally(()=>POLLING.delete(id));
  POLLING.set(id, p);
  return p;
}

/** Avvia il polling per le liste gia' in scaricamento (es. a pagina appena aperta). */
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
  $('#s_cacheTtlMinutes').value = CFG.settings.cacheTtlMinutes;
  $('#s_autoRefreshMinutes').value = CFG.settings.autoRefreshMinutes;
  $('#s_maxDepth').value = CFG.settings.maxDepth;
  $('#s_userAgent').value = CFG.settings.userAgent || '';
  $('#s_token').value = CFG.settings.token || '';
  $('#s_publicBaseUrl').value = CFG.settings.publicBaseUrl || '';
  $('#s_epgUrl').value = CFG.settings.epgUrl || '';
  $('#s_dedupeGlobal').checked = !!CFG.settings.dedupeGlobal;
  $('#s_fitLogos').checked = CFG.settings.fitLogos !== false;
  $('#s_streamDiag').checked = !!CFG.settings.streamDiag;
  const base = (CFG.settings.publicBaseUrl || location.origin).replace(/\/+$/, '');
  const m = base + '/manifest.json' + tokenQs();
  $('#manifestUrl').textContent = m;
  $('#m3uUrl').textContent = base + '/playlist.m3u' + tokenQs();
  $('#m3uLink').href = base + '/playlist.m3u' + tokenQs();
  renderLists();
  $('#status').textContent = `${CFG.lists.length} liste · ${CFG.lists.filter(l=>l.options.enabled).length} attive`;
  if (CFG.version && String(CFG.version) !== WM_UI_VERSION){
    // pagina stale dal browser: l'UI e il server non sono allineati (bug "fantasma" possibili)
    const el = $('#appVersion');
    el.textContent = `WiseM3U v${CFG.version} ⚠ pagina UI v${WM_UI_VERSION}: aggiorna con Ctrl+Maiusc+R`;
    el.style.color = 'var(--warn)';
    toast('Pagina di configurazione stale (cache del browser): premi Ctrl+Maiusc+R per aggiornarla', 6000);
  } else {
    $('#appVersion').textContent = CFG.version ? `WiseM3U v${CFG.version}` : '';
  }
}

function readSettings(){
  CFG.settings.addonName = $('#s_addonName').value.trim() || 'WiseM3U';
  CFG.settings.addonId = $('#s_addonId').value.trim() || 'community.wisem3u';
  CFG.settings.cacheTtlMinutes = Number($('#s_cacheTtlMinutes').value) || 1440;
  CFG.settings.autoRefreshMinutes = Number($('#s_autoRefreshMinutes').value) || 0;
  CFG.settings.maxDepth = Number($('#s_maxDepth').value) || 8;
  // una riga sola: il server ripulisce comunque CR/LF (header injection)
  CFG.settings.userAgent = $('#s_userAgent').value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
  CFG.settings.token = $('#s_token').value.trim();
  CFG.settings.publicBaseUrl = $('#s_publicBaseUrl').value.trim();
  CFG.settings.epgUrl = $('#s_epgUrl').value.trim();
  CFG.settings.dedupeGlobal = $('#s_dedupeGlobal').checked;
  CFG.settings.fitLogos = $('#s_fitLogos').checked;
  CFG.settings.streamDiag = $('#s_streamDiag').checked;
}

async function saveConfig(){
  readSettings();
  const payload = { settings: CFG.settings, lists: CFG.lists, reason: 'salvataggio manuale', baseRev: CFG.rev };
  try {
    const saved = await api('/api/config', { method:'PUT', body: JSON.stringify(payload) });
    CFG = saved;
    renderAll();
    loadHistory();
    toast('Configurazione salvata ✔');
  } catch(e){
    if (e.status === 409){
      // qualcun altro (altra scheda, merge automatico, refresh) ha cambiato la
      // configurazione: non sovrascrivere, chiedi se riallinearsi al server
      if (confirm('La configurazione è cambiata altrove (altra scheda o operazione automatica).\nRicaricare la versione del server? Le modifiche non ancora salvate in questa pagina andranno perse.')){
        await loadConfig();
        loadHistory();
        toast('Configurazione ricaricata dal server');
      } else {
        toast('Salvataggio annullato: il server ha una versione più recente', 6000);
      }
      return;
    }
    toast('Errore: '+e.message, 4000);
  }
}

async function refreshList(id, btn){
  if (btn){ btn.disabled = true; btn.textContent = 'Aggiorno…'; }
  const l = CFG.lists.find(x=>x.id===id);
  try {
    await api(`/api/lists/${id}/refresh`, { method:'POST' });
    if (l) l.state = { status:'fetching' };
    renderLists();
    const ok = await pollUntilReady(id);
    if (ok) toast('Lista aggiornata ✔');
  } catch(e){ toast('Errore: '+e.message, 4000); }
  finally { renderLists(); }
}

async function delList(id){
  try {
    const r = await api(`/api/lists/${id}`, { method:'DELETE' });
    delete TREES[id];
    await loadConfig();
    showUndo('Lista eliminata', r.undo);
  } catch(e){ toast('Errore: '+e.message); }
}

/** URL incollato da pagine/messaggi HTML: &amp;/&#38; tornano a & (v. anche lato server). */
function cleanListUrl(s){
  return String(s || '').trim().replace(/&amp;/gi, '&').replace(/&#0?38;/gi, '&');
}

async function addList(){
  const url = cleanListUrl($('#newUrl').value);
  const name = $('#newName').value.trim();
  if (!url) return toast('Inserisci un URL');
  const btn = $('#btnAdd'); btn.disabled = true; btn.textContent = 'Aggiungo…';
  try {
    const r = await api('/api/lists', { method:'POST', body: JSON.stringify({ url, name }) });
    OPEN_LISTS.add(r.list.id);   // la lista appena creata si apre da sola
    $('#newUrl').value = ''; $('#newName').value = '';
    await loadConfig();
    toast('Lista aggiunta: scaricamento in background…');
    const ok = await pollUntilReady(r.list.id);
    if (ok) toast('Lista pronta: sistema i rami qui sotto ✔');
  } catch(e){ toast('Errore: '+e.message, 5000); }
  finally { btn.disabled=false; btn.textContent='Aggiungi'; renderLists(); }
}

async function testEasyProxy(card, list, btn){
  const box = card.querySelector('[data-epbox]');
  if (!list.options.easyProxy){
    box.innerHTML = '<div class="err">Inserisci prima l\'URL di EasyProxy.</div>';
    return;
  }
  btn.disabled = true;
  box.innerHTML = '<div class="hint">Test della connessione in corso…</div>';
  try {
    const r = await api('/api/easyproxy/test', { method:'POST', body: JSON.stringify({
      base: String(list.options.easyProxy || '').trim().replace(/\/+$/, ''),
      password: list.options.easyProxyPassword || '',
      testUrl: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
    })});
    if (!r.ok){
      if (epNetErr(r.error)) {
        box.innerHTML = `<div class="warn"><b>Avviso non bloccante.</b> ${esc(r.error || 'Connessione fallita')}${epHint(r.error)}</div>`;
      } else {
        box.innerHTML = `<div class="err">${esc(r.error || 'Connessione fallita')}${epHint(r.error)}</div>`;
      }
    } else {
      const v = r.info || {};
      const pt = r.proxyTest;
      const ptHtml = pt
        ? (pt.error
          ? `<span class="pill">test proxy <b style="color:#ffb4ab">KO</b></span><div class="${epNetErr(pt.error)?'warn':'err'}" style="margin-top:6px">${epNetErr(pt.error)?'<b>Avviso non bloccante.</b> ':''}${esc(pt.error)}${epHint(pt.error)}</div>`
          : `<span class="pill">test proxy <b style="color:#9be7b4">HTTP ${pt.status}</b> (${pt.ms} ms)</span>`)
        : '';
      box.innerHTML = `<div class="hint" style="margin-top:8px">
        <span class="pill">EasyProxy <b style="color:#9be7b4">raggiungibile</b></span>
        ${v.version?`<span class="pill">versione <b style="color:#fff">${esc(v.version)}</b></span>`:''}
        ${v.public_ip?`<span class="pill">IP di uscita <b style="color:#fff">${esc(v.public_ip)}</b></span>`:''}
        ${ptHtml}
      </div>
      <div class="hint">Se il test proxy risponde <b>HTTP 200</b> gli stream passano da EasyProxy.
        Ricorda <b>Salva configurazione</b> per applicare la riscrittura degli URL.</div>`;
    }
  } catch(e){
    box.innerHTML = `<div class="${epNetErr(e.message)?'warn':'err'}">${epNetErr(e.message)?'<b>Avviso non bloccante.</b> ':''}${esc(e.message)}${epHint(e.message)}</div>`;
  }
  finally { btn.disabled = false; }
}

/** Vero se l'errore del test e' di rete/certificato: non bloccante, perche' a connettersi e' il client. */
function epNetErr(err){
  return /timeout|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|getaddrinfo|certificate|self signed|self-signed|unable to verify|SSL routines|DNS pubblici/i.test(String(err || ''));
}

/** Suggerimento mirato in base al tipo di errore del test EasyProxy. */
function epHint(err){
  const e = String(err || '');
  if (/certificate|self signed|self-signed|unable to verify|SSL routines/i.test(e)) {
    return ' Il container non si fida del certificato: non e\' bloccante, l\'importante e\' che se ne fidi il client (TV/telefono); con un certificato Let\'s Encrypt e\' automatico.';
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|timeout/i.test(e)) {
    return ' Sulle reti di casa il container spesso non raggiunge il proprio dominio pubblico (manca il NAT hairpin): non e\' bloccante, verifica la riproduzione sul client.';
  }
  return '';
}

async function probe(){
  const url = cleanListUrl($('#newUrl').value);
  if (!url) return toast('Inserisci un URL');
  const box = $('#probeBox');
  box.innerHTML = '<div class="hint">Download e analisi in corso…</div>';
  try {
    const r = await api('/api/probe', { method:'POST', body: JSON.stringify({ url }) });
    const t = r.tree;
    box.innerHTML = `<div class="hint" style="margin-top:10px">
      <span class="pill">nome <b style="color:#fff">${esc(t.meta.name)}</b></span>
      <span class="pill">formato <b style="color:#fff">${esc(t.meta.kind || 'wiseplay')}</b></span>
      <span class="pill">nodi <b style="color:#fff">${t.stats.nodes}</b></span>
      <span class="pill">stream <b style="color:#fff">${t.stats.stations}</b></span>
      <span class="pill">m3u importate <b style="color:#fff">${t.stats.m3u}</b></span>
      ${t.errors.length?`<span class="pill">errori <b style="color:#fff">${t.errors.length}</b></span>`:''}
    </div>`;
  } catch(e){ box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

/* ---------------- copia negli appunti ---------------- */
function copyText(t){
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
  return new Promise((res, rej) => {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy') ? res() : rej(new Error('copia non riuscita')); }
    catch(e){ rej(e); }
    finally { ta.remove(); }
  });
}

/* ---------------- init ---------------- */
$('#btnCopyManifest').addEventListener('click', () => {
  copyText($('#manifestUrl').textContent).then(
    () => toast('URL del manifest copiato ✔'),
    (e) => toast('Copia non riuscita: ' + e.message, 4000)
  );
});
$('#btnCopyM3u').addEventListener('click', () => {
  copyText($('#m3uUrl').textContent).then(
    () => toast('URL playlist M3U copiato ✔'),
    (e) => toast('Copia non riuscita: ' + e.message, 4000)
  );
});
$('#btnAdd').addEventListener('click', addList);
$('#newUrl').addEventListener('keydown', e=>{ if(e.key==='Enter') addList(); });
$('#btnNewPList').addEventListener('click', createPersonalList);
$('#sdToggle').addEventListener('click', () => { const el = $('#sidemenu'); el.hidden = !el.hidden; });
$('#sidemenu').addEventListener('click', async (ev) => {
  const go = ev.target.closest('[data-sdgo]');
  if (go){
    const card = document.querySelector(`#lists [data-id="${CSS.escape(go.dataset.sdgo)}"]`);
    if (card){
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
    }
    // su smartphone il menu è un bottom sheet: chiudilo, altrimenti copre la lista raggiunta
    ev.currentTarget.hidden = true;
    return;
  }
  const up = ev.target.closest('[data-sdup]');
  const dn = ev.target.closest('[data-sddn]');
  if (up || dn){
    const i = Number(up ? up.dataset.sdup : dn.dataset.sddn);
    const j = up ? i - 1 : i + 1;
    if (j < 0 || j >= CFG.lists.length) return;
    [CFG.lists[i], CFG.lists[j]] = [CFG.lists[j], CFG.lists[i]];
    await saveConfig();
    renderLists();
  }
});
$('#btnProbe').addEventListener('click', probe);
$('#btnSave').addEventListener('click', saveConfig);
$('#btnReload').addEventListener('click', loadConfig);
$('#btnClearCache').addEventListener('click', async ()=>{
  if(!confirm('Svuotare la cache di tutte le liste?')) return;
  try { await api('/api/cache/clear',{method:'POST'}); toast('Cache svuotata'); } catch(e){ toast(e.message); }
});

/* ---------------- cronologia configurazione ---------------- */

const HIST = { entries: [] };

const HIST_CATS = [
  ['settings', 'Impostazioni generali'],
  ['lists', 'Elenco liste (nomi e URL)'],
  ['order', 'Ordine delle playlist'],
  ['names', 'Nomi di playlist e canali'],
  ['exclusions', 'Esclusioni'],
  ['moves', 'Unioni e spostamenti'],
  ['trash', 'Cestino'],
  ['groups', 'Gruppi personali'],
  ['listSettings', 'Impostazioni delle liste'],
];
const HIST_LABEL = Object.fromEntries(HIST_CATS);

function histListOptions(){
  const sel = $('#histList');
  if (!sel || typeof CFG === 'undefined' || !CFG) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Tutte le liste</option>' +
    CFG.lists.map((l)=>`<option value="${esc(l.id)}">${esc(l.name || l.url || l.id)}</option>`).join('');
  if (cur && CFG.lists.some((l)=>l.id===cur)) sel.value = cur;
}

function describeChanges(ch){
  if (!ch) return 'nessuna differenza calcolata';
  const parts = [];
  if (ch.settings) parts.push('impostazioni generali');
  if (ch.lists) parts.push('elenco liste');
  const cats = new Set();
  for (const arr of Object.values(ch.options || {})) (arr || []).forEach((c)=>cats.add(c));
  for (const c of cats) parts.push((HIST_LABEL[c] || c).toLowerCase());
  return parts.length ? `Cambia: ${parts.join(', ')}` : 'Nessuna differenza';
}

function renderHistory(){
  const box = $('#histBody');
  if (!box) return;
  if (!HIST.entries.length){
    box.innerHTML = '<div class="hint">Nessuna modifica registrata: la cronologia parte dal prossimo salvataggio.</div>';
    return;
  }
  box.innerHTML = HIST.entries.map((e)=>{
    const when = new Date(e.ts).toLocaleString('it-IT');
    return `<div class="histrow" data-hrow="${esc(e.id)}">
      <div class="histhead">
        <b>${esc(when)}</b>
        ${e.name ? `<span class="badge ready">★ ${esc(e.name)}</span>` : ''}
        ${e.reason ? `<span class="badge idle">${esc(e.reason)}</span>` : ''}
        ${e.listName ? `<span class="cnt">${esc(e.listName)}</span>` : ''}
        <div class="histactions"><button class="ghost small" data-hpick="${esc(e.id)}">${e.name ? '↩ Ripristina checkpoint…' : '↩ Ripristina…'}</button></div>
      </div>
      <div class="histchanges">${esc(describeChanges(e.changes))}</div>
      <div class="histrestore" hidden data-hpanel="${esc(e.id)}"></div>
    </div>`;
  }).join('');
}

function histPanelHtml(entry){
  const listId = $('#histList').value;
  // un checkpoint rappresenta lo stato completo: parti con tutte le categorie
  // spuntate (l'utente puo' comunque toglierne alcune)
  const all = !!entry.name;
  const cats = HIST_CATS
    .filter(([k])=>!(k === 'lists' && listId))
    .map(([k,label])=>`<label class="hopt"><input type="checkbox" name="hcat" value="${k}" ${
      (all || (k !== 'settings' && k !== 'lists')) ? 'checked' : ''}>${esc(label)}</label>`)
    .join('');
  const when = new Date(entry.ts).toLocaleString('it-IT');
  return `<div class="hint">${all ? `Checkpoint <b>★ ${esc(entry.name)}</b> del <b>${esc(when)}</b>. Tutte le categorie sono spuntate: togli la spunta a quelle che non vuoi ripristinare.` : `Stato del <b>${esc(when)}</b>${entry.listName ? ` · ${esc(entry.listName)}` : ''}.`}
      ${listId ? 'Le categorie si applicano solo alla lista selezionata.' : 'Le categorie delle opzioni si applicano a tutte le liste.'}
      <br>Il ripristino verrà registrato come nuovo stato: potrai annullarlo.</div>
    <div class="hcats">${cats}</div>
    <div class="hrow">
      <button class="danger small" data-hgo="${esc(entry.id)}">Ripristina selezionato</button>
      <button class="ghost small" data-hcancel="1">Annulla</button>
    </div>`;
}

async function saveCheckpoint(){
  const name = (prompt('Nome del checkpoint (es. «prima del merge»):') || '').trim().slice(0, 80);
  if (!name) return;
  try {
    await api('/api/history/checkpoints', { method:'POST', body: JSON.stringify({ name }) });
    // il checkpoint e' globale: togli il filtro per vederlo subito in elenco
    $('#histList').value = '';
    toast('Checkpoint «' + name + '» salvato ✔');
    await loadHistory();
  } catch(e){ toast('Errore: '+e.message, 4000); }
}

async function loadHistory(){
  const box = $('#histBody');
  if (!box) return;
  histListOptions();
  const listId = $('#histList').value;
  $('#histStatus').textContent = 'Carico…';
  try {
    const r = await api('/api/history' + (listId ? `?list=${encodeURIComponent(listId)}` : ''));
    HIST.entries = r.entries || [];
    renderHistory();
    $('#histStatus').textContent = `${HIST.entries.length} stati`;
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
    if (!cats.length){ toast('Spunta almeno una categoria da ripristinare'); return; }
    const when = new Date(entry.ts).toLocaleString('it-IT');
    const msg = entry.name
      ? `Ripristinare le categorie selezionate dal checkpoint «${entry.name}»?`
      : `Ripristinare le categorie selezionate dallo stato del ${when}?`;
    if (!confirm(msg + '\nVerrà creato un nuovo stato, quindi potrai annullare anche questo ripristino.')) return;
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
      toast('Ripristino completato ✔');
      await loadHistory();
    } catch (e){ toast(e.message, 4000); go.disabled = false; }
  });
})();

/* ---------------- icone info e sezioni comprimibili ---------------- */

/** Racchiude il testo del titolo in uno span (.ttl) cosi' che numero, titolo,
 *  icona info e pulsante di espansione restano sempre sulla stessa riga. */
function wrapHeadingText(h2){
  if (!h2 || h2.querySelector(':scope > .ttl')) return;
  const texts = [...h2.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
  if (!texts.length) return;
  const ttl = document.createElement('span');
  ttl.className = 'ttl';
  texts[0].before(ttl);
  texts.forEach(n => ttl.appendChild(n));
}

/** Sposta tutte le note informative di un contenitore accanto al suo titolo,
 *  dentro un unico pannello (i) apribile al tocco. */
function collectInfo(container, host, { skip }={}){
  if (!container || !host || host.querySelector(':scope > .sectinfo')) return;
  const items = [...container.querySelectorAll('[data-info], details.help')]
    .filter(el => !el.closest('details.info') && !(skip && el.closest(skip)));
  if (!items.length) return;

  const panel = document.createElement('details');
  panel.className = 'info sectinfo';
  const sum = document.createElement('summary');
  sum.textContent = 'i';
  sum.title = 'Informazioni';
  sum.setAttribute('aria-label', 'Informazioni');
  const body = document.createElement('div');
  body.className = 'ibody';

  for (const el of items){
    let label = '';
    let content = null;
    if (el.matches('details.help')){
      const s = el.querySelector('summary');
      label = (s ? s.textContent : '').trim().replace(/^[^\p{L}\p{N}]+/u, '');
      content = el.querySelector('.hint');
      el.remove();                       // il blocco help diventa una nota del pannello
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

/** Sezioni statiche (1, 2, 3, 5): info nel titolo. */
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

/** Schede lista: info accanto al nome; il blocco playlist ha il suo pannello. */
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

/** Rende il titolo della sezione cliccabile (▾/▸ e' solo un indicatore). */
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
    h2.title = collapsed ? 'Espandi la sezione' : 'Comprimi la sezione';
  };
  const toggle = ()=>{ collapsed = !collapsed; sync(); };
  h2.setAttribute('role', 'button');
  h2.tabIndex = 0;
  h2.addEventListener('click', ev=>{
    // l'icona info e gli eventuali comandi dentro il titolo non comprimono la sezione
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
  // sezioni con il titolo dentro (1, 2, 3): si comprime il contenuto, il titolo resta
  document.querySelectorAll('main > section.card').forEach(sec=>{
    const h2 = sec.querySelector(':scope > h2');
    if (h2) makeSectionToggle(h2, (c)=>sec.classList.toggle('collapsed', c), sec.dataset.collapsed === '1');
  });
  // Log live: il titolo sta fuori dalla sezione, quindi si nasconde la sezione intera
  document.querySelectorAll('main > h2.secttl').forEach(h2=>{
    const sec = h2.nextElementSibling;
    if (sec && sec.matches('section.card')){
      makeSectionToggle(h2, (c)=>{ sec.hidden = c; }, h2.dataset.collapsed === '1');
    }
  });
}

decorateSections();
initCollapsibleSections();

/* ---- info: ancoraggio del pannello senza uscire dallo schermo ---- */
(function placeInfoPanels(){
  document.addEventListener('toggle', (ev)=>{
    const p = ev.target;
    if (!p || !p.classList || !p.classList.contains('sectinfo') || !p.open) return;
    if (window.matchMedia && window.matchMedia('(max-width:560px)').matches) return; // mobile: foglio fisso
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

  // un solo pannello aperto alla volta
  document.addEventListener('toggle', (ev)=>{
    const p = ev.target;
    if (!p || !p.classList || !p.classList.contains('sectinfo') || !p.open) return;
    document.querySelectorAll('details.sectinfo[open]').forEach(d=>{ if (d !== p) d.open = false; });
  }, true);
})();

/* ---- info: chiusura al tocco fuori dal pannello o con Esc ---- */
(function closeInfoPanels(){
  const closeAll = ()=>{ document.querySelectorAll('details.sectinfo[open]').forEach(d=>{ d.open = false; }); };
  document.addEventListener('pointerdown', (ev)=>{
    document.querySelectorAll('details.sectinfo[open]').forEach(d=>{
      if (!d.contains(ev.target)) d.open = false;
    });
  }, true);
  document.addEventListener('keydown', (ev)=>{ if (ev.key === 'Escape') closeAll(); });
})();

/* ---- tastiera: i pulsanti flottanti non devono galleggiare sopra i tasti ---- */
(function watchKeyboard(){
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = ()=>{
    // su iOS il layout viewport non cambia: il calo di visualViewport.height e' il segnale
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
$('#fabReload').addEventListener('click', loadConfig);

/* torna in alto: sempre flottante su mobile, scroll fluido salvo preferenza utente */
$('#toTop').addEventListener('click', ()=>{
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try { window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); }
  catch (_) { window.scrollTo(0, 0); }
});

// badge Xtream: click per rileggere i dati (niente handler inline nel markup)
document.addEventListener('click', (ev) => {
  const badge = ev.target.closest('[data-xtream]');
  if (badge) refreshXtreamBadge(badge.dataset.xtream);
});

loadConfig().then(()=>{ loadHistory(); }).catch(e=>{
  $('#lists').innerHTML = `<section class="card"><div class="err">Impossibile caricare la configurazione: ${esc(e.message)}</div></section>`;
});
