'use strict';

/**
 * Cache of downloaded WisePlay trees: memory + disk snapshots,
 * with background refresh (stale-while-revalidate).
 *
 * RAM diet (v1.4.5): trees with hundreds of thousands of stations were
 * ALWAYS kept parsed in memory (JSON.parse of whole snapshots = JS objects
 * of a few kB per station): with 3-4 lists the container exceeded 800 MB.
 * Instead, we keep in memory ONLY the gzip buffer of the snapshot (~1/6 of
 * the size) and parse the tree only when actually needed (playlist,
 * catalog, channels, preview). At most WM_HOT_TREES lists stay parsed at a
 * time (LRU): the others are rebuilt on demand at the next use.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildTree, treeForUi } = require('./wiseplay');

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'data', 'cache');
const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024; // above this threshold the snapshot is not written
// how many lists stay PARSED in RAM together (each costs ~3 kB/station);
// the others exist only as gzip in RAM (+ disk snapshot)
const MAX_PARSED = Math.max(1, Number(process.env.WM_HOT_TREES || 1));

// id -> { gz:Buffer|null, parsed:{tree}|null, ui:object|null,
//         fetchedAt:string, refreshing:boolean, promise:Promise|null,
//         error:string, lastUsed:number }
const memory = new Map();
let onEvictRowCb = null; // hook: list flatten rows for submission (playlist.rowsMemo)
let onRefreshCb = null; // hook: keep persisted list state in sync after any refresh

/** Calls `cb` every time a list's parsed tree is evicted (RAM diet). */
function setEvictHook(cb) { onEvictRowCb = typeof cb === 'function' ? cb : null; }

/** Calls `cb` after a successful download triggered by any caller (scheduler,
 *  manual refresh or stale-while-revalidate). */
function setRefreshHook(cb) { onRefreshCb = typeof cb === 'function' ? cb : null; }

function touch(id) {
  const e = memory.get(id);
  if (e) e.lastUsed = Date.now();
  return e;
}

/** Avoids keeping more parsed trees than the allowed maximum (LRU). */
function evictParsedIfNeeded(skipId) {
  const listed = [];
  for (const [id, e] of memory) if (e.parsed && id !== skipId) listed.push([id, e.lastUsed || 0]);
  while (listed.length >= MAX_PARSED) {
    listed.sort((a, b) => a[1] - b[1]);
    const [oldestId] = listed.shift();
    const e = memory.get(oldestId);
    if (!e) continue;
    e.parsed = null; // the GC reclaims the tree: only the gzip stays in RAM
    e.ui = null;
    if (onEvictRowCb) { try { onEvictRowCb(oldestId); } catch (_) { /* hook best-effort */ } }
  }
}

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function snapshotPath(id) {
  return path.join(CACHE_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json.gz`);
}

function saveSnapshot(id, entry) {
  try {
    ensureDir();
    const gz = entry.gz; // compressed once already: no need to redo the work
    if (!gz) return;
    if (gz.length > MAX_SNAPSHOT_BYTES) {
      console.warn(
        `[cache] snapshot of ${id} too large (${(gz.length / 1048576).toFixed(1)} MB compressed): ` +
          'kept in memory only; the list will be downloaded again on restart'
      );
      return;
    }
    fs.writeFileSync(snapshotPath(id), gz);
    console.log(`[cache] snapshot of ${id} saved (${(gz.length / 1048576).toFixed(1)} MB)`);
  } catch (err) {
    console.error('[cache] snapshot not saved:', err.message);
  }
}

/** Background persistence: it must never slow down the caller waiting for the tree. */
function persistAsync(id, entry) {
  setImmediate(() => saveSnapshot(id, entry));
}

function loadSnapshot(id) {
  try {
    const p = snapshotPath(id);
    if (!fs.existsSync(p)) {
      // compatibility with uncompressed snapshots from previous versions
      const legacy = p.replace(/\.gz$/, '');
      if (!fs.existsSync(legacy)) return null;
      const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      return raw && raw.tree ? raw : null;
    }
    const raw = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.tree ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Loads an entry into RAM (at startup: read snapshot, compress, release the parse immediately). */
function ensureEntry(id) {
  let e = memory.get(id);
  if (e) return e;
  memory.set(id, {
    gz: null, parsed: null, ui: null, fetchedAt: '', refreshing: false,
    promise: null, error: '', lastUsed: Date.now(), epgUrls: [],
  });
  const snap = loadSnapshot(id);
  if (snap) {
    // compress once: the gzip stays in RAM (tiny), the parse does NOT
    const raw = JSON.stringify({ fetchedAt: snap.fetchedAt, tree: snap.tree });
    e = memory.get(id);
    e.gz = zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 1 });
    e.parsed = { tree: snap.tree };
    e.fetchedAt = snap.fetchedAt || '';
    e.epgUrls = (snap.tree.meta && snap.tree.meta.epgUrls) || [];
    evictParsedIfNeeded(id); // at boot: at most the last list stays parsed
  }
  return memory.get(id);
}

/**
 * Entry with a PARSED tree ready. Builds the UI lazily.
 * Returns null if the list has never been downloaded.
 * The signature stays the same ({ tree, ui, fetchedAt, refreshing, promise, error }).
 */
function getEntry(id) {
  const e = ensureEntry(id);
  if (!e) return null;
  if (!e.parsed && e.gz) {
    try {
      const snap = JSON.parse(zlib.gunzipSync(e.gz).toString('utf8'));
      e.parsed = snap && snap.tree ? { tree: snap.tree } : null;
      if (snap && snap.fetchedAt) e.fetchedAt = snap.fetchedAt;
    } catch (_) {
      e.parsed = null;
    }
  }
  if (!e.parsed) return null;
  if (!e.ui) e.ui = treeForUi(e.parsed.tree);
  touch(id);
  evictParsedIfNeeded(id);
  return { tree: e.parsed.tree, ui: e.ui, fetchedAt: e.fetchedAt, refreshing: e.refreshing, promise: e.promise, error: e.error };
}

function ageMinutes(entry) {
  if (!entry || !entry.fetchedAt) return Infinity;
  return (Date.now() - new Date(entry.fetchedAt).getTime()) / 60000;
}

function notifyRefresh(id, fetchedAt, tree) {
  if (!onRefreshCb) return;
  try { onRefreshCb({ id, fetchedAt, tree }); } catch (_) { /* state sync is best-effort */ }
}

/**
 * Returns a list's tree, downloading it when needed.
 * @param {{id:string,url:string,ttlMinutes?:number,maxDepth?:number,force?:boolean,userAgent?:string}} req
 */
async function getTree(req) {
  const { id, url } = req;
  const ttl = req.ttlMinutes == null ? 360 : req.ttlMinutes;

  // personal lists: synthetic tree built from the source lists (no direct network)
  if (typeof req.builder === 'function') {
    const tree = await req.builder();
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ fetchedAt: new Date().toISOString(), tree }), 'utf8'), { level: 1 });
    const e = ensureEntry(id);
    e.gz = gz;
    e.parsed = { tree };
    e.ui = null;
    e.fetchedAt = new Date().toISOString();
    e.refreshing = false;
    e.promise = null;
    e.error = '';
    e.epgUrls = (tree.meta && tree.meta.epgUrls) || [];
    touch(id);
    evictParsedIfNeeded(id);
    return { tree, ui: treeForUi(tree), fetchedAt: e.fetchedAt, refreshing: false, promise: null, error: '' };
  }

  const pub = getEntry(id);

  // age from the stored fetchedAt: no parse needed to evaluate expiry
  const meta = ensureEntry(id);
  if (pub && !req.force && ageMinutes({ fetchedAt: meta.fetchedAt }) < ttl) {
    return pub;
  }

  // Stale-while-revalidate: HTTP reads must never wait for a slow panel when
  // an old snapshot is available. The background refresh replaces the entry
  // for the next request; already-open streams are unaffected.
  if (pub && !req.force && req.staleWhileRevalidate) {
    if (!meta.refreshing && !meta.promise) {
      getTree({ ...req, force: true, staleWhileRevalidate: false }).catch(() => {
        /* the stale copy remains available; the next request retries */
      });
    }
    return pub;
  }

  if (meta.refreshing || meta.promise) {
    if (pub && pub.tree && !req.force) return pub;
    await meta.promise.catch(() => {});
    return getEntry(id) || pub;
  }

  meta.refreshing = true;

  const promise = (async () => {
    const tree = await buildTree(url, { maxDepth: req.maxDepth || 8, userAgent: req.userAgent || '' });
    const fetchedAt = new Date().toISOString();
    // compress once: same gzip in RAM and on disk
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ fetchedAt, tree }), 'utf8'), { level: 1 });
    const e = ensureEntry(id);
    e.gz = gz;
    e.parsed = { tree };
    e.ui = null;
    e.fetchedAt = fetchedAt;
    e.refreshing = false;
    e.promise = null;
    e.error = '';
    e.epgUrls = (tree.meta && tree.meta.epgUrls) || [];
    touch(id);
    evictParsedIfNeeded(id);
    persistAsync(id, { gz });
    notifyRefresh(id, fetchedAt, tree);
    return { tree, ui: treeForUi(tree), fetchedAt, refreshing: false, promise: null, error: '' };
  })();

  meta.promise = promise;

  try {
    return await promise;
  } catch (err) {
    const cur = ensureEntry(id);
    cur.refreshing = false;
    cur.promise = null;
    cur.error = err.message || String(err);
    const stale = getEntry(id);
    if (stale) {
      // keep the fatal flag so the scheduler does not retry an invalid URL
      stale.fatal = !!(err && err.fatal);
      return stale; // dati stale meglio di niente
    }
    throw err;
  }
}

function invalidate(id) {
  memory.delete(id);
  const base = path.join(CACHE_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  for (const p of [snapshotPath(id), `${base}.json`]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {
      /* ignore */
    }
  }
}

function invalidateAll() {
  memory.clear();
  try {
    if (fs.existsSync(CACHE_DIR)) {
      for (const f of fs.readdirSync(CACHE_DIR)) {
        if (f.endsWith('.json') || f.endsWith('.json.gz')) fs.unlinkSync(path.join(CACHE_DIR, f));
      }
    }
  } catch (_) {
    /* ignore */
  }
}

/** Starts background refreshes for all enabled expired lists. */
async function refreshAll(lists, defaults) {
  const jobs = lists
    .filter((l) => l.options.enabled && l.url)
    .map(async (l) => {
      try {
        await getTree({
          id: l.id,
          url: l.url,
          ttlMinutes: 0,
          maxDepth: defaults.maxDepth,
          userAgent: l.options.userAgent || '',
          force: false,
        });
        return { id: l.id, ok: true };
      } catch (err) {
        return { id: l.id, ok: false, error: err.message };
      }
    });
  return Promise.all(jobs);
}

/** XMLTV URLs inherited by a list (memory only: no snapshot parsing). */
function epgUrls(id) {
  const e = memory.get(id);
  return e && Array.isArray(e.epgUrls) ? e.epgUrls : [];
}

/** Diagnostica memoria (debug/test): quante entry e quante parseate. */
function isRefreshing(id) {
  const e = memory.get(id);
  return !!(e && (e.refreshing || e.promise));
}

function stats() {
  let parsed = 0, gzBytes = 0;
  for (const e of memory.values()) {
    if (e.parsed) parsed++;
    if (e.gz) gzBytes += e.gz.length;
  }
  return { entries: memory.size, parsedEntries: parsed, gzBytes, maxParsed: MAX_PARSED };
}

module.exports = { getTree, getEntry, invalidate, invalidateAll, refreshAll, ageMinutes, saveSnapshot, setEvictHook, setRefreshHook, isRefreshing, stats, epgUrls };
