'use strict';

/**
 * Builds the final playlist (M3U) and the Stremio/Nuvio catalogs
 * from the configured WisePlay lists.
 */

const { flattenStations, findByPath, pathNames } = require('./wiseplay');
const { makeBranchSelector, matchesKeywords } = require('./selection');
const { normalizeStreamUrl, protocolBadge } = require('./protocols');
const { buildM3U } = require('./m3u');
const cache = require('./cache');
const epg = require('./epg');
const { effectiveRefreshMinutes } = require('./config');

/**
 * If the list has EasyProxy configured, rewrites the stream URL as
 * `BASE/proxy/manifest.m3u8?url=...`: EasyProxy will download the stream
 * (with its DNS/WARP/extractors) and serve it to the client. Useful for
 * "(dns)" lists that the client cannot resolve. acestream:// links stay intact:
 * EasyProxy cannot handle them.
 */
function proxyStreamUrl(url, list) {
  const base = ((list.options && list.options.easyProxy) || '').replace(/\/+$/, '');
  if (!base || !url || !/^https?:\/\//i.test(url)) return url;
  const q = [`url=${encodeURIComponent(url)}`];
  if (list.options.easyProxyPassword) q.push(`api_password=${encodeURIComponent(list.options.easyProxyPassword)}`);
  if (list.options.easyProxyParams) q.push(list.options.easyProxyParams);
  return `${base}/proxy/manifest.m3u8?${q.join('&')}`;
}
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
 * Collects the channels of all enabled lists.
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

    // rows are memoized in listRows: playlist, catalogs and channels
    // share the same flatten instead of rebuilding it every time
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
        // personal lists pull from the same sources: global dedupe would
        // erase them; deduplicate only inside personal lists
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
        tvgId: ch.tvgId || '',
        tvgName: ch.tvgName || '',
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

/* ----------------------- composite (personal) lists ----------------------- */

/** Reads "listId::path::name" ('*' = whole playlist). */
function parsePersonalSrc(src) {
  const i1 = String(src).indexOf('::');
  const i2 = String(src).indexOf('::', i1 + 2);
  if (i1 < 0 || i2 < 0) return null;
  return { listId: src.slice(0, i1), path: src.slice(i1 + 2, i2), name: src.slice(i2 + 2) };
}

/** Synthetic branches from personalEntries (used by personal lists and, at
 *  the end, by normal lists too). Sources can themselves be personal
 *  lists; 'chain' prevents cycles. */
async function synthChildren(config, list, entries, basePath, chain = []) {
  const selfId = list.id;
  const del = new Set(list.options.deletedChannels || []);
  const delB = new Set(list.options.deletedBranches || []);
  const children = [];
  const into = new Map(); // dst (path of an existing branch) -> stations to nest
  let nStations = 0;
  let slots = 0; // positional counter: deleted slots stay reserved
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
      // channel nested INSIDE an existing branch of the destination list
      if (p.name === '*') continue;
      if (delB.has(e.dst)) continue; // deleted destination branch
      const st = (node.stations || []).find((x) => x.name === p.name);
      if (!st) continue;
      if (del.has(`${e.dst}::${st.name}`)) continue;
      if (!into.has(e.dst)) into.set(e.dst, []);
      into.get(e.dst).push({ ...st });
      nStations += 1;
      continue;
    }
    // positional path (as in real lists): findByPath navigates by index.
    // The slot is consumed even if the branch/channel was deleted, so
    // positional keys (renames, disables) stay stable.
    const bpath = String(basePath + slots);
    // The slot is always consumed (and the child always inserted) so child
    // indexes match positional paths: findByPath navigates by index.
    // Deleted branches/channels stay in the tree but are filtered everywhere
    // through deletedBranches/deletedChannels; the trash reads them from there.
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

/** Nests the "into" stations in existing branches (clone so the cache is untouched).
 *  Paths can point to nested branches (e.g. "0.1.0"): the search is recursive. */
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

/** Synthetic tree of a personal list. */
async function buildPersonalTree(config, list) {
  const s = await synthChildren(config, list, list.options.personalEntries, 0);
  const children = applyInto(s.children, s.into);
  const delB = new Set(list.options.deletedBranches || []);
  const nStations = children.reduce((n, c) => (delB.has(c.path) ? n : n + (c.stations || []).length), 0);
  const name = list.name || 'Personal list';
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

/** Tree entry for a list: synthetic for personal lists; for normal lists it
 *  appends the synthetic branches (content imported from other lists). */
async function entryFor(config, list, force = false, chain = []) {
  if (list.kind === 'personal') {
    return cache.getTree({ id: list.id, url: '', builder: () => buildPersonalTree(config, list) });
  }
  const ttl = effectiveRefreshMinutes(list, config.settings);
  // A refresh started by the scheduler/manual button is already in flight:
  // serve the existing copy without starting a second download.
  const alreadyRefreshing = !!(list.state && list.state.status === 'fetching');
  const entry = await cache.getTree({
    id: list.id,
    url: list.url,
    // 0 = manual only: never refresh just because a client asked; an explicit
    // /refresh (or the first download) still goes through the refresher.
    ttlMinutes: alreadyRefreshing || ttl <= 0 ? Infinity : ttl,
    staleWhileRevalidate: !alreadyRefreshing,
    maxDepth: config.settings.maxDepth,
    userAgent: list.options.userAgent || '',
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

/** EPG header for the generated playlist: manual setting + EPG inherited
 *  from m3u/m3u_plus sources. Writes both common forms
 *  (x-tvg-url for Kodi/Xtream, url-tvg for TiviMate and IPTV apps). */
function epgHeader(config, inherited = []) {
  const all = [];
  const add = (value) => {
    const url = epg.cleanUrl(value);
    if (url && !all.includes(url)) all.push(url);
  };
  add(config.settings.epgUrl);
  for (const u of inherited) add(u);
  if (!all.length) return {};
  const joined = all.join(',');
  return { 'x-tvg-url': joined, 'url-tvg': joined };
}

async function buildPlaylist(config, opts = {}) {
  const { channels, lists, errors, epgUrls } = await collectChannels(config, opts);
  // opts.rewrite (stream diagnostics): final channel URL rewrite before the M3U
  const out = typeof opts.rewrite === 'function' ? channels.map((c) => opts.rewrite(c) || c) : channels;
  const m3u = buildM3U(out, {
    name: `${config.settings.addonName} (${out.length} channels)`,
    header: epgHeader(config, epgUrls),
  });
  return { m3u, channels, lists, errors, epgUrls };
}

/* ---------------------------- cataloghi ---------------------------- */

const TYPE = 'tv';

// Stable prefix for all meta-ids: the manifest declares it in idPrefixes,
// so Stremio/Nuvio route /meta and /stream requests here.
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
  // Native EPG programme ids are `<channel id>:epg:<iso>`; playback and
  // detail always belong to the channel, never to the single programme.
  const epgSuffix = s.indexOf(':epg:');
  if (epgSuffix >= 0) s = s.slice(0, epgSuffix);
  if (s.startsWith(ID_PREFIX)) s = s.slice(ID_PREFIX.length);
  const idx = s.indexOf(':');
  if (idx < 0) return null;
  const listId = s.slice(0, idx);
  let rest = s.slice(idx + 1);
  // channel ids have a ":<station index>" suffix (backward compatible: without = group)
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

/* Catalogs show CHANNELS; groups become genres (dropdown).
 * Rows are memoized per list and recomputed only when the selection/tree
 * changes, so pagination and filters stay fast. */

const PAGE_SIZE = 100;
const rowsMemo = new Map();

/** RAM farm: this list's parsed tree is evicted from the cache — memoized rows
 *  share strings with the tree, so free them too (they are rebuilt on next use). */
function clearRows(listId) { rowsMemo.delete(listId); }

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

/** Position of each branch according to the configured order. */
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

  // respect branch order and, within each branch, the channel order chosen
  // on the configuration page (stable keys: path and name, so customizations
  // survive URL changes)
  // the order follows the actual destination (gpath): moved channels live in
  // the branch/custom group chosen on the configuration page
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
    // EPGs declared by the m3u/m3u_plus source (old snapshots: missing)
    epgUrls: (entry.tree && entry.tree.meta && entry.tree.meta.epgUrls) || [],
  };
  rowsMemo.set(list.id, { fp, value });
  return value;
}

/**
 * List branches: groups that directly contain channels (the "individual
 * playlists"), renamed and ordered as configured.
 * A light tree walk, no flatten and no network: the manifest must stay
 * instant even with 100k+ channels.
 */
function buildBranches(entry, list) {
  if (!entry || !entry.tree) return [];
  const selector = makeBranchSelector(list.options.disabledPaths);
  const renames = list.options.renames || {};
  // how many channels of each branch were excluded from the configuration page
  const disByBranch = new Map();
  for (const key of list.options.disabledChannels || []) {
    const i = key.lastIndexOf('::');
    if (i < 0) continue;
    const p = key.slice(0, i);
    disByBranch.set(p, (disByBranch.get(p) || 0) + 1);
  }
  // channels/branches deleted from the page: they disappear completely
  const delByBranch = new Map();
  for (const key of list.options.deletedChannels || []) {
    const i = key.lastIndexOf('::');
    if (i < 0) continue;
    const p = key.slice(0, i);
    delByBranch.set(p, (delByBranch.get(p) || 0) + 1);
  }
  const delBranches = new Set(list.options.deletedBranches || []);
  // channels moved from the configuration page: counts per destination
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

  // personal groups ("@Name") created by moving channels from the page
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
  // custom playlists/branches created empty from the page ("+ new playlist")
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

/** Catalogs to expose in the manifest: cached data only, never network. */
async function buildCatalogs(config) {
  const out = [];
  const withEpg = epg.hasEpg(config);
  for (const l of config.lists.filter((x) => x.options.enabled && x.options.inCatalog)) {
    let entry = cache.getEntry(l.id);
    if (!entry && l.kind === 'personal') {
      // synthetic tree: building it does not touch the external network
      try { entry = await entryFor(config, l); } catch (_) { entry = null; }
    } else if (entry && (l.options.personalEntries || []).length) {
      try { entry = await entryFor(config, l); } catch (_) { /* keep the simple tree */ }
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
        ...(withEpg ? [{ name: 'date', isRequired: false }] : []),
      ],
    });
  }
  return out;
}

/**
 * Catalog content: the list's CHANNELS, paginated and filterable by
 * genre (= group) and search, as per the Stremio protocol.
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

  const hasEpg = epg.hasEpg(config);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(extras.date || '')) ? String(extras.date) : '';
  // The channel list must stay fast: use only a warm guide. A dated guide
  // request or a search (where the user expects Now/Next) may wait for it.
  let guide = hasEpg ? epg.peekGuide(config) : null;
  if (hasEpg && !guide) {
    if (date || extras.search) guide = await epg.getGuide(config);
    else epg.warmGuide(config);
  }

  const metaOf = (r) => {
    const epgLine = guide ? epg.descriptionLine(guide, r) : '';
    return {
      id: metaId(list.id, r.path, r.idx),
      type: TYPE,
      name: r.name,
      // the channel's own logo, otherwise the group icon as poster
      poster: r.logo || r.groupLogo || undefined,
      // TV channel logos are horizontal: 16:9 card ("landscape"),
      // no more side cropping in clients (Nuvio/Stremio) that derive
      // the card geometry from posterShape
      posterShape: 'landscape',
      genre: [r.genre],
      description: [epgLine, r.group].filter(Boolean).join('\n'),
      // Nuvio/Stremio use this to keep the channel itself as playback target
      behaviorHints: { isLive: true },
    };
  };

  if (date) {
    const start = Date.parse(`${date}T00:00:00.000Z`);
    const end = start + 24 * 60 * 60 * 1000;
    const metasDetailed = page.map((r) => {
      const meta = metaOf(r);
      const videos = guide
        ? epg.programmesBetween(guide, r, start, end).slice(0, 60)
            .map((p) => epg.toVideo(meta.id, p))
        : [];
      if (videos.length) {
        meta.videos = videos;
        meta.behaviorHints = { isLive: true, hasScheduledVideos: true };
      }
      return meta;
    });
    return { metasDetailed };
  }

  return { metas: page.map(metaOf) };
}

async function buildMeta(config, id) {
  const parsed = parseMetaId(id);
  if (!parsed) return null;
  const list = config.lists.find((l) => l.id === parsed.listId);
  if (!list) return null;

  const entry = await entryFor(config, list);
  const node = findByPath(entry.tree, parsed.path);
  if (!node) return null;

  // channel id: single-channel meta with logo and genre (= group name)
  if (parsed.stationIdx != null) {
    const st = (node.stations || [])[parsed.stationIdx];
    if (!st) return null;
    const ckey = `${parsed.path}::${st.name}`;
    if ((list.options.disabledChannels || []).includes(ckey)) return null; // excluded channel
    if ((list.options.deletedChannels || []).includes(ckey)) return null; // channel deleted
    if ((list.options.deletedBranches || []).includes(parsed.path)) return null; // branch deleted from the configuration
    const names = pathNames(entry.tree, parsed.path);
    const genre = (list.options.renames || {})[parsed.path] || node.name;
    const url = normalizeStreamUrl(st.url, list.options);
    const guide = await epg.getGuide(config);
    const now = Date.now();
    const epgLine = guide ? epg.descriptionLine(guide, st, now) : '';
    const videos = guide
      ? epg.programmesBetween(guide, st, now - 2 * 60 * 60 * 1000, now + 12 * 60 * 60 * 1000)
          .slice(0, 20)
          .map((p) => epg.toVideo(id, p, now))
      : [];
    return {
      meta: {
        id,
        type: TYPE,
        name: (list.options.channelRenames || {})[ckey] || st.name,
        poster: st.image || node.image || undefined,
        background: st.image || node.image || undefined,
        // channel detail too: landscape, consistent with the catalog
        posterShape: 'landscape',
        genre: [genre],
        description: [
          epgLine,
          names.join(' › '),
          url ? `Protocol: ${protocolBadge(url)}` : 'Stream excluded by protocol filters',
          `List: ${listPrefix(list)}`,
        ].filter(Boolean).join('\n'),
        behaviorHints: {
          isLive: true,
          ...(videos.length ? { hasScheduledVideos: true } : {}),
        },
        videos: videos.length ? videos : undefined,
      },
    };
  }

  // backward compatibility: group id from previous builds
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
        `${node.counts.stations} total streams`,
        `List: ${listPrefix(list)}`,
        node.sourceUrl ? `Source: ${node.sourceUrl}` : '',
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
    if ((list.options.disabledChannels || []).includes(ckey)) return null; // excluded channel
    if ((list.options.deletedChannels || []).includes(ckey)) return null; // channel deleted
    if ((list.options.deletedBranches || []).includes(parsed.path)) return null; // branch deleted
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

  // channel id: a single stream
  if (parsed.stationIdx != null) {
    const st = (node.stations || [])[parsed.stationIdx];
    if (!st) return null;
    const one = toStream(st);
    return { streams: one ? [one] : [] };
  }

  // backward compatibility: all streams of the group
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
  hasEpg: (config) => epg.hasEpg(config),
  warmEpg: (config) => epg.warmGuide(config),
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
  clearRows,
};
