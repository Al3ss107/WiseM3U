'use strict';

/**
 * Cache degli alberi WisePlay scaricati: memoria + snapshot su disco,
 * con refresh in background (stale-while-revalidate).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildTree, treeForUi } = require('./wiseplay');

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'data', 'cache');
const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024; // oltre questa soglia lo snapshot non viene scritto

const memory = new Map(); // id -> { tree, ui, fetchedAt, refreshing, promise }

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function snapshotPath(id) {
  return path.join(CACHE_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json.gz`);
}

function saveSnapshot(id, entry) {
  try {
    ensureDir();
    const raw = JSON.stringify({ fetchedAt: entry.fetchedAt, tree: entry.tree });
    // livello 1: su hardware lento (ARM/NAS) il livello 9 comprimeva 59 MB
    // per decine di secondi bloccando le richieste; il rapporto resta ottimo
    const gz = zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 1 });
    if (gz.length > MAX_SNAPSHOT_BYTES) {
      console.warn(
        `[cache] snapshot di ${id} troppo grande (${(gz.length / 1048576).toFixed(1)} MB compressi): ` +
          'resta solo in memoria, al riavvio la lista verra riscaricata'
      );
      return;
    }
    fs.writeFileSync(snapshotPath(id), gz);
    console.log(`[cache] snapshot di ${id} salvato (${(gz.length / 1048576).toFixed(1)} MB)`);
  } catch (err) {
    console.error('[cache] snapshot non salvato:', err.message);
  }
}

/** Persistenza in background: non deve mai rallentare chi ha chiesto l'albero. */
function persistAsync(id, entry) {
  setImmediate(() => saveSnapshot(id, entry));
}

function loadSnapshot(id) {
  try {
    const p = snapshotPath(id);
    if (!fs.existsSync(p)) {
      // compatibilita' con gli snapshot non compressi delle versioni precedenti
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

function getEntry(id) {
  if (memory.has(id)) return memory.get(id);
  const snap = loadSnapshot(id);
  if (!snap) return null;
  const entry = {
    tree: snap.tree,
    ui: treeForUi(snap.tree),
    fetchedAt: snap.fetchedAt,
    refreshing: false,
    promise: null,
    error: '',
  };
  memory.set(id, entry);
  return entry;
}

function ageMinutes(entry) {
  if (!entry || !entry.fetchedAt) return Infinity;
  return (Date.now() - new Date(entry.fetchedAt).getTime()) / 60000;
}

/**
 * Restituisce l'albero di una lista, scaricandolo se serve.
 * @param {{id:string,url:string,ttlMinutes?:number,maxDepth?:number,force?:boolean}} req
 */
async function getTree(req) {
  const { id, url } = req;
  const ttl = req.ttlMinutes == null ? 360 : req.ttlMinutes;

  // liste personali: albero sintetico costruito dalle liste sorgente (niente rete diretta)
  if (typeof req.builder === 'function') {
    const tree = await req.builder();
    const fresh = {
      tree,
      ui: treeForUi(tree),
      fetchedAt: new Date().toISOString(),
      refreshing: false,
      promise: null,
      error: '',
    };
    memory.set(id, fresh);
    return fresh;
  }

  const entry = getEntry(id);

  if (entry && !req.force && ageMinutes(entry) < ttl) {
    return entry;
  }

  if (entry && entry.promise) {
    // refresh gia' in corso: se abbiamo dati freschi li usiamo, altrimenti aspettiamo
    if (entry.tree && !req.force) return entry;
    await entry.promise.catch(() => {});
    return memory.get(id) || entry;
  }

  entry && (entry.refreshing = true);

  const promise = (async () => {
    const tree = await buildTree(url, { maxDepth: req.maxDepth || 8 });
    const fresh = {
      tree,
      ui: treeForUi(tree),
      fetchedAt: new Date().toISOString(),
      refreshing: false,
      promise: null,
      error: '',
    };
    memory.set(id, fresh);
    persistAsync(id, fresh);
    return fresh;
  })();

  if (entry) {
    entry.promise = promise;
    memory.set(id, entry);
  } else {
    memory.set(id, { tree: null, ui: null, fetchedAt: '', refreshing: true, promise, error: '' });
  }

  try {
    return await promise;
  } catch (err) {
    const cur = memory.get(id) || {};
    cur.refreshing = false;
    cur.promise = null;
    cur.error = err.message || String(err);
    memory.set(id, cur);
    if (cur.tree) return cur; // dati stale meglio di niente
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

/** Avvia i refresh in background di tutte le liste attive scadute. */
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
          force: false,
        });
        return { id: l.id, ok: true };
      } catch (err) {
        return { id: l.id, ok: false, error: err.message };
      }
    });
  return Promise.all(jobs);
}

module.exports = { getTree, getEntry, invalidate, invalidateAll, refreshAll, ageMinutes, saveSnapshot };
