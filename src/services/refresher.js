'use strict';

/**
 * Background list downloads.
 *
 * The user configures ONE interval per list (custom override) or a global
 * default. The scheduler only compares timestamps every minute and starts the
 * downloads that are due: it never blocks an HTTP request. Reads use
 * stale-while-revalidate, so playback and catalogs keep working while a slow
 * panel is being downloaded.
 */

const store = require('../config');
const cache = require('../cache');
const playlist = require('../playlist');
const live = require('../liveLog');
const epg = require('../epg');
const { effectiveRefreshMinutes } = require('../config');

const CHECK_INTERVAL_MS = 60 * 1000;
const STARTUP_DELAY_MS = 5000;
const MAX_CONCURRENT_DOWNLOADS = 2;
const RETRY_BASE_MINUTES = 5;
const RETRY_MAX_MINUTES = 360;

/**
 * Coordinates background downloads so that HTTP endpoints never hang on
 * slow panels. The UI polls `/api/lists/:id/state` while a download runs.
 */
function createRefresher() {
  const refreshing = new Set(); // queued or running
  const queue = [];
  let active = 0;

  function retryDelayMinutes(failures) {
    const n = Math.max(1, Number(failures) || 1);
    return Math.min(RETRY_MAX_MINUTES, RETRY_BASE_MINUTES * 2 ** Math.min(10, n - 1));
  }

  /** Keeps persisted state in sync when a read triggers stale-while-revalidate. */
  function onCacheRefresh({ id, fetchedAt, tree }) {
    const list = store.findList(id);
    if (!list) return;
    const stats = (tree && tree.stats) || {};
    store.updateListState(id, {
      status: 'ready',
      error: '',
      fatal: false,
      fetchedAt,
      stats: tree && tree.stats,
      kind: (tree && tree.meta && tree.meta.kind) || 'wiseplay',
      failures: 0,
      nextRetryAt: '',
    });

    // Give the list a name when the user did not choose one.
    const current = store.loadConfig();
    const saved = current.lists.find((item) => item.id === id);
    if (saved && !saved.name && tree && tree.meta && tree.meta.name) {
      saved.name = tree.meta.name;
      saved.options.name = tree.meta.name;
      store.saveConfig(current);
    }
    if (stats && stats.stations) epg.warmGuide(store.loadConfig());
  }

  cache.setRefreshHook(onCacheRefresh);

  function drainQueue() {
    while (active < MAX_CONCURRENT_DOWNLOADS && queue.length) {
      const job = queue.shift();
      active++;
      runRefresh(job).finally(() => {
        active--;
        drainQueue();
      });
    }
  }

  /** Queues a download. Repeated calls for the same list are ignored. */
  function startRefresh(listId, force = true) {
    if (refreshing.has(listId)) return;
    const list = store.findList(listId);
    if (!list) return;

    refreshing.add(listId);
    store.updateListState(listId, {
      status: 'fetching',
      error: '',
      lastAttemptAt: new Date().toISOString(),
    });
    queue.push({ listId, force: force !== false });
    drainQueue();
  }

  async function runRefresh({ listId, force }) {
    const list = store.findList(listId);
    if (!list) {
      refreshing.delete(listId);
      return;
    }

    const startedAt = Date.now();
    const listName = list.name || list.url || listId;
    live.add(
      'download',
      'info',
      `▼ downloading list "${listName}" (${listId})${force ? ' [forced]' : ''} — url: ${list.url || '(personal list)'}`,
      { list: listName, id: listId }
    );

    const cfg = store.loadConfig();
    const builder = list.kind === 'personal'
      ? () => playlist.buildPersonalTree(cfg, list)
      : undefined;

    try {
      const entry = await cache.getTree({
        id: listId,
        url: list.url,
        ttlMinutes: 0,
        maxDepth: cfg.settings.maxDepth,
        userAgent: list.options.userAgent || '',
        force,
        staleWhileRevalidate: false,
        builder,
      });
      // getTree keeps serving a stale snapshot when a download fails: surface
      // that as an error so the UI can show it and back off instead of lying.
      if (entry && entry.error) {
        const staleErr = new Error(entry.error);
        staleErr.fatal = !!entry.fatal;
        throw staleErr;
      }

      const stats = entry.tree.stats || {};
      store.updateListState(listId, {
        status: 'ready',
        error: '',
        fatal: false,
        fetchedAt: entry.fetchedAt,
        stats: entry.tree.stats,
        kind: entry.tree.meta.kind || 'wiseplay',
        failures: 0,
        nextRetryAt: '',
      });
      live.add(
        'download',
        'info',
        `✔ list "${listName}" ready: ${stats.stations || 0} streams, ${stats.nodes || 0} branches, ` +
          `${stats.m3u || 0} imported m3u, ${stats.failed || 0} errors — in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        { list: listName, id: listId }
      );
    } catch (err) {
      const message = err.message || String(err);
      const latest = store.findList(listId) || list;
      const failures = Math.max(0, Number(latest.state && latest.state.failures) || 0) + 1;
      const retryMinutes = retryDelayMinutes(failures);
      // Fatal means retrying cannot work (video URL, huge list, HTML page):
      // the UI says so instead of suggesting "Refresh" and the scheduler
      // stops retrying until the user changes the list.
      store.updateListState(listId, {
        status: 'error',
        error: message,
        fatal: !!(err && err.fatal),
        failures,
        nextRetryAt: new Date(Date.now() + retryMinutes * 60000).toISOString(),
      });
      live.add(
        'download',
        'error',
        `✖ downloading list "${listName}" failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${message} — url: ${list.url}`,
        { list: listName, id: listId }
      );
    } finally {
      refreshing.delete(listId);
    }
  }

  /** Residual "fetching" state (e.g. container restarted mid-download). */
  function reconcileListState(id) {
    const list = store.findList(id);
    if (!list) return;
    if (list.state && list.state.status === 'fetching' && !refreshing.has(id)) {
      console.log('[state] leftover fetching state detected, restarting download of', id);
      startRefresh(id, false);
    }
  }

  /** Resumes every interrupted download after startup. */
  function reconcileAll() {
    for (const list of store.loadConfig().lists) reconcileListState(list.id);
  }

  /** Refreshes enabled lists whose effective interval has elapsed. */
  function autoRefreshTick() {
    const cfg = store.loadConfig();
    const now = Date.now();
    for (const list of cfg.lists) {
      if (!list.options.enabled || !list.url || list.kind === 'personal') continue;
      const state = list.state || {};
      if (state.status === 'fetching') {
        if (!refreshing.has(list.id)) startRefresh(list.id, false);
        continue;
      }
      if (state.fatal) continue; // a wrong URL cannot fix itself by retrying
      if (cache.isRefreshing(list.id)) continue; // stale-while-revalidate is already downloading it
      if (state.nextRetryAt) {
        const retryAt = new Date(state.nextRetryAt).getTime();
        if (Number.isFinite(retryAt) && retryAt > now) continue;
      }
      const interval = effectiveRefreshMinutes(list, cfg.settings);
      if (interval <= 0) continue; // manual only
      const age = cache.ageMinutes({ fetchedAt: state.fetchedAt || '' });
      if (age !== null && age <= interval) continue;
      console.log(`[auto-refresh] refreshing "${list.name || list.id}" (age ${age === null ? 'unknown' : `${Math.round(age)} min`}, interval ${interval} min)`);
      startRefresh(list.id, true);
    }
  }

  /** Starts the internal one-minute check loop. */
  function scheduleAutoRefresh() {
    setTimeout(autoRefreshTick, STARTUP_DELAY_MS);
    return setInterval(autoRefreshTick, CHECK_INTERVAL_MS).unref();
  }

  return {
    startRefresh,
    reconcileListState,
    reconcileAll,
    autoRefreshTick,
    scheduleAutoRefresh,
    isRefreshing: (id) => refreshing.has(id),
  };
}

module.exports = { createRefresher };
