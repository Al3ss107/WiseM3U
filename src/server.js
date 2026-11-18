'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');

const store = require('./config');
const cache = require('./cache');
const playlist = require('./playlist');
const { buildTree, treeForUi } = require('./wiseplay');
const createHistoryRouter = require('./routes/history');
const createTrashRouter = require('./routes/trash');
const createListsRouter = require('./routes/lists');
const epg = require('./epg');
const imgfit = require('./imgfit');
const live = require('./liveLog');
const streamdiag = require('./streamdiag');
const C = require('./constants');
const {
  clientInfo,
  createRequireAdmin,
  baseUrl,
  diagStreamUrl,
  sanitizeListUrl,
} = require('./http/request');
const { createRefresher } = require('./services/refresher');
const { buildListM3U } = require('./services/listM3u');
const { easyProxyFetch } = require('./easyproxy');

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
const requireAdmin = createRequireAdmin(ADMIN_TOKEN);
const refresher = createRefresher();

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
// lag behind the backend — no endless warnings.
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

function publicConfig(cfg) {
  return {
    version: C.VERSION,
    rev: cfg.rev || 0,
    settings: { ...cfg.settings },
    lists: cfg.lists,
  };
}

/* Modular API routers (paths and behavior unchanged). */
app.use('/api/history', createHistoryRouter({ admin: requireAdmin }));
app.use('/api/lists', createTrashRouter({ admin: requireAdmin }));
app.use('/api/lists', createListsRouter({ admin: requireAdmin, refresher }));

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
      behaviorHints: {
        configurable: true,
        configurationRequired: false,
        // opt in only when an XMLTV source is configured: clients without
        // real startTime/endTime data must not advertise a guide
        ...(playlist.hasEpg(cfg) ? { epgProvider: true } : {}),
      },
    });
  } catch (err) {
    console.error('[manifest]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* rescaled posters/logos (clients that crop "cover"                   */
/* otherwise they show zoomed logos)                                  */
/* ------------------------------------------------------------------ */

app.get('/imgfit', (req, res) => { imgfit.handle(req, res); });

/** Rewrites remote meta posters with the /imgfit endpoint, when enabled. */
function fitPosters(result, req, list) {
  const cfg = store.loadConfig();
  if (!result || !cfg.settings.fitLogos) return result;
  const base = baseUrl(req).replace(/\/+$/, '');
  const rewrite = (m) => {
    if (!m || !m.poster || !/^https?:/i.test(m.poster)) return;
    const shape = m.posterShape === 'landscape' ? 'landscape' : 'square';
    const listParam = list ? `&list=${encodeURIComponent(list.id)}` : '';
    const u = `${base}/imgfit?shape=${shape}${listParam}&url=${encodeURIComponent(m.poster)}`;
    m.poster = u;
    if (m.background && /^https?:/i.test(m.background)) m.background = u;
    if (m.logo && /^https?:/i.test(m.logo)) m.logo = u;
  };
  if (Array.isArray(result.metas)) result.metas.forEach(rewrite);
  if (Array.isArray(result.metasDetailed)) result.metasDetailed.forEach(rewrite);
  if (result.meta) rewrite(result.meta);
  return result;
}

/* ------------------------------------------------------------------ */
/* catalog / meta / stream                                             */
/* ------------------------------------------------------------------ */

// extras arrive as path segments: /genre=X, /search=Y, /skip=N,
// also combined (/genre=X/skip=100) or joined with & (SDK format)
app.get(/^\/catalog\/([^/]+)\/(.+)\.json$/, async (req, res) => {
  try {
    // params[0] = type (tv), params[1] = catalog id + optional extras
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
    if (req.query.date && !extras.date) extras.date = String(req.query.date);
    const cfg = store.loadConfig();
    const result = await playlist.buildCatalog(cfg, catId, extras);
    if (!result) return res.status(404).json({ error: 'catalog not found' });
    const list = cfg.lists.find((l) => playlist.catalogId(l.id) === catId);
    const listName = list ? list.name || list.url || list.id : catId;
    live.add(
      'catalog',
      'debug',
      `catalog "${listName}" (${catId})${extras.genre ? ` genre: "${extras.genre}"` : ''}${extras.search ? ` search: "${extras.search}"` : ''}${extras.skip ? ` from #${extras.skip}` : ''}${extras.date ? ` on ${extras.date}` : ''} → ${(result.metasDetailed || result.metas || []).length} items`,
      { list: listName, ...clientInfo(req) }
    );
    res.set('Cache-Control', C.PUBLIC_CACHE_CONTROL);
    res.json(fitPosters(result, req, list));
  } catch (err) {
    live.add('catalog', 'error', `catalog error: ${err.message}`, clientInfo(req));
    console.error('[catalog]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/meta/:type/:id.json', async (req, res) => {
  try {
    const cfg = store.loadConfig();
    const result = await playlist.buildMeta(cfg, req.params.id);
    if (!result) return res.status(404).json({ error: 'meta not found' });
    const parsed = playlist.parseMetaId(req.params.id);
    const list = parsed ? cfg.lists.find((l) => l.id === parsed.listId) : null;
    res.json(fitPosters(result, req, list));
  } catch (err) {
    console.error('[meta]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/:type/:id.json', async (req, res) => {
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

app.get('/playlist.m3u', async (req, res) => {
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
app.get('/proxy/play', (req, res) => {
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

app.get('/channels.json', async (req, res) => {
  try {
    const cfg = store.loadConfig();
    const result = await playlist.collectChannels(cfg, { force: req.query.refresh === '1' });
    res.json({
      count: result.channels.length,
      lists: result.lists,
      errors: result.errors,
      epg: Object.keys(playlist.epgHeader(result.epgUrls)).length ? result.epgUrls : undefined,
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
  for (const l of cfg.lists) refresher.reconcileListState(l.id);
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

    const nextLists = Array.isArray(incoming.lists) ? incoming.lists : current.lists;
    const saved = store.saveConfig(
      { settings: nextSettings, lists: nextLists },
      { reason: String(incoming.reason || 'configuration saved').slice(0, 160) }
    );
    // keeps the runtime state of existing lists
    for (const l of saved.lists) {
      const before = current.lists.find((x) => x.id === l.id);
      if (before) l.state = before.state;
    }
    store.saveConfig(saved);

    // A custom UA belongs to the list: when it changes, the old snapshot was
    // downloaded with another identity, so invalidate it and fetch again.
    for (const l of saved.lists) {
      const before = current.lists.find((x) => x.id === l.id);
      if (!before || (before.options.userAgent || '') === (l.options.userAgent || '')) continue;
      cache.invalidate(l.id);
      if (l.options.enabled && l.kind !== 'personal') refresher.startRefresh(l.id, true);
    }

    epg.warmGuide(store.loadConfig());
    res.json(publicConfig(store.loadConfig()));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

/** Checks the connection to an EasyProxy instance (and, if requested, a test proxy). */
app.post('/api/easyproxy/test', requireAdmin, async (req, res) => {
  const base = String((req.body && req.body.base) || '').trim().replace(/\/+$/, '');
  const password = String((req.body && req.body.password) || '').trim();
  const testUrl = String((req.body && req.body.testUrl) || '').trim();
  if (!/^https?:\/\//i.test(base)) return res.status(400).json({ ok: false, error: 'invalid base URL' });
  try {
    const r = await easyProxyFetch(base, '/api/info', { password, timeout: C.EP_INFO_TIMEOUT_MS });
    if (r.status !== 200) {
      return res.json({ ok: false, error: `EasyProxy answered ${r.status} on /api/info (wrong password?)` });
    }
    let info = null;
    try { info = JSON.parse(r.body); } catch (e) { /* non-JSON response: still fine */ }
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
  epg.invalidate();
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
app.get(/^\/personal\/([^/]+)\.m3u$/, async (req, res) => {
  const list = store.findList(req.params[0]);
  if (!list || list.kind !== 'personal') return res.status(404).json({ error: 'personal list not found' });
  try {
    const m = await buildListM3U(store.loadConfig(), list);
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
    refresher.reconcileAll();
    // Warm the XMLTV guide in the background: channel details then open instantly
    playlist.warmEpg(cfg);

    // The scheduler is internal and cheap (it only compares timestamps).
    // Each list uses its own interval, or the global default.
    console.log('  Automatic list check: every minute (per-list or global interval; 0 = manual)');
    refresher.scheduleAutoRefresh();
  });
}

module.exports = app;
