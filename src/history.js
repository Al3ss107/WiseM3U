'use strict';

/**
 * Cronologia della configurazione: snapshot automatici su disco.
 *
 * Ogni volta che la configurazione "stabile" cambia (impostazioni, liste,
 * opzioni) viene salvato un file JSON in <data>/history. Lo stato runtime
 * delle liste (status, fetchedAt, statistiche) viene escluso dal confronto:
 * altrimenti ogni aggiornamento creerebbe uno snapshot inutile.
 *
 * La cronologia serve per ripristinare tutto o solo alcune categorie di
 * opzioni (ordine, nomi, esclusioni, unioni, cestino, ...). I file restano
 * sul volume dell'utente e non vengono mai esposti senza token admin.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, '..', 'data', 'config.json');
const HISTORY_DIR = process.env.HISTORY_DIR || path.join(path.dirname(CONFIG_FILE), 'history');
const MAX_ENTRIES = Math.max(5, Number(process.env.HISTORY_MAX) || 60);
const MAX_DAYS = Math.max(1, Number(process.env.HISTORY_DAYS) || 30);

/** Categorie di opzioni ripristinabili separatamente. */
const CATEGORIES = {
  order: ['order', 'channelOrder'],
  names: ['renames', 'channelRenames'],
  exclusions: ['disabledPaths', 'disabledChannels'],
  moves: ['channelMoves', 'personalEntries'],
  trash: ['deletedChannels', 'deletedBranches', 'purgedChannels', 'purgedBranches'],
  groups: ['customGroups'],
  listSettings: [], // tutte le altre chiavi di options
};

const COVERED = new Set(Object.values(CATEGORIES).flat());

function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

/** Configurazione senza lo stato runtime delle liste (quello non va storicizzato). */
function stableConfig(cfg) {
  const lists = (cfg && Array.isArray(cfg.lists) ? cfg.lists : []).map((l) => {
    const { state, ...rest } = l;
    return rest;
  });
  return { settings: (cfg && cfg.settings) || {}, lists };
}

function hashConfig(cfg) {
  return crypto.createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 12);
}

function fileFor(id) {
  return path.join(HISTORY_DIR, `${id}.json`);
}

function validId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || ''));
}

function readEntryFile(file) {
  try {
    const e = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!e || !e.id || !e.config) return null;
    return e;
  } catch (_) {
    return null;
  }
}

function listFiles() {
  try {
    return fs
      .readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map((f) => path.join(HISTORY_DIR, f));
  } catch (_) {
    return [];
  }
}

/** Tutti gli snapshot dal piu' vecchio al piu' recente (ordine per ts, non
 *  per nome file: piu' snapshot possono cadere nello stesso secondo). */
function sortedEntries() {
  const entries = [];
  for (const f of listFiles()) {
    const e = readEntryFile(f);
    if (e) { e._file = f; entries.push(e); }
  }
  entries.sort((a, b) => {
    const ta = Date.parse(a.ts) || 0;
    const tb = Date.parse(b.ts) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
  return entries;
}

function prune() {
  const entries = sortedEntries();
  const cutoff = Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000;
  const keep = new Set(entries.slice(Math.max(0, entries.length - MAX_ENTRIES)).map((e) => e._file));
  // i checkpoint nominati non scadono; se sono troppi restano i 50 piu' recenti
  const namedKeep = new Set(entries.filter((e) => e.name).slice(-50).map((e) => e._file));
  for (const e of entries) {
    // i nominati si contano solo tra loro: non scadono con MAX_ENTRIES/MAX_DAYS
    const old = e.name
      ? !namedKeep.has(e._file)
      : (!keep.has(e._file) || (Date.parse(e.ts) || 0) < cutoff);
    if (old) {
      try { fs.unlinkSync(e._file); } catch (_) { /* ignore */ }
    }
  }
}

let lastHash = null;
function latestHash() {
  if (lastHash) return lastHash;
  const entries = sortedEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e) { lastHash = e.hash || hashConfig(e.config); return lastHash; }
  }
  return null;
}

/** Registra la configurazione se e' cambiata rispetto all'ultimo snapshot. */
function record(cfg, meta = {}, opts = {}) {
  try {
    const data = stableConfig(cfg);
    const h = hashConfig(data);
    if (!opts.force && latestHash() === h) return null; // niente modifiche "stabili"
    ensureDir();
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:.]/g, '').replace(/Z$/, '');
    const id = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const entry = {
      id,
      ts: now.toISOString(),
      reason: String(meta.reason || 'modifica configurazione').slice(0, 160),
      name: String(meta.name || '').slice(0, 80),
      listId: String(meta.listId || ''),
      listName: String(meta.listName || ''),
      hash: h,
      config: data,
    };
    const file = fileFor(id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    lastHash = h;
    prune();
    return entry;
  } catch (err) {
    // la cronologia non deve mai bloccare il salvataggio della configurazione
    console.error('[history] snapshot non salvato:', err.message);
    return null;
  }
}

/** Differenze tra due opzioni di lista (a = piu' vecchia, b = piu' recente). */
function diffOptions(a = {}, b = {}) {
  const out = [];
  for (const [cat, keys] of Object.entries(CATEGORIES)) {
    if (cat === 'listSettings') continue;
    const changed = keys.some((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
    if (changed) out.push(cat);
  }
  const others = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of others) {
    if (!COVERED.has(k) && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) {
      out.push('listSettings');
      break;
    }
  }
  return out;
}

function diffConfigs(older, newer, listId) {
  const changes = { settings: false, lists: false, options: {} };
  const os = older.config.settings || {};
  const ns = newer.config.settings || {};
  changes.settings = JSON.stringify(os) !== JSON.stringify(ns);

  const ol = new Map((older.config.lists || []).map((l) => [l.id, l]));
  const nl = new Map((newer.config.lists || []).map((l) => [l.id, l]));

  if (!listId) {
    const ids = new Set([...ol.keys(), ...nl.keys()]);
    for (const id of ids) {
      const a = ol.get(id);
      const b = nl.get(id);
      if (!a || !b || a.name !== b.name || a.url !== b.url || a.kind !== b.kind) changes.lists = true;
      const cats = diffOptions(a ? a.options : {}, b ? b.options : {});
      if (cats.length) changes.options[id] = cats;
    }
    if (JSON.stringify([...ol.keys()].sort()) !== JSON.stringify([...nl.keys()].sort())) changes.lists = true;
    return changes;
  }

  const a = ol.get(listId);
  const b = nl.get(listId);
  if (!a || !b) changes.lists = true;
  else {
    if (a.name !== b.name || a.url !== b.url) changes.lists = true;
    const cats = diffOptions(a.options, b.options);
    if (cats.length) changes.options[listId] = cats;
  }
  return changes;
}

/** Elenco degli snapshot (piu' recente in testa) con le differenze dal precedente. */
function listEntries({ listId = '', limit = MAX_ENTRIES } = {}) {
  const entries = sortedEntries();
  // entries: dal piu' vecchio al piu' recente
  const out = [];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    const changes = diffConfigs(entries[i - 1], e, listId);
    out.push({
      id: e.id,
      ts: e.ts,
      reason: e.reason || '',
      name: e.name || '',
      listId: e.listId || '',
      listName: e.listName || '',
      hasList: listId ? (e.config.lists || []).some((l) => l.id === listId) : undefined,
      changes,
    });
  }
  // il primo snapshot non ha un precedente: mostralo comunque, senza differenze
  if (entries.length && out.length < entries.length) {
    const e = entries[0];
    out.unshift({
      id: e.id,
      ts: e.ts,
      reason: e.reason || '',
      name: e.name || '',
      listId: e.listId || '',
      listName: e.listName || '',
      hasList: listId ? (e.config.lists || []).some((l) => l.id === listId) : undefined,
      first: true,
      changes: { settings: false, lists: false, options: {} },
    });
  }
  // filtro per lista: tieni solo gli snapshot in cui la lista esiste e cambia
  let res = out.reverse();
  if (listId) {
    // il primo snapshot non ha un precedente: resta come punto di partenza;
    // gli stati in cui la lista non esiste non servono al filtro
    res = res.filter((e) => e.hasList !== false &&
      (e.first || e.changes.settings || e.changes.lists || Object.keys(e.changes.options).length));
  }
  return res.slice(0, Math.max(1, Number(limit) || MAX_ENTRIES));
}

/** Crea un checkpoint nominato (sempre, anche se la config non e' cambiata). */
function checkpoint(cfg, name, meta = {}) {
  return record(cfg, { ...meta, name, reason: meta.reason || 'checkpoint manuale' }, { force: true });
}

/** Restituisce (creandolo se serve) lo snapshot che rappresenta lo stato
 *  attuale: e' il punto di ripristino per l'undo di un'operazione. */
function ensureCheckpoint(cfg, meta = {}) {
  const h = hashConfig(stableConfig(cfg));
  const entries = sortedEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].hash === h) return { id: entries[i].id, ts: entries[i].ts };
  }
  const e = record(cfg, meta, { force: true });
  return e ? { id: e.id, ts: e.ts } : null;
}

function getEntry(id) {
  if (!validId(id)) return null;
  return readEntryFile(fileFor(id));
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Applica le categorie scelte da uno snapshot alle opzioni correnti di una lista. */
function mergeOptions(current = {}, snapshot = {}, categories = []) {
  const cats = new Set(categories);
  const out = clone(current) || {};
  for (const [cat, keys] of Object.entries(CATEGORIES)) {
    if (cat === 'listSettings' || !cats.has(cat)) continue;
    for (const k of keys) out[k] = clone(snapshot[k]);
  }
  if (cats.has('listSettings')) {
    for (const [k, v] of Object.entries(snapshot || {})) {
      if (!COVERED.has(k)) out[k] = clone(v);
    }
  }
  return out;
}

module.exports = {
  HISTORY_DIR,
  CATEGORIES,
  stableConfig,
  record,
  checkpoint,
  ensureCheckpoint,
  listEntries,
  getEntry,
  mergeOptions,
  listFiles,
  validId,
};
