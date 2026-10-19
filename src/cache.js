'use strict';

/**
 * Cache degli alberi WisePlay scaricati: memoria + snapshot su disco,
 * con refresh in background (stale-while-revalidate).
 *
 * Dieta RAM (v1.4.5): gli alberi con centinaia di migliaia di stazioni erano
 * tenuti SEMPRE parseati in memoria (JSON.parse di interi snapshot = oggetti
 * JS da kB a stazione): con 3-4 liste il container superava 800 MB fissi.
 * In memoria teniamo invece il SOLO buffer gzip dello snapshot (~1/6 della
 * dimensione) e parseiamo l'albero solo quando serve davvero (playlist,
 * catalogo, canali, anteprima). Restano parseate al massimo WM_HOT_TREES liste
 * alla volta (LRU): le altre si riconvertono al volo al prossimo uso.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildTree, treeForUi } = require('./wiseplay');

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'data', 'cache');
const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024; // oltre questa soglia lo snapshot non viene scritto
// quante liste restano PARSEATE in RAM insieme (ognuna pesa ~3 kB/stazione);
// le altre esistono solo come gzip in RAM (+ snapshot su disco)
const MAX_PARSED = Math.max(1, Number(process.env.WM_HOT_TREES || 1));

// id -> { gz:Buffer|null, parsed:{tree}|null, ui:object|null,
//         fetchedAt:string, refreshing:boolean, promise:Promise|null,
//         error:string, lastUsed:number }
const memory = new Map();
let onEvictRowCb = null; // hook: righe flatten delle liste per la submission (playlist.rowsMemo)

/** Chiama `cb` ogni volta che l'albero parseato di una lista viene evitto (RAM diet). */
function setEvictHook(cb) { onEvictRowCb = typeof cb === 'function' ? cb : null; }

function touch(id) {
  const e = memory.get(id);
  if (e) e.lastUsed = Date.now();
  return e;
}

/** Evita di tenere piu' alberi parseati del massimo consentito (LRU). */
function evictParsedIfNeeded(skipId) {
  const listed = [];
  for (const [id, e] of memory) if (e.parsed && id !== skipId) listed.push([id, e.lastUsed || 0]);
  while (listed.length >= MAX_PARSED) {
    listed.sort((a, b) => a[1] - b[1]);
    const [oldestId] = listed.shift();
    const e = memory.get(oldestId);
    if (!e) continue;
    e.parsed = null; // la GC ci restituisce l'albero: in RAM resta solo gz
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
    const gz = entry.gz; // gia' comprimuto una volta sola: zero rifare il lavoro
    if (!gz) return;
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

/** Carica una entry in RAM (al avvio: leggi snapshot, comprimi, rilascia subito il parse). */
function ensureEntry(id) {
  let e = memory.get(id);
  if (e) return e;
  memory.set(id, {
    gz: null, parsed: null, ui: null, fetchedAt: '', refreshing: false,
    promise: null, error: '', lastUsed: Date.now(),
  });
  const snap = loadSnapshot(id);
  if (snap) {
    // compressione una volta sola: il gz resta in RAM (tiny), il parse NO
    const raw = JSON.stringify({ fetchedAt: snap.fetchedAt, tree: snap.tree });
    e = memory.get(id);
    e.gz = zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 1 });
    e.parsed = { tree: snap.tree };
    e.fetchedAt = snap.fetchedAt || '';
    evictParsedIfNeeded(id); // al boot: al massimo l'ultima lista resta parseata
  }
  return memory.get(id);
}

/**
 * Entry con tree PARSEATO pronto. Costruisce/ui in modo pigro.
 * Ritorna null se la lista non e' mai stata scaricata.
 * La firma resta quella di sempre ({ tree, ui, fetchedAt, refreshing, promise, error }).
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
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ fetchedAt: new Date().toISOString(), tree }), 'utf8'), { level: 1 });
    const e = ensureEntry(id);
    e.gz = gz;
    e.parsed = { tree };
    e.ui = null;
    e.fetchedAt = new Date().toISOString();
    e.refreshing = false;
    e.promise = null;
    e.error = '';
    touch(id);
    evictParsedIfNeeded(id);
    return { tree, ui: treeForUi(tree), fetchedAt: e.fetchedAt, refreshing: false, promise: null, error: '' };
  }

  const pub = getEntry(id);

  // eta' dal fetchedAt conservato: non serve il parse per valutare la scadenza
  const meta = ensureEntry(id);
  if (pub && !req.force && ageMinutes({ fetchedAt: meta.fetchedAt }) < ttl) {
    return pub;
  }

  if (meta.refreshing || meta.promise) {
    if (pub && pub.tree && !req.force) return pub;
    await meta.promise.catch(() => {});
    return getEntry(id) || pub;
  }

  meta.refreshing = true;

  const promise = (async () => {
    const tree = await buildTree(url, { maxDepth: req.maxDepth || 8 });
    const fetchedAt = new Date().toISOString();
    // compressione una volta sola: stesso gz in RAM e su disco
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ fetchedAt, tree }), 'utf8'), { level: 1 });
    const e = ensureEntry(id);
    e.gz = gz;
    e.parsed = { tree };
    e.ui = null;
    e.fetchedAt = fetchedAt;
    e.refreshing = false;
    e.promise = null;
    e.error = '';
    touch(id);
    evictParsedIfNeeded(id);
    persistAsync(id, { gz });
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
    if (stale) return stale; // dati stale meglio di niente
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

/** Diagnostica memoria (debug/test): quante entry e quante parseate. */
function stats() {
  let parsed = 0, gzBytes = 0;
  for (const e of memory.values()) {
    if (e.parsed) parsed++;
    if (e.gz) gzBytes += e.gz.length;
  }
  return { entries: memory.size, parsedEntries: parsed, gzBytes, maxParsed: MAX_PARSED };
}

module.exports = { getTree, getEntry, invalidate, invalidateAll, refreshAll, ageMinutes, saveSnapshot, setEvictHook, stats };
