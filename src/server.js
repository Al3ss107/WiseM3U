'use strict';

const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const express = require('express');
const compression = require('compression');

const store = require('./config');
const cache = require('./cache');
const playlist = require('./playlist');
const { buildTree, treeForUi } = require('./wiseplay');
const imgfit = require('./imgfit');
const live = require('./liveLog');
const C = require('./constants');

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: C.JSON_BODY_LIMIT }));
app.use(compression({
  threshold: C.COMPRESSION_THRESHOLD,
  // i playlist-server usano MIME m3u che compression non comprime di default:
  // sono testo puro, comprimerli riduce drasticamente la banda su reti domestiche
  filter: (req, res) => {
    const ct = String(res.getHeader('Content-Type') || '');
    if (/mpegurl/.test(ct)) return true;
    return compression.filter(req, res);
  },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(['/', '/configure', '/configure/'], (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'))
);

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });
  next();
});

/* ------------------------------------------------------------------ */
/* helper                                                              */
/* ------------------------------------------------------------------ */

function tokenOf(req) {
  return (req.query.token || req.query.access_token || req.headers['x-access-token'] || '').toString();
}

/** Identificazione del client per i log live (ip + user-agent). */
function clientInfo(req) {
  return {
    ip: (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '')
      .toString().split(',')[0].trim(),
    ua: (req.headers['user-agent'] || '').toString().slice(0, 160),
  };
}

function requireToken(req, res, next) {
  const expected = store.loadConfig().settings.token;
  if (!expected) return next();
  if (tokenOf(req) === expected) return next();
  return res.status(401).json({ error: 'token mancante o non valido' });
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (tokenOf(req) === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'ADMIN_TOKEN non valido' });
}

function withToken(url, req) {
  const t = store.loadConfig().settings.token;
  if (!t) return url;
  return url.includes('?') ? `${url}&token=${encodeURIComponent(t)}` : `${url}?token=${encodeURIComponent(t)}`;
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/**
 * URL di lista incollato da una pagina/messaggio HTML: gli `&` diventano spesso
 * `&amp;` (o `&#38;`) e il server Xtream riceve parametri sbagliati (risponde con
 * pagine d'errore -> "lista non valida"). Normalizziamo sempre all'ingresso.
 */
function sanitizeListUrl(url) {
  return String(url || '')
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#0?38;/gi, '&');
}

function publicConfig(cfg) {
  return {
    version: C.VERSION,
    settings: { ...cfg.settings, configPassword: cfg.settings.configPassword ? '***' : '' },
    lists: cfg.lists,
  };
}

/* ------------------------------------------------------------------ */
/* manifest Stremio / Nuvio                                            */
/* ------------------------------------------------------------------ */

app.get('/manifest.json', async (req, res) => {
  try {
    const cfg = store.loadConfig();
    const s = cfg.settings;
    res.set('Cache-Control', C.PUBLIC_CACHE_CONTROL);
    res.json({
      id: s.addonId,
      version: C.VERSION,
      name: s.addonName,
      description: 'Liste WisePlay e playlist M3U/M3U_PLUS (anche Xtream) convertite in canali e cataloghi. Configurabile su /configure',
      logo: `${baseUrl(req)}/logo.svg`,
      background: `${baseUrl(req)}/logo.svg`,
      resources: ['catalog', 'meta', 'stream'],
      types: [playlist.TYPE],
      // i meta-id generati iniziano tutti con questo prefisso: e' quello che
      // dice a Stremio/Nuvio di chiedere a NOI meta e stream di queste voci
      idPrefixes: [playlist.ID_PREFIX],
      catalogs: await playlist.buildCatalogs(cfg),
      behaviorHints: { configurable: true, configurationRequired: false },
    });
  } catch (err) {
    console.error('[manifest]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* poster/loghi riproporzionati (i client che ritagliano "cover"       */
/* altrimenti mostrano i loghi zoomati)                                */
/* ------------------------------------------------------------------ */

app.get('/imgfit', requireToken, (req, res) => { imgfit.handle(req, res); });

/** Riscrive i poster remoti delle meta con l'endpoint /imgfit, se attivo. */
function fitPosters(result, req) {
  const cfg = store.loadConfig();
  if (!result || !cfg.settings.fitLogos) return result;
  const base = (cfg.settings.publicBaseUrl || baseUrl(req)).replace(/\/+$/, '');
  const rewrite = (m) => {
    if (!m || !m.poster || !/^https?:/i.test(m.poster)) return;
    const shape = m.posterShape === 'landscape' ? 'landscape' : 'square';
    const u = withToken(`${base}/imgfit?shape=${shape}&url=${encodeURIComponent(m.poster)}`, req);
    m.poster = u;
    if (m.background && /^https?:/i.test(m.background)) m.background = u;
    if (m.logo && /^https?:/i.test(m.logo)) m.logo = u;
  };
  if (Array.isArray(result.metas)) result.metas.forEach(rewrite);
  if (result.meta) rewrite(result.meta);
  return result;
}

/* ------------------------------------------------------------------ */
/* catalogo / meta / stream                                            */
/* ------------------------------------------------------------------ */

// gli extra arrivano come segmenti di path: /genre=X, /search=Y, /skip=N,
// anche combinati (/genre=X/skip=100) o uniti con & (formato SDK)
app.get(/^\/catalog\/([^/]+)\/(.+)\.json$/, requireToken, async (req, res) => {
  try {
    // params[0] = type (tv), params[1] = id catalogo + eventuali extra
    const parts = req.params[1].split('/');
    const catId = parts[0].split('|')[0];
    const extras = {};
    for (const seg of parts.slice(1)) {
      for (const kv of seg.split('&')) {
        const i = kv.indexOf('=');
        if (i > 0) extras[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
      }
    }
    // comodita': accetta gli extra anche come query string (?genre=…&skip=…)
    if (req.query.search && !extras.search) extras.search = String(req.query.search);
    if (req.query.genre && !extras.genre) extras.genre = String(req.query.genre);
    if (req.query.skip && !extras.skip) extras.skip = String(req.query.skip);
    const cfg = store.loadConfig();
    const result = await playlist.buildCatalog(cfg, catId, extras);
    if (!result) return res.status(404).json({ error: 'catalogo non trovato' });
    const list = cfg.lists.find((l) => playlist.catalogId(l.id) === catId);
    const listName = list ? list.name || list.url || list.id : catId;
    live.add(
      'catalog',
      'debug',
      `catalogo "${listName}" (${catId})${extras.genre ? ` genere: "${extras.genre}"` : ''}${extras.search ? ` ricerca: "${extras.search}"` : ''}${extras.skip ? ` da #${extras.skip}` : ''} → ${(result.metas || []).length} voci`,
      { list: listName, ...clientInfo(req) }
    );
    res.set('Cache-Control', C.PUBLIC_CACHE_CONTROL);
    res.json(fitPosters(result, req));
  } catch (err) {
    live.add('catalog', 'error', `errore nel catalogo: ${err.message}`, clientInfo(req));
    console.error('[catalog]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/meta/:type/:id.json', requireToken, async (req, res) => {
  try {
    const cfg = store.loadConfig();
    const result = await playlist.buildMeta(cfg, req.params.id);
    if (!result) return res.status(404).json({ error: 'meta non trovato' });
    res.json(fitPosters(result, req));
  } catch (err) {
    console.error('[meta]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/:type/:id.json', requireToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const cfg = store.loadConfig();
    const result = await playlist.buildStreams(cfg, req.params.id);
    if (!result) {
      live.add('stream', 'warn', `stream richiesto per id sconosciuto: "${req.params.id}"`, clientInfo(req));
      return res.status(404).json({ error: 'stream non trovato' });
    }
    // da qui il client fa partire la riproduzione: logghiamo TUTTO il necessario
    // per il debug (canale, playlist/gruppo, lista di origine, URL finale servito)
    const parsed = playlist.parseMetaId(req.params.id);
    const list = parsed ? cfg.lists.find((l) => l.id === parsed.listId) : null;
    const listName = list ? list.name || list.url || list.id : parsed ? parsed.listId : '?';
    const playedAt = new Date().toISOString();
    const streams = (result && result.streams) || [];
    for (const s of streams) {
      live.add(
        'stream',
        'info',
        `▶ ${s.title} | lista: "${listName}" | gruppo: ${String(s.name || '').split('\n').pop()} | avvio: ${playedAt} | url: ${s.url}`,
        { id: req.params.id, list: listName, ms: Date.now() - t0, ...clientInfo(req) }
      );
    }
    if (!streams.length) {
      live.add('stream', 'warn', `0 stream restituiti per "${req.params.id}" (lista "${listName}"): tutti esclusi dai filtri o spariti`, { id: req.params.id, ms: Date.now() - t0, ...clientInfo(req) });
    }
    res.json(result);
  } catch (err) {
    live.add('stream', 'error', `errore nello stream "${req.params.id}": ${err.message}`, clientInfo(req));
    console.error('[stream]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* playlist M3U / JSON                                                 */
/* ------------------------------------------------------------------ */

app.get('/playlist.m3u', requireToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const cfg = store.loadConfig();
    const { m3u, channels, lists } = await playlist.buildPlaylist(cfg, { force: req.query.refresh === '1' });
    const okLists = lists.filter((l) => !l.skipped && !l.error).length;
    const koLists = lists.filter((l) => l.error).length;
    live.add(
      'playlist',
      'info',
      `playlist.m3u generata: ${channels.length} canali da ${okLists}/${cfg.lists.length} liste` +
        `${koLists ? ` (${koLists} in errore)` : ''} in ${Date.now() - t0} ms` +
        `${req.query.refresh === '1' ? ' [refresh forzato]' : ''}`,
      clientInfo(req)
    );
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.set(
      'Content-Disposition',
      `attachment; filename="wisem3u-${channels.length}.m3u"`
    );
    res.send(m3u);
  } catch (err) {
    live.add('playlist', 'error', `generazione playlist.m3u fallita: ${err.message}`, clientInfo(req));
    console.error('[m3u]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/playlist.m3u8', (req, res) => {
  const qs = req.originalUrl.split('?')[1] || '';
  res.redirect(307, `/playlist.m3u${qs ? `?${qs}` : ''}`);
});

/** Anteprima M3U di una singola lista, eventualmente limitata a un ramo. */
/** M3U di una singola lista (Anteprima e liste personali). */
async function listM3U(cfg, list, onlyPath = '') {
  let selector;
  if (onlyPath) {
    selector = (p) => p === onlyPath || p.startsWith(`${onlyPath}.`);
  } else {
    selector = require('./selection').makeBranchSelector(list.options.disabledPaths);
  }

  const entry = await playlist.entryFor(cfg, list);
  const { flattenStations } = require('./wiseplay');
  const { normalizeStreamUrl } = require('./protocols');
  const { buildM3U } = require('./m3u');

  const prefix = playlist.listPrefix(list);
  const raw = flattenStations(entry.tree, selector, {
    maxDepth: list.options.groupDepth,
    joiner: playlist.JOINER,
    prefix,
    emitLogo: !!list.options.emitLogo,
    renames: list.options.renames,
    disabledChannels: list.options.disabledChannels,
    deletedChannels: list.options.deletedChannels,
    deletedBranches: list.options.deletedBranches,
    channelRenames: list.options.channelRenames,
    channelMoves: list.options.channelMoves,
  });
  const channels = raw
    .map((c) => ({ ...c, url: playlist.proxyStreamUrl(normalizeStreamUrl(c.url, list.options), list) }))
    .filter((c) => c.url)
    .map((c) => ({ name: c.name, url: c.url, logo: c.logo, group: c.group || prefix }));
  // anche l'anteprima/le liste dedicate dichiarano l'EPG (manuale + quello
  // ereditato dalla sorgente m3u/m3u_plus, se lo aveva)
  const listEpg = (entry.tree && entry.tree.meta && entry.tree.meta.epgUrls) || [];
  return buildM3U(channels, {
    name: `${prefix} (${channels.length} canali)`,
    header: playlist.epgHeader(cfg, listEpg),
  });
}

app.get('/api/lists/:id/preview.m3u', requireAdmin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).send('lista non trovata');
  try {
    const m = await listM3U(store.loadConfig(), list, (req.query.path || '').toString());
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.send(m);
  } catch (err) {
    res.status(502).send(`# errore: ${err.message}`);
  }
});

app.get('/channels.json', requireToken, async (req, res) => {  try {
    const cfg = store.loadConfig();
    const result = await playlist.collectChannels(cfg, { force: req.query.refresh === '1' });
    res.json({
      count: result.channels.length,
      lists: result.lists,
      errors: result.errors,
      epg: Object.keys(playlist.epgHeader(cfg, result.epgUrls)).length ? result.epgUrls : undefined,
      channels: req.query.full === '1' ? result.channels : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* API di configurazione                                               */
/* ------------------------------------------------------------------ */

app.get('/api/config', requireAdmin, (req, res) => {
  const cfg = store.loadConfig();
  // riaggancia gli scaricamenti interrotti da un riavvio, cosi' la pagina si sblocca da sola
  for (const l of cfg.lists) reconcileListState(l.id);
  res.json(publicConfig(store.loadConfig()));
});

app.put('/api/config', requireAdmin, (req, res) => {
  try {
    const current = store.loadConfig();
    const incoming = req.body || {};
    const nextSettings = { ...current.settings, ...(incoming.settings || {}) };
    if (nextSettings.configPassword === '***') nextSettings.configPassword = current.settings.configPassword;
    if (typeof nextSettings.token !== 'string') nextSettings.token = '';

    const nextLists = Array.isArray(incoming.lists) ? incoming.lists : current.lists;
    const saved = store.saveConfig({ settings: nextSettings, lists: nextLists });

    // conserva lo stato runtime delle liste esistenti
    for (const l of saved.lists) {
      const before = current.lists.find((x) => x.id === l.id);
      if (before) l.state = before.state;
    }
    store.saveConfig(saved);

    res.json(publicConfig(store.loadConfig()));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Scarica un albero in background e ne aggiorna lo stato: gli endpoint HTTP
 * rispondono subito e la UI interroga /api/lists/:id/state. Cosi' nessuna
 * richiesta resta appesa per decine di secondi su host lenti.
 */
const refreshing = new Set();

function startRefresh(listId, force = true) {
  if (refreshing.has(listId)) return;
  const list = store.findList(listId);
  if (!list) return;
  const t0 = Date.now();
  refreshing.add(listId);
  store.updateListState(listId, { status: 'fetching', error: '' });
  const listName = list.name || list.url || listId;
  live.add(
    'download',
    'info',
    `▼ scaricamento lista "${listName}" (${listId})${force ? ' [forzato]' : ''} — url: ${list.url || '(lista personale)'}`,
    { list: listName, id: listId }
  );
  const cfg0 = store.loadConfig();
  const builder = list.kind === 'personal' ? () => playlist.buildPersonalTree(cfg0, list) : undefined;
  cache
    .getTree({
      id: listId,
      url: list.url,
      ttlMinutes: 0,
      maxDepth: cfg0.settings.maxDepth,
      force,
      builder,
    })
    .then((entry) => {
      const st = entry.tree.stats || {};
      store.updateListState(listId, {
        status: 'ready',
        error: '',
        fetchedAt: entry.fetchedAt,
        stats: entry.tree.stats,
        kind: entry.tree.meta.kind || 'wiseplay',
      });
      live.add(
        'download',
        'info',
        `✔ lista "${listName}" pronta: ${st.stations || 0} stream, ${st.nodes || 0} rami, ` +
          `${st.m3u || 0} m3u importate, ${st.failed || 0} errori — in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        { list: listName, id: listId }
      );
      // dai' il nome della lista se l'utente non l'ha scelto
      const c = store.loadConfig();
      const l = c.lists.find((x) => x.id === listId);
      if (l && !l.name && entry.tree.meta.name) {
        l.name = entry.tree.meta.name;
        l.options.name = entry.tree.meta.name;
        store.saveConfig(c);
      }
    })
    .catch((err) => {
      const msg = err.message || String(err);
      store.updateListState(listId, { status: 'error', error: msg });
      live.add(
        'download',
        'error',
        `✖ scaricamento lista "${listName}" fallito dopo ${((Date.now() - t0) / 1000).toFixed(1)}s — ${msg} — url: ${list.url}`,
        { list: listName, id: listId }
      );
    })
    .finally(() => refreshing.delete(listId));
}

/** Aggiunge una lista; lo scaricamento parte in background (UI: /state). */
app.post('/api/lists', requireAdmin, (req, res) => {
  try {
    const url = sanitizeListUrl(req.body && req.body.url);
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL non valido (usa http/https)' });
    const name = (req.body && req.body.name ? String(req.body.name) : '').trim();

    const cfg = store.loadConfig();
    if (cfg.lists.some((l) => l.url === url)) {
      return res.status(409).json({ error: 'Lista gia presente' });
    }

    const list = store.newList(url, name);
    const withList = store.saveConfig({ ...cfg, lists: [...cfg.lists, list] });
    const saved = withList.lists[withList.lists.length - 1];

    startRefresh(saved.id, true);
    res.json({ list: store.findList(saved.id), state: store.findList(saved.id).state });
  } catch (err) {
    console.error('[lists]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Stato "fetching" residuo (es. container riavviato a meta' scaricamento):
 *  se nessun download e' realmente in corso, lo facciamo ripartire da solo. */
function reconcileListState(id) {
  const list = store.findList(id);
  if (!list) return;
  if (list.state && list.state.status === 'fetching' && !refreshing.has(id)) {
    console.log('[state] fetching residuo rilevato, riavvio lo scaricamento di', id);
    startRefresh(id, false);
  }
}

/** Stato corrente di una lista (polling della UI durante lo scaricamento). */
app.get('/api/lists/:id/state', requireAdmin, (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
  reconcileListState(list.id);
  res.json(store.findList(list.id).state || {});
});

app.delete('/api/lists/:id', requireAdmin, (req, res) => {
  const cfg = store.loadConfig();
  const next = cfg.lists.filter((l) => l.id !== req.params.id);
  if (next.length === cfg.lists.length) return res.status(404).json({ error: 'lista non trovata' });
  cache.invalidate(req.params.id);
  store.saveConfig({ ...cfg, lists: next });
  res.json({ ok: true });
});

/** Ricarica l'albero di una lista in background. */
app.post('/api/lists/:id/refresh', requireAdmin, (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
  startRefresh(list.id, true);
  res.json({ ok: true, state: store.findList(list.id).state });
});

/** Suggerimenti nomi canale per il campo "aggiungi canale": rami della stessa
 *  lista (tranne quello corrente) + altre liste gia' in cache (mai rete). */
app.get('/api/lists/:id/suggest', requireAdmin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
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
  } catch (_) { /* albero non disponibile */ }
  for (const l of cfg.lists) {
    if (l.id === list.id || names.size >= CAP) continue;
    const e = cache.getEntry(l.id); // solo cache: il manifest/pagina restano istantanei
    if (e && e.tree) pushTree(e.tree, l.options, null);
  }
  res.json({ names: [...names] });
});

/** Aggiunge un canale a un ramo: spostamento dentro la stessa lista, oppure
 *  innesto da un'altra lista (che lo perde nella sua sezione di origine). */
app.post('/api/lists/:id/addchannel', requireAdmin, async (req, res) => {
  const cfg = store.loadConfig();
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
  const path = String((req.body || {}).path || '');
  const val = String((req.body || {}).name || '').trim();
  const home = String((req.body || {}).home || '');
  const fromList = String((req.body || {}).fromList || '');
  if (!path || !val) return res.status(400).json({ error: 'servono path e name' });

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
  const { findByPath } = require('./wiseplay');
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

  // 1) stessa lista: diventa uno spostamento (la sorgente lo perde)
  if (!fromList || fromList === list.id) {
    try {
      const e = await playlist.entryFor(cfg, list);
      // canale eliminato in precedenza: riaggiungerlo lo ripristina
      const delKey = home ? `${home}::${val}` : '';
      if (delKey && (list.options.deletedChannels || []).includes(delKey)) {
        list.options.deletedChannels = list.options.deletedChannels.filter((k) => k !== delKey);
        if (path !== home) {
          list.options.channelMoves = list.options.channelMoves || {};
          list.options.channelMoves[delKey] = path;
        }
        store.saveConfig(cfg);
        return res.json({ ok: true, from: list.name || list.id, revived: true });
      }
      const hit = e && e.tree
        ? (home ? findAt(e.tree, list.options, home) : null) || findIn(e.tree, list.options, path)
        : null;
      if (hit) {
        list.options.channelMoves = list.options.channelMoves || {};
        list.options.channelMoves[`${hit.home}::${hit.name}`] = path;
        store.saveConfig(cfg);
        return res.json({ ok: true, from: list.name || list.id });
      }
    } catch (_) { /* albero non disponibile: provo con le altre liste */ }
  }

  // 2) altra lista: innesto nel ramo + disattivazione nella sorgente
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
    store.saveConfig(cfg);
    return res.json({ ok: true, from: l.name || l.id });
  }
  res.status(404).json({ error: 'canale non trovato in nessuna lista' });
});

/** Elimina definitivamente un canale (name presente) o un'intera playlist (solo path). */
app.post('/api/lists/:id/delete', requireAdmin, (req, res) => {
  const cfg = store.loadConfig();
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
  const path = String((req.body || {}).path || '');
  const name = (req.body || {}).name;
  if (!path) return res.status(400).json({ error: 'serve il path' });
  const o = list.options;

  if (typeof name === 'string' && name.trim()) {
    const key = `${path}::${name}`;
    o.deletedChannels = o.deletedChannels || [];
    if (!o.deletedChannels.includes(key)) o.deletedChannels.push(key);
    // mosse e disattivazioni restano intatte: il cestino ripristina tutto com'era
    store.saveConfig(cfg);
    return res.json({ ok: true, deleted: key });
  }

  // playlist (ramo reale o gruppo personale "@Nome"): finisce nel cestino
  o.deletedBranches = o.deletedBranches || [];
  if (!o.deletedBranches.includes(path)) o.deletedBranches.push(path);
  store.saveConfig(cfg);
  res.json({ ok: true, deleted: path });
});

/** Cestino: canali e playlist eliminati, pronti da ripristinare. */
app.get('/api/lists/:id/deleted', requireAdmin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
  const o = list.options;
  let entry = null;
  try { entry = await playlist.entryFor(store.loadConfig(), list); } catch (_) { entry = cache.getEntry(list.id); }
  const { findByPath } = require('./wiseplay');
  const renames = o.renames || {};
  const chRenames = o.channelRenames || {};
  const moves = o.channelMoves || {};

  const delSet = new Set(o.deletedChannels || []);
  // stessi conteggi di buildBranches: nativi - eliminati - spostati via + arrivati
  const countFor = (p, node) => {
    let out = 0;
    let inn = 0;
    for (const [k, v] of Object.entries(moves)) {
      if (k.startsWith(`${p}::`)) { if (v !== p) out++; }
      else if (v === p) inn++;
    }
    let del = 0;
    for (const st of (node && node.stations) || []) {
      if (delSet.has(`${p}::${st.name}`)) del++;
    }
    const native = node ? (node.stations || []).length : 0;
    return Math.max(0, native - del - out) + inn;
  };
  const branches = [];
  for (const p of o.deletedBranches || []) {
    if (p.startsWith('@')) {
      const n = Object.values(moves).filter((v) => v === p).length;
      branches.push({ path: p, name: (renames[p] || p.slice(1)), stations: n, custom: true });
      continue;
    }
    const node = entry && entry.tree ? findByPath(entry.tree, p) : null;
    branches.push({
      path: p,
      name: node ? (renames[p] || node.name) : p,
      stations: countFor(p, node),
    });
  }
  const channels = [];
  for (const key of o.deletedChannels || []) {
    const i = key.lastIndexOf('::');
    if (i < 0) continue;
    const p = key.slice(0, i);
    const nm = key.slice(i + 2);
    const node = entry && entry.tree ? findByPath(entry.tree, p) : null;
    channels.push({ path: p, name: nm, shown: chRenames[key] || nm, branch: node ? (renames[p] || node.name) : p });
  }
  res.json({ branches, channels });
});

/** Ripristina un canale o una playlist dal cestino. */
app.post('/api/lists/:id/restore', requireAdmin, (req, res) => {
  const cfg = store.loadConfig();
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
  const path = String((req.body || {}).path || '');
  const name = (req.body || {}).name;
  if (!path) return res.status(400).json({ error: 'serve il path' });
  const o = list.options;
  if (typeof name === 'string' && name.trim()) {
    const key = `${path}::${name}`;
    o.deletedChannels = (o.deletedChannels || []).filter((k) => k !== key);
    store.saveConfig(cfg);
    return res.json({ ok: true, restored: key });
  }
  o.deletedBranches = (o.deletedBranches || []).filter((p) => p !== path);
  store.saveConfig(cfg);
  res.json({ ok: true, restored: path });
});

/** Sposta TUTTI i canali di una playlist dentro un'altra (trascinamento di una
 *  playlist su un'altra). Stessa lista = spostamento; liste diverse = innesto
 *  nella destinazione e spegnimento nella sorgente. */
app.post('/api/lists/:id/mergebranch', requireAdmin, async (req, res) => {
  const cfg = store.loadConfig();
  const target = store.findList(req.params.id);
  if (!target) return res.status(404).json({ error: 'lista non trovata' });
  const fromList = String((req.body || {}).fromList || target.id);
  const from = String((req.body || {}).from || '');
  const to = String((req.body || {}).to || '');
  if (!from || !to) return res.status(400).json({ error: 'servono from e to' });
  if (from === to && fromList === target.id) return res.status(400).json({ error: 'stessa playlist' });
  const src = cfg.lists.find((l) => l.id === fromList);
  if (!src) return res.status(404).json({ error: 'lista di origine non trovata' });
  const oT = target.options;

  // gruppo personale come origine: solo dentro la stessa lista (ridireziona le mosse)
  if (from.startsWith('@')) {
    if (fromList !== target.id) return res.status(400).json({ error: 'gruppo personale: spostalo solo dentro la stessa lista' });
    let n = 0;
    for (const [k, v] of Object.entries(oT.channelMoves || {})) {
      if (v === from) { oT.channelMoves[k] = to; n++; }
    }
    store.saveConfig(cfg);
    return res.json({ ok: true, moved: n, from: from.slice(1) });
  }

  let e = null;
  try { e = await playlist.entryFor(cfg, src); } catch (_) { /* non scaricata */ }
  if (!e || !e.tree) return res.status(409).json({ error: 'lista di origine non ancora scaricata' });
  const { findByPath } = require('./wiseplay');
  const node = findByPath(e.tree, from);
  if (!node) return res.status(404).json({ error: 'playlist di origine non trovata' });
  const oS = src.options;
  const del = new Set(oS.deletedChannels || []);
  const stations = (node.stations || []).filter((st) => !del.has(`${from}::${st.name}`));
  if (!stations.length) return res.json({ ok: true, moved: 0, from: src.name || src.id });

  if (fromList === target.id) {
    oT.channelMoves = oT.channelMoves || {};
    for (const st of stations) oT.channelMoves[`${from}::${st.name}`] = to;
    store.saveConfig(cfg);
    return res.json({ ok: true, moved: stations.length, from: src.name || src.id });
  }

  if (to.startsWith('@')) return res.status(400).json({ error: 'tra liste diverse la destinazione deve essere una playlist esistente' });
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
  store.saveConfig(cfg);
  res.json({ ok: true, moved: n, from: src.name || src.id });
});

/** Canali di un singolo ramo, per la gestione dalla pagina di configurazione. */
app.get('/api/lists/:id/channels', requireAdmin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
  let entry = null;
  try { entry = await playlist.entryFor(store.loadConfig(), list); } catch (_) { entry = cache.getEntry(list.id); }
  if (!entry || !entry.tree) return res.status(409).json({ error: 'lista non ancora scaricata' });
  const path = String(req.query.path || '');
  const { findByPath } = require('./wiseplay');

  const renames = list.options.channelRenames || {};
  const branchRenames = list.options.renames || {};
  const dis = new Set(list.options.disabledChannels || []);
  const del = new Set(list.options.deletedChannels || []);
  const delB = new Set(list.options.deletedBranches || []);
  const moves = list.options.channelMoves || {};

  // canali in arrivo da altri rami (o gruppi personali "@Nome")
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
  if (!isCustom && delB.has(path)) return res.status(404).json({ error: 'ramo eliminato' });
  const node = isCustom ? null : findByPath(entry.tree, path);
  if (!isCustom && !node) return res.status(404).json({ error: 'ramo non trovato' });

  const chans = [];
  if (!isCustom) {
    (node.stations || []).forEach((st) => {
      const key = `${path}::${st.name}`;
      if (del.has(key)) return; // eliminato: non si vede piu'
      if (movedOut.has(key)) return; // vive in un altro ramo/gruppo
      chans.push({ name: st.name, shown: renames[key] || st.name, enabled: !dis.has(key), home: path, cur: path, from: '' });
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
    return pa - pb; // stabile: chi non e' in order mantiene l'ordine naturale
  });
  res.json({ path, count: chans.length, channels: chans });
});

/** Rami della lista (le singole playlist) per la UI di configurazione. */
app.get('/api/lists/:id/tree', requireAdmin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'lista non trovata' });
  reconcileListState(list.id);
  let entry = null;
  try { entry = await playlist.entryFor(store.loadConfig(), list); } catch (_) { entry = cache.getEntry(list.id); }
  if (!entry || !entry.tree) {
    // mai scaricata (o cache vuota): parte uno scaricamento in background
    startRefresh(list.id, false);
    return res.status(202).json({ fetching: true, state: store.findList(list.id).state });
  }
  res.json({
    meta: entry.tree.meta,
    fetchedAt: entry.fetchedAt,
    error: entry.error || '',
    branches: playlist.buildBranches(entry, list),
  });
});

/** Test rapido di un URL senza salvarlo. */
app.post('/api/probe', requireAdmin, async (req, res) => {
  const url = sanitizeListUrl(req.body && req.body.url);
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'URL non valido' });
  try {
    const tree = await buildTree(url, { maxDepth: store.loadConfig().settings.maxDepth });
    res.json({ ok: true, tree: treeForUi(tree) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || String(err) });
  }
});

/**
 * Risolve un hostname con DNS pubblici (1.1.1.1 / 8.8.8.8): serve quando il
 * container non vede il DNS personale dell'utente ma il dominio e' pubblico.
 */
function resolveViaPublicDns(hostname) {
  const r = new (require('dns').promises.Resolver)();
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return Promise.race([
    r.resolve4(hostname).then((a) => a[0]),
    new Promise((resolve, rej) => {
      const t = setTimeout(() => rej(new Error('timeout DNS pubblici')), 4000);
      if (t.unref) t.unref();
    }),
  ]);
}

/**
 * Richiesta lato server verso EasyProxy. Nel campo URL si mette IP *o* dominio
 * e funziona cosi' come scritto:
 *  - IP: connessione diretta;
 *  - dominio: si prova col DNS del container; se non lo conosce (DNS personale
 *    non visibile da Docker) si riprova con i DNS pubblici, presentando comunque
 *    il dominio in SNI/Host cosi' il vhost nginx risponde correttamente.
 * La riscrittura degli stream e' solo testuale: a connettersi
 * e' il client; il fetch lato server avviene soltanto per il pulsante Test.
 */
function easyProxyFetch(base, urlPath, { password = '', timeout = 8000 } = {}) {
  let u;
  try { u = new URL(base + urlPath); } catch (e) { return Promise.reject(new Error('URL non valido')); }
  if (password) u.searchParams.set('api_password', password);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const hostname = u.hostname;

  const doRequest = (hostOverride) => new Promise((resolve, reject) => {
    const byIp = !!hostOverride && hostOverride !== hostname;
    const options = {
      host: hostOverride || hostname,
      port,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      timeout,
      headers: {
        'user-agent': 'WiseM3U',
        // connesso per IP: nginx deve vedere il dominio del vhost in Host
        ...(byIp ? { host: u.host } : {}),
      },
    };
    if (isHttps) {
      options.servername = hostname; // SNI corretto per il vhost nginx
    }
    const req = (isHttps ? https : http).request(options, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout dopo ${timeout} ms`)));
    req.on('error', reject);
    req.end();
  });

  if (net.isIP(hostname)) return doRequest(hostname);
  return doRequest(null).catch(async (err) => {
    if (err.code !== 'ENOTFOUND' && err.code !== 'EAI_AGAIN') throw err;
    // il DNS del container non conosce il dominio: prova i DNS pubblici
    let ip;
    try {
      ip = await resolveViaPublicDns(hostname);
    } catch (e2) {
      throw new Error(
        `il dominio "${hostname}" non e' stato risolto ne' dal DNS del container ne' dai DNS pubblici ` +
        `(1.1.1.1/8.8.8.8): se e' un dominio solo di casa tua (AdGuard/DNS locale), scrivi direttamente ` +
        `l'IP nel campo URL, es. http://192.168.10.10:7860`
      );
    }
    return doRequest(ip);
  });
}

/** Verifica la connessione a un'istanza EasyProxy (e, se richiesto, un proxy di prova). */
app.post('/api/easyproxy/test', requireAdmin, async (req, res) => {
  const base = String((req.body && req.body.base) || '').trim().replace(/\/+$/, '');
  const password = String((req.body && req.body.password) || '').trim();
  const testUrl = String((req.body && req.body.testUrl) || '').trim();
  if (!/^https?:\/\//i.test(base)) return res.status(400).json({ ok: false, error: 'URL base non valido' });
  try {
    const r = await easyProxyFetch(base, '/api/info', { password, timeout: C.EP_INFO_TIMEOUT_MS });
    if (r.status !== 200) {
      return res.json({ ok: false, error: `EasyProxy ha risposto ${r.status} su /api/info (password errata?)` });
    }
    let info = null;
    try { info = JSON.parse(r.body); } catch (e) { /* risposta non-JSON: va bene comunque */ }
    const out = { ok: true, info };
    if (/^https?:\/\//i.test(testUrl)) {
      const t0 = Date.now();
      try {
        const pr = await easyProxyFetch(base, `/proxy/manifest.m3u8?url=${encodeURIComponent(testUrl)}`, { password, timeout: C.EP_PROXY_TIMEOUT_MS });
        out.proxyTest = { status: pr.status, contentType: pr.headers['content-type'] || '', ms: Date.now() - t0 };
      } catch (err) {
        out.proxyTest = { error: err.message || String(err), ms: Date.now() - t0 };
      }
    }
    res.json(out);
  } catch (err) {
    res.json({ ok: false, error: `EasyProxy non raggiungibile: ${err.message || err}` });
  }
});

app.post('/api/cache/clear', requireAdmin, (req, res) => {
  cache.invalidateAll();
  imgfit.purge();
  live.add('system', 'info', 'cache svuotata dalla pagina di configurazione', clientInfo(req));
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* log live (debug): buffer in memoria + specchio su docker logs       */
/* ------------------------------------------------------------------ */

app.get('/api/logs', requireAdmin, (req, res) => {
  res.json({
    entries: live.list({
      since: req.query.since,
      limit: req.query.limit,
      scope: req.query.scope,
    }),
  });
});

app.post('/api/logs/clear', requireAdmin, (req, res) => {
  live.clear();
  res.json({ ok: true });
});

/* Playlist M3U dedicata di una lista personale. */
app.get(/^\/personal\/([^/]+)\.m3u$/, requireToken, async (req, res) => {
  const list = store.findList(req.params[0]);
  if (!list || list.kind !== 'personal') return res.status(404).json({ error: 'lista personale non trovata' });
  try {
    const m = await listM3U(store.loadConfig(), list);
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="personal-${list.id}.m3u"`);
    res.send(m);
  } catch (err) {
    console.error('[personal]', err);
    res.status(502).json({ error: err.message });
  }
});

app.get('/healthz', (req, res) => {
  const cfg = store.loadConfig();
  res.json({
    ok: true,
    version: C.VERSION,
    lists: cfg.lists.length,
    enabled: cfg.lists.filter((l) => l.options.enabled).length,
    uptime: Math.round(process.uptime()),
  });
});

function getUiTree(id) {
  const entry = cache.getEntry(id);
  return entry && entry.ui ? entry.ui : null;
}

/* ------------------------------------------------------------------ */

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'non trovato' });
  res.status(404).send('Non trovato');
});

/* ------------------------------------------------------------------ */
/* backstop: nessun errore deve mai uscire come stack trace            */
/* ------------------------------------------------------------------ */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = 500;
  let msg = 'errore interno del server';
  if (err && err.type === 'entity.parse.failed') { status = 400; msg = 'body JSON non valido'; }
  else if (err && err.type === 'entity.too.large') { status = 413; msg = 'body troppo grande'; }
  else if (err && err.status && Number.isInteger(err.status)) { status = err.status; msg = err.message || msg; }
  console.error(`[http] ${req.method} ${req.originalUrl} -> ${status}: ${msg}`);
  if (req.path.startsWith('/api')) return res.status(status).json({ error: msg });
  res.status(status).send('Errore interno del server');
});

/* Stabilita': una promessa rifiutata non deve abbattere il servizio; un
 * uncaughtException invece esce pulito (Docker/compose riavvia il container). */
process.on('unhandledRejection', (reason) => {
  console.error('[stability] promessa rifiutata non gestita:', (reason && reason.message) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[stability] errore non catturato, arresto controllato:', (err && err.message) || err);
  process.exit(1);
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    const cfg = store.loadConfig();
    // PUBLIC_PORT: la porta pubblicata sull'host quando il container gira dietro
    // un port mapping (es. 7300:7000). Serve solo a stampare gli URL corretti.
    const shownPort = Number(process.env.PUBLIC_PORT || PORT);
    const base = `http://<tuo-ip>:${shownPort}`;
    console.log('='.repeat(64));
    console.log(`  WiseM3U in ascolto su http://${HOST}:${PORT}`);
    if (shownPort !== PORT) console.log(`  Porta pubblicata sull'host: ${shownPort}`);
    console.log(`  Pagina di configurazione : ${base}/configure`);
    console.log(`  Playlist M3U             : ${base}/playlist.m3u`);
    console.log(`  Manifest (Stremio/Nuvio) : ${base}/manifest.json`);
    console.log(`  Liste configurate        : ${cfg.lists.length}`);
    console.log(`  File config              : ${store.CONFIG_FILE}`);
    console.log('='.repeat(64));
    live.add('system', 'info', `WiseM3U ${C.VERSION} avviato su http://${HOST}:${PORT} — ${cfg.lists.length} liste configurate`);

    // stati "fetching" residui da un riavvio precedente: riprendi gli scaricamenti
    for (const l of cfg.lists) reconcileListState(l.id);

    const minutes = Number(cfg.settings.autoRefreshMinutes || 0);
    if (minutes > 0) {
      console.log(`  Auto-refresh ogni ${minutes} minuti (aggiorno solo le liste scadute)`);
      const tick = () => {
        const c = store.loadConfig();
        for (const l of c.lists) {
          if (!l.options.enabled || !l.url) continue;
          const age = cache.ageMinutes(l.id);
          const ttl = l.options.refreshMinutes || c.settings.cacheTtlMinutes || 1440;
          if (age !== null && age <= ttl) continue;
          console.log(`[auto-refresh] aggiorno "${l.name || l.id}"`);
          startRefresh(l.id, true);
        }
      };
      setTimeout(tick, 5000);
      setInterval(tick, minutes * 60000).unref();
    }
  });
}

module.exports = app;
