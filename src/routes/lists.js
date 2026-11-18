'use strict';

/**
 * Lists API: create, inspect, refresh and customize a source list.
 *
 * Mounted at /api/lists. All endpoints are admin-protected. Downloads run in
 * the background through the refresher, so HTTP requests never block on a slow
 * panel; the UI polls /:id/state.
 */

const express = require('express');
const store = require('../config');
const cache = require('../cache');
const playlist = require('../playlist');
const history = require('../history');
const xtream = require('../xtream');
const { findByPath } = require('../wiseplay');
const { sanitizeListUrl } = require('../http/request');
const { buildListM3U } = require('../services/listM3u');

module.exports = function createListsRouter({ admin, refresher }) {
  const router = express.Router();

router.get('/:id/preview.m3u', admin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).send('list not found');
  try {
    const m = await buildListM3U(store.loadConfig(), list, (req.query.path || '').toString());
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.send(m);
  } catch (err) {
    res.status(502).send(`# error: ${err.message}`);
  }
});

router.post('/', admin, (req, res) => {
  try {
    const url = sanitizeListUrl(req.body && req.body.url);
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid URL (use http/https)' });
    const name = (req.body && req.body.name ? String(req.body.name) : '').trim();

    const cfg = store.loadConfig();
    if (cfg.lists.some((l) => l.url === url)) {
      return res.status(409).json({ error: 'list already present' });
    }

    const list = store.newList(url, name);
    const withList = store.saveConfig(
      { ...cfg, lists: [...cfg.lists, list] },
      { reason: 'list added', listId: list.id, listName: list.name || list.url }
    );
    const saved = withList.lists[withList.lists.length - 1];

    refresher.startRefresh(saved.id, true);
    res.json({ list: store.findList(saved.id), state: store.findList(saved.id).state });
  } catch (err) {
    console.error('[lists]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Current state of a list (UI polling during download). */
router.get('/:id/state', admin, (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  refresher.reconcileListState(list.id);
  res.json(store.findList(list.id).state || {});
});

/** Xtream account info (expiry/status) from the panel's /player_api.php.
 *  Cached in the config for 30 minutes: the page stays instant on open. */
router.get('/:id/xtream', admin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  const url = sanitizeListUrl(list.url || '');
  if (!xtream.xtreamInfo(url)) return res.json({ ok: false, xtream: false });

  const cached = list.state && list.state.xtream;
  const force = req.query.refresh === '1';
  if (cached && cached.fetchedAt && !force) {
    const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
    if (ageMs >= 0 && ageMs < 30 * 60 * 1000) return res.json({ ok: true, ...cached, cached: true });
  }

  const r = await xtream.fetchPanelInfo(url, list.options.userAgent || '');
  if (!r.ok) {
    // no fresh data: keep the old ones (better old than nothing)
    if (cached) return res.json({ ok: true, ...cached, cached: true, stale: true, fetchError: r.reason });
    return res.json({ ok: false, xtream: true, error: r.reason });
  }
  store.updateListState(list.id, { xtream: r });
  res.json({ ok: true, ...r, cached: false });
});

router.delete('/:id', admin, (req, res) => {
  const cfg = store.loadConfig();
  const next = cfg.lists.filter((l) => l.id !== req.params.id);
  if (next.length === cfg.lists.length) return res.status(404).json({ error: 'list not found' });
  cache.invalidate(req.params.id);
  const gone = cfg.lists.find((l) => l.id === req.params.id);
  const listName = gone ? gone.name || gone.url : '';
  // the restore point for undo is the state *before* deletion
  const cp = history.ensureCheckpoint(cfg, {
    reason: 'before deleting a list',
    listId: req.params.id,
    listName,
  });
  store.saveConfig(
    { ...cfg, lists: next },
    { reason: 'list deleted', listId: req.params.id, listName }
  );
  res.json({ ok: true, undo: cp ? { id: cp.id, listIds: [req.params.id] } : null });
});

/** Reloads a list's tree in the background. */
router.post('/:id/refresh', admin, (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  refresher.startRefresh(list.id, true);
  res.json({ ok: true, state: store.findList(list.id).state });
});

/** Channel name suggestions for the "add channel" field: branches of the same
 *  list (except the current one) + other lists already cached (never network). */
router.get('/:id/suggest', admin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  const cur = String(req.query.path || '');
  const cfg = store.loadConfig();
  const CAP = 3000;
  const names = new Set();
  const pushTree = (tree, opts, skipPath) => {
    const ren = opts.channelRenames || {};
    const dis = new Set(opts.disabledChannels || []);
    const del = new Set(opts.deletedChannels || []);
    const delB = new Set(opts.deletedBranches || []);
    const walk = (node) => {
      for (const c of node.children || []) {
        if (delB.has(c.path)) continue;
        if (!(skipPath && c.path === skipPath)) {
          for (const st of c.stations || []) {
            const k = `${c.path}::${st.name}`;
            if (!dis.has(k) && !del.has(k)) names.add(ren[k] || st.name);
            if (names.size >= CAP) return;
          }
        }
        walk(c);
        if (names.size >= CAP) return;
      }
    };
    walk(tree);
  };
  try {
    const e = await playlist.entryFor(cfg, list);
    if (e && e.tree) pushTree(e.tree, list.options, cur);
  } catch (_) { /* tree unavailable */ }
  for (const l of cfg.lists) {
    if (l.id === list.id || names.size >= CAP) continue;
    const e = cache.getEntry(l.id); // cache only: manifest/page stay instant
    if (e && e.tree) pushTree(e.tree, l.options, null);
  }
  res.json({ names: [...names] });
});

/** Adds a channel to a branch: a move within the same list, or
 *  nesting from another list (which loses it in its source section). */
router.post('/:id/addchannel', admin, async (req, res) => {
  const cfg = store.loadConfig();
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  const path = String((req.body || {}).path || '');
  const val = String((req.body || {}).name || '').trim();
  const home = String((req.body || {}).home || '');
  const fromList = String((req.body || {}).fromList || '');
  if (!path || !val) return res.status(400).json({ error: 'path and name are required' });

  const findIn = (tree, opts, skipPath) => {
    const ren = opts.channelRenames || {};
    const dis = new Set(opts.disabledChannels || []);
    const del = new Set(opts.deletedChannels || []);
    const delB = new Set(opts.deletedBranches || []);
    let hit = null;
    const walk = (node) => {
      for (const c of node.children || []) {
        if (hit) return;
        if (delB.has(c.path)) continue;
        if (!(skipPath && c.path === skipPath)) {
          for (const st of c.stations || []) {
            const k = `${c.path}::${st.name}`;
            if (dis.has(k) || del.has(k)) continue;
            if ((ren[k] || st.name) === val || st.name === val) { hit = { home: c.path, name: st.name }; return; }
          }
        }
        walk(c);
        if (hit) return;
      }
    };
    walk(tree);
    return hit;
  };
  const findAt = (tree, opts, p) => {
    const ren = opts.channelRenames || {};
    const dis = new Set(opts.disabledChannels || []);
    const del = new Set(opts.deletedChannels || []);
    const n = p ? findByPath(tree, p) : null;
    if (!n) return null;
    for (const st of n.stations || []) {
      const k = `${p}::${st.name}`;
      if (dis.has(k) || del.has(k)) continue;
      if (st.name === val || (ren[k] || st.name) === val) return { home: p, name: st.name };
    }
    return null;
  };

  const undoFor = (ids, reason) => {
    const cp = history.ensureCheckpoint(cfg, { reason, listId: list.id, listName: list.name || list.url });
    return cp ? { id: cp.id, listIds: ids } : null;
  };

  // 1) same list: becomes a move (the source loses it)
  if (!fromList || fromList === list.id) {
    try {
      const e = await playlist.entryFor(cfg, list);
      // previously deleted channel: re-adding it restores it
      const delKey = home ? `${home}::${val}` : '';
      if (delKey && (list.options.deletedChannels || []).includes(delKey)) {
        const undo = undoFor([list.id], 'before adding a channel');
        list.options.deletedChannels = list.options.deletedChannels.filter((k) => k !== delKey);
        if (path !== home) {
          list.options.channelMoves = list.options.channelMoves || {};
          list.options.channelMoves[delKey] = path;
        }
        store.saveConfig(cfg, { reason: 'channel added', listId: list.id, listName: list.name || list.url });
        return res.json({ ok: true, from: list.name || list.id, revived: true, undo });
      }
      const hit = e && e.tree
        ? (home ? findAt(e.tree, list.options, home) : null) || findIn(e.tree, list.options, path)
        : null;
      if (hit) {
        const undo = undoFor([list.id], 'before adding a channel');
        list.options.channelMoves = list.options.channelMoves || {};
        list.options.channelMoves[`${hit.home}::${hit.name}`] = path;
        store.saveConfig(cfg, { reason: 'channel moved', listId: list.id, listName: list.name || list.url });
        return res.json({ ok: true, from: list.name || list.id, undo });
      }
    } catch (_) { /* tree unavailable: try the other lists */ }
  }

  // 2) another list: nest in the branch + disable in the source
  const ordered = cfg.lists.slice();
  if (fromList) {
    const i = ordered.findIndex((l) => l.id === fromList);
    if (i > 0) ordered.unshift(ordered.splice(i, 1)[0]);
  }
  for (const l of ordered) {
    if (l.id === list.id) continue;
    let e = null;
    try { e = await playlist.entryFor(cfg, l); } catch (_) { continue; }
    if (!e || !e.tree) continue;
    const hit = findIn(e.tree, l.options, null);
    if (!hit) continue;
    const undo = undoFor([list.id, l.id], 'before importing a channel');
    list.options.personalEntries = list.options.personalEntries || [];
    list.options.personalEntries.push({
      id: 'e' + Math.random().toString(16).slice(2, 8),
      src: `${l.id}::${hit.home}::${hit.name}`,
      dst: path,
    });
    l.options.disabledChannels = l.options.disabledChannels || [];
    if (!l.options.disabledChannels.includes(`${hit.home}::${hit.name}`)) {
      l.options.disabledChannels.push(`${hit.home}::${hit.name}`);
    }
    store.saveConfig(cfg, { reason: 'channel imported', listId: list.id, listName: list.name || list.url });
    return res.json({ ok: true, from: l.name || l.id, undo });
  }
  res.status(404).json({ error: 'channel not found in any list' });
});

/** Moves ALL channels of a playlist into another (dragging one playlist
 *  onto another). Same list = move; different lists = nest in the
 *  destination and disable in the source. */
router.post('/:id/mergebranch', admin, async (req, res) => {
  const cfg = store.loadConfig();
  const target = store.findList(req.params.id);
  if (!target) return res.status(404).json({ error: 'list not found' });
  const fromList = String((req.body || {}).fromList || target.id);
  const from = String((req.body || {}).from || '');
  const to = String((req.body || {}).to || '');
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (from === to && fromList === target.id) return res.status(400).json({ error: 'same playlist' });
  const src = cfg.lists.find((l) => l.id === fromList);
  if (!src) return res.status(404).json({ error: 'source list not found' });
  const oT = target.options;
  const undoIds = fromList === target.id ? [target.id] : [target.id, src.id];
  const cp = history.ensureCheckpoint(cfg, {
    reason: 'before merging playlists',
    listId: target.id,
    listName: target.name || target.url,
  });
  const undo = cp ? { id: cp.id, listIds: undoIds } : null;

  // custom group as source: only within the same list (redirects moves)
  if (from.startsWith('@')) {
    if (fromList !== target.id) return res.status(400).json({ error: 'custom group: it can only be moved within the same list' });
    let n = 0;
    for (const [k, v] of Object.entries(oT.channelMoves || {})) {
      if (v === from) { oT.channelMoves[k] = to; n++; }
    }
    store.saveConfig(cfg, { reason: 'playlist merge', listId: target.id, listName: target.name || target.url });
    return res.json({ ok: true, moved: n, from: from.slice(1), undo });
  }

  let e = null;
  try { e = await playlist.entryFor(cfg, src); } catch (_) { /* not downloaded */ }
  if (!e || !e.tree) return res.status(409).json({ error: 'source list not downloaded yet' });
  const node = findByPath(e.tree, from);
  if (!node) return res.status(404).json({ error: 'source playlist not found' });
  const oS = src.options;
  const del = new Set(oS.deletedChannels || []);
  const stations = (node.stations || []).filter((st) => !del.has(`${from}::${st.name}`));
  if (!stations.length) return res.json({ ok: true, moved: 0, from: src.name || src.id });

  if (fromList === target.id) {
    oT.channelMoves = oT.channelMoves || {};
    for (const st of stations) oT.channelMoves[`${from}::${st.name}`] = to;
    store.saveConfig(cfg, { reason: 'playlist merge', listId: target.id, listName: target.name || target.url });
    return res.json({ ok: true, moved: stations.length, from: src.name || src.id, undo });
  }

  if (to.startsWith('@')) return res.status(400).json({ error: 'across different lists the destination must be an existing playlist' });
  oT.personalEntries = oT.personalEntries || [];
  let n = 0;
  for (const st of stations) {
    const s0 = `${src.id}::${from}::${st.name}`;
    if (oT.personalEntries.some((x) => x.src === s0 && (x.dst || '') === to)) continue;
    oT.personalEntries.push({ id: 'e' + Math.random().toString(16).slice(2, 8), src: s0, dst: to });
    n++;
  }
  oS.disabledChannels = oS.disabledChannels || [];
  for (const st of stations) {
    const k = `${from}::${st.name}`;
    if (!oS.disabledChannels.includes(k)) oS.disabledChannels.push(k);
  }
  store.saveConfig(cfg, { reason: 'playlist merge', listId: target.id, listName: target.name || target.url });
  res.json({ ok: true, moved: n, from: src.name || src.id, undo });
});

/** Removes from the list the items imported from other lists (merges of
 *  external playlists, those with `dst`) and re-enables the channels that had
 *  been disabled in the source list. Native playlists are not touched.
 *  Returns the number of removed items. */
function dropExternalImports(cfg, list) {
  const o = list.options;
  const entries = Array.isArray(o.personalEntries) ? o.personalEntries : [];
  const imports = entries.filter((e) => e && e.dst && e.src);
  if (!imports.length) return { removed: 0, srcIds: [] };
  o.personalEntries = entries.filter((e) => !(e && e.dst && e.src));

  // what remains imported after cleanup (to avoid re-enabling channels still in use)
  const stillImported = new Set();
  for (const l of cfg.lists) {
    for (const e of l.options.personalEntries || []) {
      if (e && e.src) stillImported.add(String(e.src));
    }
  }
  const bySrc = new Map();
  for (const e of imports) {
    const src = cfg.lists.find((l) => String(e.src).startsWith(`${l.id}::`));
    if (!src) continue;
    if (!bySrc.has(src.id)) bySrc.set(src.id, { list: src, keys: new Set() });
    bySrc.get(src.id).keys.add(String(e.src).slice(src.id.length + 2));
  }
  for (const { list: src, keys } of bySrc.values()) {
    const os = src.options;
    os.disabledChannels = (os.disabledChannels || []).filter((k) =>
      !keys.has(k) || stillImported.has(`${src.id}::${k}`)
    );
  }
  return { removed: imports.length, srcIds: [...bySrc.keys()] };
}

/** Returns the list to its state when added: resets all
 *  customizations (renames, exclusions, order, merges, moves,
 *  trash) and re-downloads the list from its URL. */
router.post('/:id/restoreorigin', admin, (req, res) => {
  const cfg = store.loadConfig();
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  const cp = history.ensureCheckpoint(cfg, {
    reason: 'before restoring the list',
    listId: list.id,
    listName: list.name || list.url,
  });
  // re-enables channels imported from other lists before resetting options
  const imp = dropExternalImports(cfg, list);
  const personal = list.kind === 'personal';
  list.options = store.defaultListOptions();
  if (personal) list.options.inCatalog = false; // like a newly created personal list
  list.state = { status: 'idle', error: '', fatal: false, fetchedAt: '', stats: null, kind: '' };
  store.saveConfig(cfg, { reason: 'list restored', listId: list.id, listName: list.name || list.url });
  cache.invalidate(list.id);            // no stale tree/snapshot
  playlist.clearRows(list.id);
  refresher.startRefresh(list.id, true);          // riscarica da zero
  res.json({
    ok: true,
    imports: imp.removed,
    lists: [list.id, ...imp.srcIds],
    undo: cp ? { id: cp.id, listIds: [list.id, ...imp.srcIds] } : null,
  });
});

/** Channels of a single branch, for management from the configuration page. */
router.get('/:id/channels', admin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  let entry = null;
  try { entry = await playlist.entryFor(store.loadConfig(), list); } catch (_) { entry = cache.getEntry(list.id); }
  if (!entry || !entry.tree) return res.status(409).json({ error: 'list not downloaded yet' });
  const path = String(req.query.path || '');

  const renames = list.options.channelRenames || {};
  const branchRenames = list.options.renames || {};
  const dis = new Set(list.options.disabledChannels || []);
  const del = new Set(list.options.deletedChannels || []);
  const delB = new Set(list.options.deletedBranches || []);
  const moves = list.options.channelMoves || {};

  // channels coming from other branches (or "@Name" custom groups)
  const incoming = new Map();
  const movedOut = new Set();
  (function scan(node) {
    for (const c of node.children || []) {
      for (const st of c.stations || []) {
        const key = `${c.path}::${st.name}`;
        if (dis.has(key) || del.has(key)) continue;
        const t = moves[key];
        if (t && t !== c.path) {
          movedOut.add(key);
          if (!incoming.has(t)) incoming.set(t, []);
          incoming.get(t).push({ st, srcPath: c.path, srcName: branchRenames[c.path] || c.name });
        }
      }
      scan(c);
    }
  })(entry.tree);

  const isCustom = path.startsWith('@');
  if (!isCustom && delB.has(path)) return res.status(404).json({ error: 'branch deleted' });
  const node = isCustom ? null : findByPath(entry.tree, path);
  if (!isCustom && !node) return res.status(404).json({ error: 'branch not found' });

  const chans = [];
  if (!isCustom) {
    (node.stations || []).forEach((st) => {
      const key = `${path}::${st.name}`;
      if (del.has(key)) return; // deleted: no longer visible
      if (movedOut.has(key)) return; // lives in another branch/group
      chans.push({
        name: st.name,
        shown: renames[key] || st.name,
        enabled: !dis.has(key),
        home: path,
        cur: path,
        from: '',
      });
    });
  }
  for (const inc of incoming.get(path) || []) {
    const key = `${inc.srcPath}::${inc.st.name}`;
    chans.push({
      name: inc.st.name,
      shown: renames[key] || inc.st.name,
      enabled: !dis.has(key),
      home: inc.srcPath,
      cur: path,
      from: inc.srcName,
    });
  }

  const orderArr = (list.options.channelOrder || {})[path] || [];
  const posMap = new Map(orderArr.map((n, i) => [n, i]));
  chans.sort((a, b) => {
    const pa = posMap.has(a.name) ? posMap.get(a.name) : 1e9;
    const pb = posMap.has(b.name) ? posMap.get(b.name) : 1e9;
    return pa - pb; // stable: items not in order keep their natural order
  });
  res.json({ path, count: chans.length, channels: chans });
});

/** List branches (the individual playlists) for the configuration UI. */
router.get('/:id/tree', admin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  refresher.reconcileListState(list.id);
  let entry = null;
  try { entry = await playlist.entryFor(store.loadConfig(), list); } catch (_) { entry = cache.getEntry(list.id); }
  if (!entry || !entry.tree) {
    // never downloaded (or empty cache): starts a background download
    refresher.startRefresh(list.id, false);
    return res.status(202).json({ fetching: true, state: store.findList(list.id).state });
  }
  res.json({
    meta: entry.tree.meta,
    fetchedAt: entry.fetchedAt,
    error: entry.error || '',
    branches: playlist.buildBranches(entry, list),
  });
});

/** Quick test of a URL without saving it. */

  return router;
};
