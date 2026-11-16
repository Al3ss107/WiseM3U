'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const express = require('express');
const compression = require('compression');

const store = require('./config');
const cache = require('./cache');
const playlist = require('./playlist');
const { buildTree, treeForUi, findByPath, flattenStations } = require('./wiseplay');
const { makeBranchSelector } = require('./selection');
const { normalizeStreamUrl } = require('./protocols');
const { buildM3U } = require('./m3u');
const createHistoryRouter = require('./routes/history');
const createTrashRouter = require('./routes/trash');
const imgfit = require('./imgfit');
const live = require('./liveLog');
const streamdiag = require('./streamdiag');
const history = require('./history');
const xtream = require('./xtream');
const C = require('./constants');

// Custom UA from settings: applies immediately to downloads too
// background downloads started at boot
C.setCustomUserAgent(store.loadConfig().settings.userAgent);

// RAM diet: when the cache evicts a list's parsed tree, free the memoized
// flatten rows too (strings shared with the tree, otherwise they are not freed)
cache.setEvictHook((listId) => playlist.clearRows(listId));

// willingly releases unused heap to the kernel (with NODE_OPTIONS=--expose-gc):
// keeps RSS close to live data instead of the historical peak
if (typeof global.gc === 'function') {
  setInterval(() => {
    const m = process.memoryUsage();
    if (m.heapUsed > 96 * 1024 * 1024) global.gc();
  }, 30000).unref();
}

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: C.JSON_BODY_LIMIT }));
app.use(compression({
  threshold: C.COMPRESSION_THRESHOLD,
  // playlist servers use m3u MIME types that compression does not compress by default:
  // they are plain text; compressing them drastically reduces bandwidth on home networks
  filter: (req, res) => {
    const ct = String(res.getHeader('Content-Type') || '');
    if (/mpegurl/.test(ct)) return true;
    return compression.filter(req, res);
  },
}));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  // never serve HTML/JS "frozen" by the browser cache after updates:
  // they must ALWAYS be the container version, otherwise UI and logic diverge
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));
// The configuration page is served with the addon version INJECTED
// by the server (placeholder __WM_UI_VERSION__): the empty marker cannot
// lag behind the backend (v1.4.4/v1.4.5 bug) — no endless warnings.
let CONFIG_HTML = null;
function configPageHtml() {
  if (!CONFIG_HTML) {
    CONFIG_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'configure.html'), 'utf8');
  }
  return CONFIG_HTML.replace('__WM_UI_VERSION__', C.VERSION);
}
app.get(['/', '/configure', '/configure/'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(configPageHtml());
});

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

/** Client identification for live logs (ip + user-agent). */
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
  return res.status(401).json({ error: 'missing or invalid token' });
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (tokenOf(req) === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'invalid ADMIN_TOKEN' });
}

/* Rotte modulari (endpoint e comportamento invariati). */
app.use('/api/history', createHistoryRouter({ admin: requireAdmin }));
app.use('/api/lists', createTrashRouter({ admin: requireAdmin }));

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

/** Preferred public base (public URL in settings), otherwise from the request. */
function publicBase(req, cfg) {
  const p = (cfg && cfg.settings && cfg.settings.publicBaseUrl || '').trim();
  return (p || baseUrl(req)).replace(/\/+$/, '');
}

/**
 * Stream diagnostics enabled? Rewrites served URLs (playlist/catalog)
 * to /proxy/play: OK -> direct redirect, KO -> on-screen error video.
 */
function diagStreamUrl(cfg, req, url, name, listName) {
  if (!cfg.settings.streamDiag) return url;
  return streamdiag.diagUrl(publicBase(req, cfg), cfg.settings.token || '', url, name, listName);
}

/**
 * List URL pasted from an HTML page/message: `&` often becomes
 * `&amp;` (or `&#38;`) and the Xtream server receives wrong parameters (it answers with
 * error pages -> "invalid list"). We always normalize on input.
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
    rev: cfg.rev || 0,
    settings: { ...cfg.settings },
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
      description: 'WisePlay lists and M3U/M3U_PLUS (including Xtream) playlists converted into channels and catalogs. Configure at /configure',
      logo: `${baseUrl(req)}/logo.svg`,
      background: `${baseUrl(req)}/logo.svg`,
      resources: ['catalog', 'meta', 'stream'],
      types: [playlist.TYPE],
      // generated meta-ids all start with this prefix: it is what
      // tells Stremio/Nuvio to ask US for meta and streams of these items
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
/* rescaled posters/logos (clients that crop "cover"                   */
/* altrimenti mostrano i loghi zoomati)                                */
/* ------------------------------------------------------------------ */

app.get('/imgfit', requireToken, (req, res) => { imgfit.handle(req, res); });

/** Rewrites remote meta posters with the /imgfit endpoint, when enabled. */
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

// extras arrive as path segments: /genre=X, /search=Y, /skip=N,
// also combined (/genre=X/skip=100) or joined with & (SDK format)
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
    // convenience: also accepts extras as a query string (?genre=…&skip=…)
    if (req.query.search && !extras.search) extras.search = String(req.query.search);
    if (req.query.genre && !extras.genre) extras.genre = String(req.query.genre);
    if (req.query.skip && !extras.skip) extras.skip = String(req.query.skip);
    const cfg = store.loadConfig();
    const result = await playlist.buildCatalog(cfg, catId, extras);
    if (!result) return res.status(404).json({ error: 'catalog not found' });
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
    live.add('catalog', 'error', `catalog error: ${err.message}`, clientInfo(req));
    console.error('[catalog]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/meta/:type/:id.json', requireToken, async (req, res) => {
  try {
    const cfg = store.loadConfig();
    const result = await playlist.buildMeta(cfg, req.params.id);
    if (!result) return res.status(404).json({ error: 'meta not found' });
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
      live.add('stream', 'warn', `stream requested for unknown id: "${req.params.id}"`, clientInfo(req));
      return res.status(404).json({ error: 'stream not found' });
    }
    // the client starts playback here: log EVERYTHING needed
    // for debugging (channel, playlist/group, source list, final served URL)
    const parsed = playlist.parseMetaId(req.params.id);
    const list = parsed ? cfg.lists.find((l) => l.id === parsed.listId) : null;
    const listName = list ? list.name || list.url || list.id : parsed ? parsed.listId : '?';
    // diagnostics enabled: delivered URLs go through /proxy/play (the ▶ line
    // below always logs the ORIGINAL URL, so debugging stays straightforward)
    const rawStreams = (result && result.streams) || [];
    const outStreams = rawStreams.map((s) => ({
      ...s,
      url: diagStreamUrl(cfg, req, s.url, s.title, listName),
    }));
    const playedAt = new Date().toISOString();
    for (const s of rawStreams) {
      live.add(
        'stream',
        'info',
        `▶ ${s.title} | list: "${listName}" | group: ${String(s.name || '').split('\n').pop()} | started: ${playedAt} | url: ${s.url}` +
          (cfg.settings.streamDiag ? ' [diag]' : ''),
        { id: req.params.id, list: listName, ms: Date.now() - t0, ...clientInfo(req) }
      );
    }
    if (!outStreams.length) {
      live.add('stream', 'warn', `0 streams returned for "${req.params.id}" (list "${listName}"): all excluded by filters or gone`, { id: req.params.id, ms: Date.now() - t0, ...clientInfo(req) });
    }
    res.json({ ...result, streams: outStreams });
  } catch (err) {
    live.add('stream', 'error', `stream error "${req.params.id}": ${err.message}`, clientInfo(req));
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
    const { m3u, channels, lists } = await playlist.buildPlaylist(cfg, {
      force: req.query.refresh === '1',
      rewrite: cfg.settings.streamDiag
        ? (ch) => ({ ...ch, url: diagStreamUrl(cfg, req, ch.url, ch.name, ch.listName || '') })
        : undefined,
    });
    const okLists = lists.filter((l) => !l.skipped && !l.error).length;
    const koLists = lists.filter((l) => l.error).length;
    live.add(
      'playlist',
      'info',
      `playlist.m3u generated: ${channels.length} channels from ${okLists}/${cfg.lists.length} lists` +
        `${koLists ? ` (${koLists} in error)` : ''} in ${Date.now() - t0} ms` +
        `${req.query.refresh === '1' ? ' [forced refresh]' : ''}` +
        `${cfg.settings.streamDiag ? ' [diag]' : ''}`,
      clientInfo(req)
    );
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.set(
      'Content-Disposition',
      `attachment; filename="wisem3u-${channels.length}.m3u"`
    );
    res.send(m3u);
  } catch (err) {
    live.add('playlist', 'error', `playlist.m3u generation failed: ${err.message}`, clientInfo(req));
    console.error('[m3u]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Stream diagnostics: OK -> 302 to the source; KO -> video/error on screen. */
app.get('/proxy/play', requireToken, (req, res) => {
  const t0 = Date.now();
  streamdiag.handlePlay(req, res, { t0, client: clientInfo(req) }).catch((err) => {
    live.add('stream', 'error', `diagnostic proxy error: ${err.message}`, clientInfo(req));
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
});

app.get('/playlist.m3u8', (req, res) => {
  const qs = req.originalUrl.split('?')[1] || '';
  res.redirect(307, `/playlist.m3u${qs ? `?${qs}` : ''}`);
});

/** M3U of a single list (preview and personal lists). */
async function listM3U(cfg, list, onlyPath = '') {
  let selector;
  if (onlyPath) {
    selector = (p) => p === onlyPath || p.startsWith(`${onlyPath}.`);
  } else {
    selector = makeBranchSelector(list.options.disabledPaths);
  }

  const entry = await playlist.entryFor(cfg, list);

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
  // the preview/dedicated lists also declare the EPG (manual + the one
  // inherited from the m3u/m3u_plus source, if any)
  const listEpg = (entry.tree && entry.tree.meta && entry.tree.meta.epgUrls) || [];
  return buildM3U(channels, {
    name: `${prefix} (${channels.length} channels)`,
    header: playlist.epgHeader(cfg, listEpg),
  });
}

app.get('/api/lists/:id/preview.m3u', requireAdmin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).send('list not found');
  try {
    const m = await listM3U(store.loadConfig(), list, (req.query.path || '').toString());
    res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.send(m);
  } catch (err) {
    res.status(502).send(`# error: ${err.message}`);
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
/* Configuration API                                                  */
/* ------------------------------------------------------------------ */

app.get('/api/config', requireAdmin, (req, res) => {
  const cfg = store.loadConfig();
  // resumes downloads interrupted by a restart, so the page unblocks itself
  for (const l of cfg.lists) reconcileListState(l.id);
  res.json(publicConfig(store.loadConfig()));
});

app.put('/api/config', requireAdmin, (req, res) => {
  try {
    const current = store.loadConfig();
    const incoming = req.body || {};
    // the UI declares the revision it started from: if the server changed
    // meanwhile (another tab, merge, download...) reject instead of
    // silently overwrite the most recent changes
    const hasBase = incoming.baseRev !== undefined && incoming.baseRev !== null && incoming.baseRev !== '';
    if (hasBase && Number(incoming.baseRev) !== (current.rev || 0)) {
      return res.status(409).json({
        error: 'configuration changed by another operation',
        rev: current.rev || 0,
        config: publicConfig(current),
      });
    }
    const nextSettings = { ...current.settings, ...(incoming.settings || {}) };
    if (typeof nextSettings.token !== 'string') nextSettings.token = '';

    const nextLists = Array.isArray(incoming.lists) ? incoming.lists : current.lists;
    const saved = store.saveConfig(
      { settings: nextSettings, lists: nextLists },
      { reason: String(incoming.reason || 'configuration saved').slice(0, 160) }
    );
    // the custom UA takes effect immediately (subsequent downloads)
    C.setCustomUserAgent(saved.settings.userAgent);

    // keeps the runtime state of existing lists
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
 * Downloads a tree in the background and updates its state: HTTP endpoints
 * respond immediately and the UI polls /api/lists/:id/state. Thus no
 * request hangs for tens of seconds on slow hosts.
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
    `▼ downloading list "${listName}" (${listId})${force ? ' [forced]' : ''} — url: ${list.url || '(personal list)'}`,
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
        fatal: false,
        fetchedAt: entry.fetchedAt,
        stats: entry.tree.stats,
        kind: entry.tree.meta.kind || 'wiseplay',
      });
      live.add(
        'download',
        'info',
        `✔ list "${listName}" ready: ${st.stations || 0} streams, ${st.nodes || 0} branches, ` +
          `${st.m3u || 0} imported m3u, ${st.failed || 0} errors — in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        { list: listName, id: listId }
      );
      // give the list a name if the user did not choose one
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
      // fatal: retrying cannot work (URL pointing to a video, huge list,
      // HTML page): the UI says so instead of suggesting "Refresh"
      store.updateListState(listId, { status: 'error', error: msg, fatal: !!(err && err.fatal) });
      live.add(
        'download',
        'error',
        `✖ downloading list "${listName}" failed after ${((Date.now() - t0) / 1000).toFixed(1)}s — ${msg} — url: ${list.url}`,
        { list: listName, id: listId }
      );
    })
    .finally(() => refreshing.delete(listId));
}

/** Adds a list; the download starts in the background (UI: /state). */
app.post('/api/lists', requireAdmin, (req, res) => {
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

    startRefresh(saved.id, true);
    res.json({ list: store.findList(saved.id), state: store.findList(saved.id).state });
  } catch (err) {
    console.error('[lists]', err);
    res.status(500).json({ error: err.message });
  }
});

/** Residual "fetching" state (e.g. container restarted mid-download):
 *  if no download is actually running, restart it automatically. */
function reconcileListState(id) {
  const list = store.findList(id);
  if (!list) return;
  if (list.state && list.state.status === 'fetching' && !refreshing.has(id)) {
    console.log('[state] leftover fetching state detected, restarting download of', id);
    startRefresh(id, false);
  }
}

/** Current state of a list (UI polling during download). */
app.get('/api/lists/:id/state', requireAdmin, (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  reconcileListState(list.id);
  res.json(store.findList(list.id).state || {});
});

/** Xtream account info (expiry/status) from the panel's /player_api.php.
 *  Cached in the config for 30 minutes: the page stays instant on open. */
app.get('/api/lists/:id/xtream', requireAdmin, async (req, res) => {
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

  const r = await xtream.fetchPanelInfo(url);
  if (!r.ok) {
    // no fresh data: keep the old ones (better old than nothing)
    if (cached) return res.json({ ok: true, ...cached, cached: true, stale: true, fetchError: r.reason });
    return res.json({ ok: false, xtream: true, error: r.reason });
  }
  store.updateListState(list.id, { xtream: r });
  res.json({ ok: true, ...r, cached: false });
});

app.delete('/api/lists/:id', requireAdmin, (req, res) => {
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
app.post('/api/lists/:id/refresh', requireAdmin, (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  startRefresh(list.id, true);
  res.json({ ok: true, state: store.findList(list.id).state });
});

/** Channel name suggestions for the "add channel" field: branches of the same
 *  list (except the current one) + other lists already cached (never network). */
app.get('/api/lists/:id/suggest', requireAdmin, async (req, res) => {
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
  } catch (_) { /* albero non disponibile */ }
  for (const l of cfg.lists) {
    if (l.id === list.id || names.size >= CAP) continue;
    const e = cache.getEntry(l.id); // solo cache: il manifest/pagina restano istantanei
    if (e && e.tree) pushTree(e.tree, l.options, null);
  }
  res.json({ names: [...names] });
});

/** Adds a channel to a branch: a move within the same list, or
 *  nesting from another list (which loses it in its source section). */
app.post('/api/lists/:id/addchannel', requireAdmin, async (req, res) => {
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
    } catch (_) { /* albero non disponibile: provo con le altre liste */ }
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
app.post('/api/lists/:id/mergebranch', requireAdmin, async (req, res) => {
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
  try { e = await playlist.entryFor(cfg, src); } catch (_) { /* non scaricata */ }
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
app.post('/api/lists/:id/restoreorigin', requireAdmin, (req, res) => {
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
  if (personal) list.options.inCatalog = false; // come una lista personale appena creata
  list.state = { status: 'idle', error: '', fatal: false, fetchedAt: '', stats: null, kind: '' };
  store.saveConfig(cfg, { reason: 'list restored', listId: list.id, listName: list.name || list.url });
  cache.invalidate(list.id);            // niente vecchio albero/snapshot
  playlist.clearRows(list.id);
  startRefresh(list.id, true);          // riscarica da zero
  res.json({
    ok: true,
    imports: imp.removed,
    lists: [list.id, ...imp.srcIds],
    undo: cp ? { id: cp.id, listIds: [list.id, ...imp.srcIds] } : null,
  });
});

/** Channels of a single branch, for management from the configuration page. */
app.get('/api/lists/:id/channels', requireAdmin, async (req, res) => {
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
      if (del.has(key)) return; // eliminato: non si vede piu'
      if (movedOut.has(key)) return; // vive in un altro ramo/gruppo
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
    return pa - pb; // stabile: chi non e' in order mantiene l'ordine naturale
  });
  res.json({ path, count: chans.length, channels: chans });
});

/** List branches (the individual playlists) for the configuration UI. */
app.get('/api/lists/:id/tree', requireAdmin, async (req, res) => {
  const list = store.findList(req.params.id);
  if (!list) return res.status(404).json({ error: 'list not found' });
  reconcileListState(list.id);
  let entry = null;
  try { entry = await playlist.entryFor(store.loadConfig(), list); } catch (_) { entry = cache.getEntry(list.id); }
  if (!entry || !entry.tree) {
    // never downloaded (or empty cache): starts a background download
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

/** Quick test of a URL without saving it. */
app.post('/api/probe', requireAdmin, async (req, res) => {
  const url = sanitizeListUrl(req.body && req.body.url);
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid URL' });
  try {
    const tree = await buildTree(url, { maxDepth: store.loadConfig().settings.maxDepth });
    res.json({ ok: true, tree: treeForUi(tree) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || String(err) });
  }
});

/**
 * Resolves a hostname with public DNS (1.1.1.1 / 8.8.8.8): needed when the
 * container cannot see the user's private DNS but the domain is public.
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
 * Server-side request to EasyProxy. The URL field accepts an IP *or* domain
 * and works exactly as written:
 *  - IP: connessione diretta;
 *  - domain: tried with the container DNS; if unknown (private DNS
 *    not visible from Docker) it retries with public DNS, still presenting
 *    the domain in SNI/Host so the nginx vhost answers correctly.
 * Stream rewriting is textual only: the client connects;
 * the server-side fetch happens only for the Test button.
 */
function easyProxyFetch(base, urlPath, { password = '', timeout = 8000 } = {}) {
  let u;
  try { u = new URL(base + urlPath); } catch (e) { return Promise.reject(new Error('invalid URL')); }
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
        // connected by IP: nginx must see the vhost domain in Host
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
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout} ms`)));
    req.on('error', reject);
    req.end();
  });

  if (net.isIP(hostname)) return doRequest(hostname);
  return doRequest(null).catch(async (err) => {
    if (err.code !== 'ENOTFOUND' && err.code !== 'EAI_AGAIN') throw err;
    // the container DNS does not know the domain: try public DNS
    let ip;
    try {
      ip = await resolveViaPublicDns(hostname);
    } catch (e2) {
      throw new Error(
        `the domain "${hostname}" could not be resolved by the container DNS or by public DNS ` +
        `(1.1.1.1/8.8.8.8): if it is a home-only domain (AdGuard/local DNS), enter the ` +
        `IP directly in the URL field, e.g. http://192.168.10.10:7860`
      );
    }
    return doRequest(ip);
  });
}

/** Checks the connection to an EasyProxy instance (and, if requested, a test proxy). */
app.post('/api/easyproxy/test', requireAdmin, async (req, res) => {
  const base = String((req.body && req.body.base) || '').trim().replace(/\/+$/, '');
  const password = String((req.body && req.body.password) || '').trim();
  const testUrl = String((req.body && req.body.testUrl) || '').trim();
  if (!/^https?:\/\//i.test(base)) return res.status(400).json({ ok: false, error: 'invalid base URL' });
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
    res.json({ ok: false, error: `EasyProxy unreachable: ${err.message || err}` });
  }
});

app.post('/api/cache/clear', requireAdmin, (req, res) => {
  cache.invalidateAll();
  imgfit.purge();
  live.add('system', 'info', 'cache cleared from the configuration page', clientInfo(req));
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

/* Dedicated M3U playlist of a personal list. */
app.get(/^\/personal\/([^/]+)\.m3u$/, requireToken, async (req, res) => {
  const list = store.findList(req.params[0]);
  if (!list || list.kind !== 'personal') return res.status(404).json({ error: 'personal list not found' });
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
  const m = process.memoryUsage();
  const cs = cache.stats();
  res.json({
    ok: true,
    version: C.VERSION,
    lists: cfg.lists.length,
    enabled: cfg.lists.filter((l) => l.options.enabled).length,
    uptime: Math.round(process.uptime()),
    // RAM diet visibility without entering the container
    rssMB: Math.round(m.rss / 1048576),
    heapMB: Math.round(m.heapUsed / 1048576),
    cache: { entries: cs.entries, parsed: cs.parsedEntries, gzMB: Math.round(cs.gzBytes / 1048576), hotLists: cs.maxParsed },
  });
});

/* ------------------------------------------------------------------ */

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' });
  res.status(404).send('Not found');
});

/* ------------------------------------------------------------------ */
/* backstop: no error must ever leak as a stack trace                   */
/* ------------------------------------------------------------------ */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = 500;
  let msg = 'internal server error';
  if (err && err.type === 'entity.parse.failed') { status = 400; msg = 'invalid JSON body'; }
  else if (err && err.type === 'entity.too.large') { status = 413; msg = 'request body too large'; }
  else if (err && err.status && Number.isInteger(err.status)) { status = err.status; msg = err.message || msg; }
  console.error(`[http] ${req.method} ${req.originalUrl} -> ${status}: ${msg}`);
  if (req.path.startsWith('/api')) return res.status(status).json({ error: msg });
  res.status(status).send('Internal server error');
});

/* Stability: an unhandled rejection must not bring the service down; an
 * uncaughtException instead exits cleanly (Docker/compose restarts the container). */
process.on('unhandledRejection', (reason) => {
  console.error('[stability] unhandled promise rejection:', (reason && reason.message) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[stability] uncaught error, controlled shutdown:', (err && err.message) || err);
  process.exit(1);
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    const cfg = store.loadConfig();
    // PUBLIC_PORT: the port published on the host when the container runs behind
    // a port mapping (e.g. 7300:7000). Used only to print correct URLs.
    const shownPort = Number(process.env.PUBLIC_PORT || PORT);
    const base = `http://<tuo-ip>:${shownPort}`;
    console.log('='.repeat(64));
    console.log(`  WiseM3U listening on http://${HOST}:${PORT}`);
    if (shownPort !== PORT) console.log(`  Port published on the host: ${shownPort}`);
    console.log(`  Configuration page : ${base}/configure`);
    console.log(`  Playlist M3U             : ${base}/playlist.m3u`);
    console.log(`  Manifest (Stremio/Nuvio) : ${base}/manifest.json`);
    console.log(`  Configured lists        : ${cfg.lists.length}`);
    console.log(`  Config file              : ${store.CONFIG_FILE}`);
    console.log('='.repeat(64));
    live.add('system', 'info', `WiseM3U ${C.VERSION} started on http://${HOST}:${PORT} — ${cfg.lists.length} configured lists`);
    const caps = streamdiag.capabilities();
    live.add('system', 'debug', `stream diagnostics: ffmpeg=${caps.ffmpeg} ffprobe=${caps.ffprobe} font=${caps.font}`);

    // leftover "fetching" states from a previous restart: resume downloads
    for (const l of cfg.lists) reconcileListState(l.id);

    const minutes = Number(cfg.settings.autoRefreshMinutes || 0);
    if (minutes > 0) {
      console.log(`  Auto-refresh every ${minutes} minutes (only expired lists are refreshed)`);
      const tick = () => {
        const c = store.loadConfig();
        for (const l of c.lists) {
          if (!l.options.enabled || !l.url) continue;
          const age = cache.ageMinutes(l.id);
          const ttl = l.options.refreshMinutes || c.settings.cacheTtlMinutes || 1440;
          if (age !== null && age <= ttl) continue;
          console.log(`[auto-refresh] refreshing "${l.name || l.id}"`);
          startRefresh(l.id, true);
        }
      };
      setTimeout(tick, 5000);
      setInterval(tick, minutes * 60000).unref();
    }
  });
}

module.exports = app;
