'use strict';

/**
 * Costruzione della playlist finale (M3U) e dei cataloghi Stremio/Nuvio
 * a partire dalle liste WisePlay configurate.
 */

const { flattenStations, findByPath, pathNames } = require('./wiseplay');
const { makeBranchSelector, matchesKeywords } = require('./selection');
const { normalizeStreamUrl, protocolBadge } = require('./protocols');

/**
 * Se la lista ha EasyProxy configurato, riscrive l'URL dello stream come
 * `BASE/proxy/manifest.m3u8?url=...`: sara' EasyProxy a scaricare il flusso
 * (con il suo DNS/WARP/estrattori) e a servirlo al client. Utile per le liste
 * "(dns)" che dal client non risolvono. I link acestream:// restano intatti:
 * EasyProxy non puo' gestirli.
 */
function proxyStreamUrl(url, list) {
  const base = ((list.options && list.options.easyProxy) || '').replace(/\/+$/, '');
  if (!base || !url || !/^https?:\/\//i.test(url)) return url;
  const q = [`url=${encodeURIComponent(url)}`];
  if (list.options.easyProxyPassword) q.push(`api_password=${encodeURIComponent(list.options.easyProxyPassword)}`);
  if (list.options.easyProxyParams) q.push(list.options.easyProxyParams);
  return `${base}/proxy/manifest.m3u8?${q.join('&')}`;
}
const { buildM3U } = require('./m3u');
const cache = require('./cache');

const JOINER = ' › ';

function listPrefix(list) {
  const mode = list.options.groupPrefix || 'list';
  if (mode === 'none') return '';
  if (mode === 'custom') return list.options.customPrefix || list.name || 'WisePlay';
  return list.name || 'WisePlay';
}

function prefixJoiner(prefix) {
  return prefix ? `${prefix}${JOINER}` : '';
}

/**
 * Raccoglie i canali di tutte le liste abilitate.
 * @param {object} config config normalizzata
 * @param {object} [opts] { force }
 * @returns {Promise<{channels:Array, lists:Array, errors:Array, epgUrls:string[]}>}
 */
async function collectChannels(config, opts = {}) {
  const seen = new Set();
  const seenPersonal = new Set();
  const channels = [];
  const listResults = [];
  const errors = [];
  const epgUrls = []; // EPG ereditati dalle sorgenti m3u/m3u_plus attive

  for (const list of config.lists) {
    if (!list.options.enabled || (!list.url && list.kind !== 'personal')) {
      listResults.push({ id: list.id, name: list.name || list.url, skipped: true });
      continue;
    }

    // le righe sono memoizzate in listRows: playlist, cataloghi e canali
    // condividono lo stesso flatten invece di rifarlo ogni volta
    let value;
    try {
      value = await listRows(config, list, opts);
    } catch (err) {
      errors.push({ list: list.name || list.url, error: err.message || String(err) });
      listResults.push({ id: list.id, name: list.name || list.url, error: err.message, channels: 0 });
      continue;
    }

    let kept = 0;
    let droppedDup = 0;
    const isPersonal = list.kind === 'personal';
    for (const ch of value.rows) {
      const key = ch.url.toLowerCase();
      if (isPersonal) {
        // le personali pescano dalle stesse sorgenti: il dedup globale le
        // cancellerebbe; deduplichiamo solo dentro le liste personali
        if (seenPersonal.has(key)) { droppedDup++; continue; }
        seenPersonal.add(key);
      } else if (config.settings.dedupeGlobal && list.options.dedupe !== false && seen.has(key)) {
        droppedDup++;
        continue;
      }
      seen.add(key);
      kept++;
      channels.push({
        name: ch.name,
        url: ch.url,
        logo: ch.logo || '',
        group: ch.group || listPrefix(list),
        listId: list.id,
        listName: listPrefix(list),
        path: ch.path,
        badge: protocolBadge(ch.url),
      });
    }

    for (const u of value.epgUrls || []) {
      if (!epgUrls.includes(u)) epgUrls.push(u);
    }

    listResults.push({
      id: list.id,
      name: list.name || list.url,
      fetchedAt: value.fetchedAt,
      total: value.stats.total,
      channels: kept,
      droppedProto: value.stats.droppedProto,
      droppedKeyword: value.stats.droppedKeyword,
      droppedDup,
      error: value.error || '',
    });
  }

  return { channels, lists: listResults, errors, epgUrls };
}

/* ----------------------- liste composite (personali) ----------------------- */

/** Legge "listId::path::nome" ('*' = playlist intera). */
function parsePersonalSrc(src) {
  const i1 = String(src).indexOf('::');
  const i2 = String(src).indexOf('::', i1 + 2);
  if (i1 < 0 || i2 < 0) return null;
  return { listId: src.slice(0, i1), path: src.slice(i1 + 2, i2), name: src.slice(i2 + 2) };
}

/** Rami sintetici dalle voci personalEntries (usati dalle liste personali e, in
 *  coda, anche dalle liste normali). Le sorgenti possono essere a loro volta
 *  liste personali; 'chain' evita i cicli. */
async function synthChildren(config, list, entries, basePath, chain = []) {
  const selfId = list.id;
  const del = new Set(list.options.deletedChannels || []);
  const delB = new Set(list.options.deletedBranches || []);
  const children = [];
  const into = new Map(); // dst (path di un ramo esistente) -> stazioni da innestare
  let nStations = 0;
  let slots = 0; // contatore posizionale: gli slot eliminati restano riservati
  for (const e of entries || []) {
    if (!e || typeof e.src !== 'string') continue;
    const p = parsePersonalSrc(e.src);
    if (!p) continue;
    const srcList = config.lists.find((l) => l.id === p.listId);
    if (!srcList || srcList.id === selfId || chain.includes(srcList.id)) continue;
    if (srcList.kind !== 'personal' && !srcList.url) continue;
    let stree;
    try {
      stree = (await entryFor(config, srcList, false, [...chain, selfId])).tree;
    } catch (_) { continue; }
    const node = findByPath(stree, p.path);
    if (!node) continue;
    if (typeof e.dst === 'string' && e.dst !== '') {
      // canale innestato DENTRO un ramo esistente della lista destinazione
      if (p.name === '*') continue;
      if (delB.has(e.dst)) continue; // ramo di destinazione eliminato
      const st = (node.stations || []).find((x) => x.name === p.name);
      if (!st) continue;
      if (del.has(`${e.dst}::${st.name}`)) continue;
      if (!into.has(e.dst)) into.set(e.dst, []);
      into.get(e.dst).push({ ...st });
      nStations += 1;
      continue;
    }
    // path posizionale (come nelle liste vere): findByPath naviga per indice.
    // Lo slot viene consumato anche se il ramo/canale e' stato eliminato, cosi'
    // le chiavi posizionali (rinomine, disattivazioni) restano stabili.
    const bpath = String(basePath + slots);
    // Lo slot viene sempre consumato (e il figlio sempre inserito) cosi' gli
    // indici dei figli coincidono coi path posizionali: findByPath naviga per
    // indice. Rami/canali eliminati restano nell'albero ma sono filtrati
    // ovunque tramite deletedBranches/deletedChannels; il cestino li legge da li'.
    if (p.name === '*') {
      const stations = (node.stations || []).map((st) => ({ ...st }));
      slots++;
      const branchDel = delB.has(bpath);
      const kept = branchDel ? stations : stations.filter((st) => !del.has(`${bpath}::${st.name}`));
      children.push({ name: node.name, path: bpath, image: node.image || '', external: [], children: [], stations: kept });
      if (!branchDel) nStations += kept.length;
    } else {
      const st = (node.stations || []).find((x) => x.name === p.name);
      if (!st) continue;
      slots++;
      const chanDel = del.has(`${bpath}::${st.name}`);
      const branchDel = delB.has(bpath);
      const sts = branchDel || !chanDel ? [{ ...st }] : [];
      children.push({ name: st.name, path: bpath, image: '', external: [], children: [], stations: sts });
      if (!branchDel && !chanDel) nStations += 1;
    }
  }
  return { children, nStations, into };
}

/** Innesta le stazioni "into" nei rami esistenti (clone per non toccare la cache).
 *  I path possono puntare a rami annidati (es. "0.1.0"): la ricerca è ricorsiva. */
function applyInto(children, into) {
  if (!into || !into.size) return children;
  const seen = new Set();
  const walk = (nodes) =>
    nodes.map((c) => {
      let out = c;
      const add = into.get(c.path);
      if (add) {
        out = { ...out, stations: [...(out.stations || []), ...add] };
        seen.add(c.path);
      }
      if ((c.children || []).length && seen.size < into.size) {
        out = { ...out, children: walk(c.children) };
      }
      return out;
    });
  return walk(children);
}

/** Albero sintetico di una lista personale. */
async function buildPersonalTree(config, list) {
  const s = await synthChildren(config, list, list.options.personalEntries, 0);
  const children = applyInto(s.children, s.into);
  const delB = new Set(list.options.deletedBranches || []);
  const nStations = children.reduce((n, c) => (delB.has(c.path) ? n : n + (c.stations || []).length), 0);
  const name = list.name || 'Lista personale';
  return {
    id: 'root',
    name,
    path: '',
    image: '',
    external: [],
    stations: [],
    children,
    meta: { name, kind: 'personal' },
    stats: { nodes: children.length, stations: nStations, external: 0, m3u: 0, failed: 0 },
  };
}

/** Entry albero di una lista: sintetico per le personali; per le normali aggiunge
 *  in coda i rami sintetici (contenuto importato da altre liste). */
async function entryFor(config, list, force = false, chain = []) {
  if (list.kind === 'personal') {
    return cache.getTree({ id: list.id, url: '', builder: () => buildPersonalTree(config, list) });
  }
  const entry = await cache.getTree({
    id: list.id,
    url: list.url,
    ttlMinutes: list.options.refreshMinutes,
    maxDepth: config.settings.maxDepth,
    force,
  });
  const pe = list.options.personalEntries || [];
  if (!pe.length || chain.includes(list.id)) return entry;
  const base = (entry.tree.children || []).length;
  const s = await synthChildren(config, list, pe, base, chain);
  if (!s.children.length && !s.into.size) return entry;
  const merged = applyInto([...(entry.tree.children || []), ...s.children], s.into);
  const tree = { ...entry.tree, children: merged };
  if (tree.stats) {
    const added = merged.slice(base).reduce((n, c) => n + (c.stations || []).length, 0);
    tree.stats = { ...tree.stats, nodes: merged.length, stations: (tree.stats.stations || 0) + added };
  }
  return { ...entry, tree };
}

/** Header EPG per la playlist generata: impostazione manuale + EPG
 *  ereditati dalle sorgenti m3u/m3u_plus. Scrive entrambe le forme comuni
 *  (x-tvg-url per Kodi/Xtream, url-tvg per TiviMate e app IPTV). */
function epgHeader(config, inherited = []) {
  const all = [];
  const manual = String(config.settings.epgUrl || '').trim();
  if (manual) all.push(manual);
  for (const u of inherited) {
    if (/^https?:\/\//i.test(u) && !all.includes(u)) all.push(u);
  }
  if (!all.length) return {};
  const joined = all.join(',');
  return { 'x-tvg-url': joined, 'url-tvg': joined };
}

async function buildPlaylist(config, opts = {}) {
  const { channels, lists, errors, epgUrls } = await collectChannels(config, opts);
  // opts.rewrite (diagnostica stream): riscrittura finale degli URL canale prima dell'M3U
  const out = typeof opts.rewrite === 'function' ? channels.map((c) => opts.rewrite(c) || c) : channels;
  const m3u = buildM3U(out, {
    name: `${config.settings.addonName} (${out.length} canali)`,
    header: epgHeader(config, epgUrls),
  });
  return { m3u, channels, lists, errors, epgUrls };
}

/* ---------------------------- cataloghi ---------------------------- */

const TYPE = 'tv';

// Prefisso stabile di tutti i meta-id: il manifest lo dichiara in idPrefixes,
// cosi' Stremio/Nuvio instradano qui le richieste /meta e /stream.
const ID_PREFIX = 'wise:';

function encodePath(p) {
  return String(p || '')
    .split('.')
    .filter((s) => s !== '')
    .map((s) => Number(s).toString(36))
    .join('.');
}

function decodePath(e) {
  return String(e || '')
    .split('.')
    .filter((s) => s !== '')
    .map((s) => Number.parseInt(s, 36).toString())
    .join('.');
}

function metaId(listId, path, stationIdx) {
  const base = `${ID_PREFIX}${listId}:${encodePath(path)}`;
  return stationIdx == null ? base : `${base}:${stationIdx}`;
}

function parseMetaId(id) {
  let s = String(id);
  if (s.startsWith(ID_PREFIX)) s = s.slice(ID_PREFIX.length);
  const idx = s.indexOf(':');
  if (idx < 0) return null;
  const listId = s.slice(0, idx);
  let rest = s.slice(idx + 1);
  // gli id-canale hanno un suffisso ":<indice stazione>" (retrocompat: senza = gruppo)
  let stationIdx = null;
  const lastColon = rest.lastIndexOf(':');
  if (lastColon >= 0 && /^\d+$/.test(rest.slice(lastColon + 1))) {
    stationIdx = Number(rest.slice(lastColon + 1));
    rest = rest.slice(0, lastColon);
  }
  return { listId, path: decodePath(rest), stationIdx };
}

function catalogId(listId) {
  return `wise:${listId}`;
}

function catalogDisplayName(list) {
  return list.options.catalogName || list.name || 'WisePlay';
}

/* I cataloghi mostrano i CANALI; i gruppi diventano generi (dropdown).
 * Le righe sono memorizzate per lista e ricalcolate solo se cambiano
 * selezione/albero, cosi' paginazione e filtri restano veloci. */

const PAGE_SIZE = 100;
const rowsMemo = new Map();

function rowFingerprint(list, fetchedAt) {
  const o = list.options;
  return (
    JSON.stringify([
      o.disabledPaths, o.renames, o.order, o.protocols, o.aceMode, o.aceEngineHost,
      o.excludeKeywords, o.dedupe, o.groupDepth, o.emitLogo,
      o.groupPrefix, o.customPrefix,
      o.easyProxy, o.easyProxyPassword, o.easyProxyParams,
      o.disabledChannels, o.channelRenames, o.channelOrder, o.channelMoves,
      o.deletedChannels, o.deletedBranches,
    ]) + '|' + fetchedAt
  );
}

/** Posizione di ogni ramo secondo l'ordine scelto dalla configurazione. */
function branchPositions(list) {
  const order = list.options.order || [];
  const pos = new Map();
  order.forEach((p, i) => pos.set(p, i));
  return pos;
}

async function listRows(config, list, opts = {}) {
  const entry = await entryFor(config, list, !!opts.force);
  const fp = rowFingerprint(list, entry.fetchedAt);
  const hit = rowsMemo.get(list.id);
  if (hit && hit.fp === fp) return hit.value;

  const selector = makeBranchSelector(list.options.disabledPaths);
  const prefix = prefixJoiner(listPrefix(list));
  const all = flattenStations(entry.tree, selector, {
    maxDepth: list.options.groupDepth,
    joiner: JOINER,
    prefix: prefix ? prefix.slice(0, -JOINER.length) : '',
    emitLogo: !!list.options.emitLogo,
    renames: list.options.renames,
    disabledChannels: list.options.disabledChannels,
    deletedChannels: list.options.deletedChannels,
    deletedBranches: list.options.deletedBranches,
    channelRenames: list.options.channelRenames,
    channelMoves: list.options.channelMoves,
  });

  const keywords = list.options.excludeKeywords || [];
  const stats = { total: all.length, droppedProto: 0, droppedKeyword: 0 };
  const rows = [];
  for (const r of all) {
    const url = normalizeStreamUrl(r.url, list.options);
    if (!url) { stats.droppedProto++; continue; }
    if (keywords.length && (matchesKeywords(r.name, keywords) || matchesKeywords(r.group, keywords))) {
      stats.droppedKeyword++;
      continue;
    }
    rows.push({ ...r, url: proxyStreamUrl(url, list) });
  }

  // rispetta l'ordine dei rami e, dentro ogni ramo, quello dei canali
  // scelti nella pagina di configurazione (chiavi stabili: path e nome,
  // quindi le personalizzazioni sopravvivono ai cambi di URL)
  // l'ordine segue la destinazione effettiva (gpath): i canali spostati
  // vivono nel ramo/gruppo personale scelto dalla pagina di configurazione
  const pos = branchPositions(list);
  const chanOrder = list.options.channelOrder || {};
  if (pos.size || Object.keys(chanOrder).length) {
    const firstSeen = new Map();
    const posInBranch = new Map();
    const branchCount = new Map();
    rows.forEach((r, i) => {
      if (!firstSeen.has(r.gpath)) firstSeen.set(r.gpath, i);
      const k = `${r.gpath}::${r.origName}`;
      if (!posInBranch.has(k)) {
        const c = branchCount.get(r.gpath) || 0;
        posInBranch.set(k, c);
        branchCount.set(r.gpath, c + 1);
      }
    });
    const chanPos = new Map();
    for (const p of Object.keys(chanOrder)) {
      chanPos.set(p, new Map(chanOrder[p].map((n, i) => [n, i])));
    }
    rows.sort((a, b) => {
      const pa = pos.has(a.gpath) ? pos.get(a.gpath) : 1e9 + firstSeen.get(a.gpath);
      const pb = pos.has(b.gpath) ? pos.get(b.gpath) : 1e9 + firstSeen.get(b.gpath);
      if (pa !== pb) return pa - pb;
      const m = chanPos.get(a.gpath);
      const ca = m && m.has(a.origName) ? m.get(a.origName) : 1e9 + (posInBranch.get(`${a.gpath}::${a.origName}`) || 0);
      const cb = m && m.has(b.origName) ? m.get(b.origName) : 1e9 + (posInBranch.get(`${b.gpath}::${b.origName}`) || 0);
      return ca - cb;
    });
  }

  const value = {
    rows,
    stats,
    fetchedAt: entry.fetchedAt,
    error: entry.error || '',
    // EPG dichiarati dalla sorgente m3u/m3u_plus (snapshot vecchi: assenti)
    epgUrls: (entry.tree && entry.tree.meta && entry.tree.meta.epgUrls) || [],
  };
  rowsMemo.set(list.id, { fp, value });
  return value;
}

/**
 * I rami della lista: i gruppi che contengono direttamente i canali
 * (le "singole playlist"), rinominati e ordinati come da configurazione.
 * Passeggiata leggera sull'albero, senza flatten e senza rete: il manifest
 * deve restare istantaneo anche con 100k+ canali.
 */
function buildBranches(entry, list) {
  if (!entry || !entry.tree) return [];
  const selector = makeBranchSelector(list.options.disabledPaths);
  const renames = list.options.renames || {};
  // quanti canali di ogni ramo sono stati esclusi dalla pagina di configurazione
  const disByBranch = new Map();
  for (const key of list.options.disabledChannels || []) {
    const i = key.lastIndexOf('::');
    if (i < 0) continue;
    const p = key.slice(0, i);
    disByBranch.set(p, (disByBranch.get(p) || 0) + 1);
  }
  // canali/rami eliminati dalla pagina: spariscono del tutto
  const delByBranch = new Map();
  for (const key of list.options.deletedChannels || []) {
    const i = key.lastIndexOf('::');
    if (i < 0) continue;
    const p = key.slice(0, i);
    delByBranch.set(p, (delByBranch.get(p) || 0) + 1);
  }
  const delBranches = new Set(list.options.deletedBranches || []);
  // canali spostati dalla pagina di configurazione: conteggi per destinazione
  const moves = list.options.channelMoves || {};
  const disChannels = new Set(list.options.disabledChannels || []);
  const delChannels = new Set(list.options.deletedChannels || []);
  const outC = new Map();
  const inC = new Map();
  (function scan(node) {
    for (const c of node.children || []) {
      for (const s of c.stations || []) {
        const k = `${c.path}::${s.name}`;
        if (disChannels.has(k) || delChannels.has(k)) continue;
        const t = moves[k];
        if (t && t !== c.path) {
          outC.set(c.path, (outC.get(c.path) || 0) + 1);
          inC.set(t, (inC.get(t) || 0) + 1);
        }
      }
      scan(c);
    }
  })(entry.tree);

  const found = [];
  (function walk(node) {
    for (const c of node.children || []) {
      if (delBranches.has(c.path)) continue;
      if (c.stations && c.stations.length) {
        const native = c.stations.length;
        const del = delByBranch.get(c.path) || 0;
        found.push({
          path: c.path,
          name: c.name,
          displayName: renames[c.path] || c.name,
          stations: Math.max(0, native - del - (outC.get(c.path) || 0)) + (inC.get(c.path) || 0),
          hidden: Math.min(disByBranch.get(c.path) || 0, native - del),
          image: c.image || '',
          enabled: selector(c.path),
        });
      }
      walk(c);
    }
  })(entry.tree);

  // gruppi personali ("@Nome") nati spostando i canali dalla pagina
  for (const [t, n] of inC) {
    if (!t.startsWith('@') || !n) continue;
    if (delBranches.has(t)) continue; // gruppo personale eliminato
    found.push({
      path: t,
      name: t.slice(1),
      displayName: renames[t] || t.slice(1),
      stations: n,
      hidden: 0,
      image: '',
      enabled: true,
      custom: true,
    });
  }
  // playlist/rami personalizzati creati vuoti dalla pagina ("+ nuova playlist")
  for (const g of list.options.customGroups || []) {
    const t = '@' + g;
    if (delBranches.has(t)) continue; // gruppo personale eliminato
    if (found.some((b) => b.path === t)) continue;
    found.push({
      path: t,
      name: g,
      displayName: renames[t] || g,
      stations: 0,
      hidden: 0,
      image: '',
      enabled: true,
      custom: true,
    });
  }

  const pos = branchPositions(list);
  found.forEach((b, i) => { b._d = i; });
  found.sort((a, b) => {
    const pa = pos.has(a.path) ? pos.get(a.path) : 1e9 + a._d;
    const pb = pos.has(b.path) ? pos.get(b.path) : 1e9 + b._d;
    return pa - pb;
  });
  return found;
}

/** Cataloghi da esporre nel manifest: solo dati gia' in cache, mai rete. */
async function buildCatalogs(config) {
  const out = [];
  for (const l of config.lists.filter((x) => x.options.enabled && x.options.inCatalog)) {
    let entry = cache.getEntry(l.id);
    if (!entry && l.kind === 'personal') {
      // albero sintetico: costruirlo non tocca la rete verso l'esterno
      try { entry = await entryFor(config, l); } catch (_) { entry = null; }
    } else if (entry && (l.options.personalEntries || []).length) {
      try { entry = await entryFor(config, l); } catch (_) { /* resta l'albero semplice */ }
    }
    const options = entry
      ? buildBranches(entry, l).filter((b) => b.enabled).map((b) => b.displayName).slice(0, 300)
      : [];
    out.push({
      id: catalogId(l.id),
      type: TYPE,
      name: catalogDisplayName(l),
      extra: [
        { name: 'genre', isRequired: false, options, optionsLimit: 300 },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    });
  }
  return out;
}

/**
 * Contenuto di un catalogo: i CANALI della lista, paginati e filtrabili
 * per genere (= gruppo) e per ricerca, come da protocollo Stremio.
 */
async function buildCatalog(config, catId, extras = {}) {
  const list = config.lists.find((l) => catalogId(l.id) === catId);
  if (!list) return null;

  const { rows } = await listRows(config, list);
  const genre = extras.genre || '';
  const needle = String(extras.search || '').trim().toLowerCase();

  let filtered = rows;
  if (genre) filtered = filtered.filter((r) => r.genre === genre);
  if (needle) filtered = filtered.filter((r) => r.name.toLowerCase().includes(needle));

  const skip = Math.max(0, Number(extras.skip) || 0);
  const page = filtered.slice(skip, skip + PAGE_SIZE);

  return {
    metas: page.map((r) => ({
      id: metaId(list.id, r.path, r.idx),
      type: TYPE,
      name: r.name,
      // logo proprio del canale, altrimenti l'icona del gruppo come poster
      poster: r.logo || r.groupLogo || undefined,
      posterShape: 'square',
      genre: [r.genre],
      description: r.group,
    })),
  };
}

async function buildMeta(config, id) {
  const parsed = parseMetaId(id);
  if (!parsed) return null;
  const list = config.lists.find((l) => l.id === parsed.listId);
  if (!list) return null;

  const entry = await entryFor(config, list);
  const node = findByPath(entry.tree, parsed.path);
  if (!node) return null;

  // id-canale: meta del singolo canale con logo e genere (= nome del gruppo)
  if (parsed.stationIdx != null) {
    const st = (node.stations || [])[parsed.stationIdx];
    if (!st) return null;
    const ckey = `${parsed.path}::${st.name}`;
    if ((list.options.disabledChannels || []).includes(ckey)) return null; // canale escluso
    if ((list.options.deletedChannels || []).includes(ckey)) return null; // canale eliminato
    if ((list.options.deletedBranches || []).includes(parsed.path)) return null; // ramo eliminato dalla configurazione
    if ((list.options.deletedChannels || []).includes(ckey)) return null; // canale eliminato
    if ((list.options.deletedBranches || []).includes(parsed.path)) return null; // ramo eliminato
    const names = pathNames(entry.tree, parsed.path);
    const genre = (list.options.renames || {})[parsed.path] || node.name;
    const url = normalizeStreamUrl(st.url, list.options);
    return {
      meta: {
        id,
        type: TYPE,
        name: (list.options.channelRenames || {})[ckey] || st.name,
        poster: st.image || node.image || undefined,
        background: st.image || node.image || undefined,
        posterShape: 'square',
        genre: [genre],
        description: [
          names.join(' › '),
          url ? `Protocollo: ${protocolBadge(url)}` : 'Stream escluso dai filtri protocolli',
          `Lista: ${listPrefix(list)}`,
        ].filter(Boolean).join('\n'),
      },
    };
  }

  // retrocompat: id-gruppo delle build precedenti
  return {
    meta: {
      id,
      type: TYPE,
      name: node.name,
      poster: node.image || undefined,
      background: node.image || undefined,
      posterShape: 'landscape',
      description: [
        node.info,
        `${node.counts.stations} stream totali`,
        `Lista: ${listPrefix(list)}`,
        node.sourceUrl ? `Sorgente: ${node.sourceUrl}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      genres: (node.m3uGroups || []).slice(0, 12),
    },
  };
}

async function buildStreams(config, id) {
  const parsed = parseMetaId(id);
  if (!parsed) return null;
  const list = config.lists.find((l) => l.id === parsed.listId);
  if (!list) return null;

  const entry = await entryFor(config, list);
  const node = findByPath(entry.tree, parsed.path);
  if (!node) return null;

  const branchName = (list.options.renames || {})[parsed.path] || node.name;
  const toStream = (st) => {
    const ckey = `${parsed.path}::${st.name}`;
    if ((list.options.disabledChannels || []).includes(ckey)) return null; // canale escluso
    if ((list.options.deletedChannels || []).includes(ckey)) return null; // canale eliminato
    if ((list.options.deletedBranches || []).includes(parsed.path)) return null; // ramo eliminato
    const raw = normalizeStreamUrl(st.url, list.options);
    if (!raw) return null;
    const badge = protocolBadge(raw);
    const shown = (list.options.channelRenames || {})[ckey] || st.name;
    return {
      name: `${config.settings.addonName}\n${branchName}`,
      title: `[${badge}] ${shown}`,
      url: proxyStreamUrl(raw, list),
      behaviorHints: badge === 'ACE' ? { notWebReady: true } : undefined,
    };
  };

  // id-canale: un solo stream
  if (parsed.stationIdx != null) {
    const st = (node.stations || [])[parsed.stationIdx];
    if (!st) return null;
    const one = toStream(st);
    return { streams: one ? [one] : [] };
  }

  // retrocompat: tutti gli stream del gruppo
  const seen = new Set();
  const streams = [];
  for (const s of node.stations || []) {
    const st = toStream(s);
    if (!st) continue;
    const key = st.url.toLowerCase();
    if (list.options.dedupe !== false && seen.has(key)) continue;
    seen.add(key);
    streams.push(st);
  }
  return { streams };
}

module.exports = {
  TYPE,
  ID_PREFIX,
  JOINER,
  collectChannels,
  buildPlaylist,
  buildCatalogs,
  buildBranches,
  buildCatalog,
  buildMeta,
  buildStreams,
  buildPersonalTree,
  entryFor,
  catalogId,
  catalogDisplayName,
  epgHeader,
  proxyStreamUrl,
  metaId,
  parseMetaId,
  encodePath,
  decodePath,
  listPrefix,
};
