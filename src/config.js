'use strict';

/**
 * Persistenza della configurazione (JSON su file, montabile come volume Docker).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_ENABLED } = require('./protocols');

const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, '..', 'data', 'config.json');

function defaultListOptions() {
  return {
    enabled: true,
    name: '',
    groupPrefix: 'list', // 'list' | 'none' | 'custom'
    customPrefix: '',
    groupDepth: 1, // quante parti del percorso usare come group-title
    emitLogo: false, // true = usa l'icona del gruppo come tvg-logo quando il canale non ne ha una
    protocols: { ...DEFAULT_ENABLED },
    aceMode: 'keep', // 'keep' | 'engine' | 'off'
    aceEngineHost: 'http://127.0.0.1:6878',
    dedupe: true,
    excludeKeywords: [],
    disabledPaths: [], // rami (gruppi con canali) disattivati dalla pagina di configurazione
    renames: {}, // path -> nome personalizzato del ramo
    order: [], // ordine dei rami; gli assenti vanno in coda
    disabledChannels: [], // canali esclusi, chiave "path::nomeOriginale"
    channelRenames: {}, // "path::nomeOriginale" -> nuovo nome del canale
    channelOrder: {}, // path del ramo -> [nomi originali dei canali, nell'ordine scelto]
    channelMoves: {}, // "path::nomeOriginale" -> destinazione: path di un altro ramo o "@Nome" per gruppi personali
    inCatalog: true,
    catalogName: '',
    refreshMinutes: 1440, // aggiornamento della lista: default giornaliero
    easyProxy: '', // URL di EasyProxy: IP o dominio (es. http://192.168.10.10:7860 o https://proxy.miodominio.it); vuoto = disattivato
    easyProxyPassword: '', // API_PASSWORD di EasyProxy (se impostata)
    easyProxyParams: '', // parametri extra da accodare alla richiesta proxy (es. "warp=off")
  };
}

function defaultConfig() {
  return {
    version: 1,
    settings: {
      addonName: 'WiseM3U',
      addonId: 'community.wisem3u',
      cacheTtlMinutes: 1440,
      autoRefreshMinutes: 1440, // default: aggiornamento giornaliero
      maxDepth: 8,
      dedupeGlobal: true,
      fitLogos: true, // riproporziona i loghi dei canali in poster "contain" (endpoint /imgfit)
      personalLists: [], // liste personali: canali pescati da tutte le liste [{id,name,includeInMain,channels:["listId::path::nome"]}]
      token: '',
      configPassword: '',
      publicBaseUrl: '', // URL pubblico (es. https://mio.dominio con nginx+cert): base per i link mostrati
    },
    lists: [],
  };
}

function newList(url, name) {
  return {
    id: `l_${crypto.randomBytes(5).toString('hex')}`,
    url: (url || '').trim(),
    name: (name || '').trim(),
    createdAt: new Date().toISOString(),
    options: defaultListOptions(),
    state: {
      status: 'idle', // idle | fetching | ready | error
      error: '',
      fetchedAt: '',
      stats: null,
    },
  };
}

function normalizeList(list) {
  const def = defaultListOptions();
  const options = { ...def, ...(list.options || {}) };
  options.protocols = { ...def.protocols, ...(list.options && list.options.protocols) };
  // migrazione: le build precedenti usavano excludePaths per la selezione ad albero
  const legacyExcluded = Array.isArray(options.excludePaths) ? options.excludePaths.map(String) : [];
  delete options.excludePaths;
  delete options.includeOnlyPaths;
  delete options.includeAll;
  options.disabledPaths = Array.isArray(options.disabledPaths)
    ? options.disabledPaths.map(String)
    : legacyExcluded;
  options.renames =
    options.renames && typeof options.renames === 'object' && !Array.isArray(options.renames)
      ? Object.fromEntries(Object.entries(options.renames).map(([k, v]) => [k, String(v)]))
      : {};
  options.order = Array.isArray(options.order) ? options.order.map(String) : [];
  // personalizzazioni dei singoli canali: chiavi "path::nomeOriginale"
  options.disabledChannels = Array.isArray(options.disabledChannels)
    ? options.disabledChannels.map(String)
    : [];
  options.channelRenames =
    options.channelRenames && typeof options.channelRenames === 'object' && !Array.isArray(options.channelRenames)
      ? Object.fromEntries(Object.entries(options.channelRenames).map(([k, v]) => [k, String(v)]))
      : {};
  // eliminazioni definitive dalla pagina: chiavi "path::nomeOriginale" / path di ramo
  options.deletedChannels = Array.isArray(options.deletedChannels)
    ? options.deletedChannels.map(String)
    : [];
  options.deletedBranches = Array.isArray(options.deletedBranches)
    ? options.deletedBranches.map(String)
    : [];
  options.channelOrder =
    options.channelOrder && typeof options.channelOrder === 'object' && !Array.isArray(options.channelOrder)
      ? Object.fromEntries(
          Object.entries(options.channelOrder).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []])
        )
      : {};
  // spostamenti dei canali: chiavi "path::nome", valore = path destinazione o "@Gruppo"
  options.channelMoves =
    options.channelMoves && typeof options.channelMoves === 'object' && !Array.isArray(options.channelMoves)
      ? Object.fromEntries(
          Object.entries(options.channelMoves)
            .filter(([k, v]) => typeof k === 'string' && k.includes('::') && typeof v === 'string' && v && v !== k.slice(0, k.lastIndexOf('::')))
            .map(([k, v]) => [k, String(v)])
        )
      : {};
  options.excludeKeywords = Array.isArray(options.excludeKeywords)
    ? options.excludeKeywords
    : String(options.excludeKeywords || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  // voci delle liste personali (composite): { id, src: "listId::path::nome|*" , dst? }
  // dst (opzionale) = path di un ramo esistente in cui innestare il canale
  options.personalEntries = Array.isArray(options.personalEntries)
    ? options.personalEntries
        .filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && e.id && typeof e.src === 'string' && e.src.includes('::'))
        .map((e) => ({ id: e.id, src: e.src, ...(typeof e.dst === 'string' && e.dst !== '' ? { dst: e.dst } : {}) }))
    : [];
  // playlist/rami personalizzati (vuoti) creati dalla pagina: nomi senza '@'
  options.customGroups = Array.isArray(options.customGroups)
    ? [...new Set(options.customGroups.map((g) => String(g || '').trim()).filter(Boolean))]
    : [];
  options.groupDepth = Math.max(1, Math.min(6, Number(options.groupDepth) || 1));
  options.easyProxy = String(options.easyProxy || '').trim().replace(/\/+$/, '');
  if (options.easyProxy && !/^https?:\/\//i.test(options.easyProxy)) options.easyProxy = '';
  options.easyProxyPassword = String(options.easyProxyPassword || '').trim();
  options.easyProxyParams = String(options.easyProxyParams || '').trim().replace(/^[?&]+/, '');
  delete options.easyProxyDns; // opzione delle build precedenti: ora l'URL accetta IP o dominio
  delete options.easyProxyInsecure; // opzione delle build precedenti: nessuna spunta CA, il certificato lo gestisce il client

  return {
    id: list.id || `l_${crypto.randomBytes(5).toString('hex')}`,
    url: (list.url || '').trim(),
    name: (list.name || '').trim(),
    kind: list.kind === 'personal' ? 'personal' : 'normal',
    createdAt: list.createdAt || new Date().toISOString(),
    options,
    state: {
      status: (list.state && list.state.status) || 'idle',
      error: (list.state && list.state.error) || '',
      fetchedAt: (list.state && list.state.fetchedAt) || '',
      stats: (list.state && list.state.stats) || null,
      kind: (list.state && list.state.kind) || '',
    },
  };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const settings = { ...base.settings, ...(cfg.settings || {}) };
  settings.publicBaseUrl = String(settings.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (settings.publicBaseUrl && !/^https?:\/\//i.test(settings.publicBaseUrl)) settings.publicBaseUrl = '';
  settings.personalLists = Array.isArray(settings.personalLists)
    ? settings.personalLists
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({
          id: typeof p.id === 'string' && p.id ? p.id : `p_${crypto.randomBytes(4).toString('hex')}`,
          name: String(p.name || '').trim() || 'La mia lista',
          includeInMain: p.includeInMain !== false,
          channels: Array.isArray(p.channels)
            ? p.channels.filter((k) => typeof k === 'string' && k.includes('::'))
            : [],
          renames: p.renames && typeof p.renames === 'object'
            ? Object.fromEntries(Object.entries(p.renames).filter(([, v]) => typeof v === 'string'))
            : {},
          overrides: p.overrides && typeof p.overrides === 'object'
            ? Object.fromEntries(
                Object.entries(p.overrides)
                  .filter(([k, v]) => typeof k === 'string' && k.includes('::') && v && typeof v === 'object')
                  .map(([k, v]) => [k, { off: v.off === true, name: String(v.name || '').trim() }])
              )
            : {},
        }))
    : [];

  const lists = Array.isArray(cfg.lists) ? cfg.lists.map(normalizeList) : [];

  /* migrazione: le vecchie "liste personali" (settings.personalLists) diventano
     liste composite a tutti gli effetti (kind:'personal'). */
  for (const pl of settings.personalLists || []) {
    const entries = (pl.channels || []).map((src, i) => ({
      id: `e${i}_${crypto.randomBytes(2).toString('hex')}`,
      src,
    }));
    const l = normalizeList({
      id: pl.id,
      name: pl.name,
      kind: 'personal',
      url: '',
      state: { status: 'ready' },
      options: {
        enabled: pl.includeInMain !== false,
        inCatalog: false,
        catalogName: pl.name,
        personalEntries: entries,
      },
    });
    // rinomine/override del vecchio modello -> personalizzazioni dei rami sintetici
    // (path posizionale: l'i-esima voce diventa il ramo "i")
    (pl.channels || []).forEach((k, i) => {
      const name = k.slice(k.lastIndexOf('::') + 2);
      if (name === '*') {
        const srcPrefix = k.slice(0, k.lastIndexOf('::'));
        for (const [ok, o] of Object.entries(pl.overrides || {})) {
          if (!ok.startsWith(`${srcPrefix}::`)) continue;
          const cname = ok.slice(ok.lastIndexOf('::') + 2);
          if (o.off) l.options.disabledChannels.push(`${i}::${cname}`);
          else if (o.name) l.options.channelRenames[`${i}::${cname}`] = o.name;
        }
      } else {
        const v = (pl.renames || {})[k];
        if (v) l.options.channelRenames[`${i}::${name}`] = v;
      }
    });
    lists.push(l);
  }
  delete settings.personalLists;

  return {
    version: base.version,
    settings,
    lists,
  };
}

let cache = null;

function ensureDir() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  if (cache) return cache;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      if (fs.statSync(CONFIG_FILE).isDirectory()) {
        throw new Error(
          `${CONFIG_FILE} e' una DIRECTORY: Docker l'ha creata automaticamente al primo ` +
            'avvio perche\' il path non esisteva sull\'host. L\'entrypoint del container ' +
            'la sistema da solo; se vedi questo messaggio elimina a mano la cartella ' +
            `("${CONFIG_FILE}") sul volume e riavvia.`
        );
      }
      cache = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
      return cache;
    }
  } catch (err) {
    console.error('[config] lettura fallita, uso i default:', err.message);
  }
  cache = defaultConfig();
  return cache;
}

function saveConfig(cfg) {
  const next = normalizeConfig(cfg);
  if (fs.existsSync(CONFIG_FILE) && fs.statSync(CONFIG_FILE).isDirectory()) {
    throw new Error(
      `${CONFIG_FILE} e' una directory, non un file: rimuovila dal volume e riavvia il container.`
    );
  }
  ensureDir();
  const tmp = `${CONFIG_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
      throw new Error(
        `Permesso negato su ${CONFIG_FILE}: il volume montato appartiene a un altro utente ` +
          '(di solito root). Le immagini recenti sistemano i permessi da sole all\'avvio: ' +
          'ricrea il container con l\'ultima build. In alternativa: sul volume host fai ' +
          '"chown -R <uid>:<gid>" sulla cartella dati oppure avvia il container come root.'
      );
    }
    throw err;
  }
  cache = next;
  return cache;
}

/** Aggiorna lo stato di una lista senza toccare il resto (scrittura atomica). */
function updateListState(id, patch) {
  const cfg = loadConfig();
  const list = cfg.lists.find((l) => l.id === id);
  if (!list) return null;
  list.state = { ...list.state, ...patch };
  return saveConfig(cfg);
}

function findList(id) {
  return loadConfig().lists.find((l) => l.id === id) || null;
}

module.exports = {
  CONFIG_FILE,
  defaultConfig,
  defaultListOptions,
  newList,
  normalizeList,
  normalizeConfig,
  loadConfig,
  saveConfig,
  updateListState,
  findList,
};
