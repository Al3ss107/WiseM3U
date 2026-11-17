'use strict';

const store = require('../config');
const cache = require('../cache');
const playlist = require('../playlist');
const live = require('../liveLog');

/**
 * Coordinates background downloads so that HTTP endpoints never hang on
 * slow panels. The UI polls `/api/lists/:id/state` while a download runs.
 */
function createRefresher() {
  const refreshing = new Set();

  function startRefresh(listId, force = true) {
    if (refreshing.has(listId)) return;
    const list = store.findList(listId);
    if (!list) return;

    const startedAt = Date.now();
    refreshing.add(listId);
    store.updateListState(listId, { status: 'fetching', error: '' });

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

    return cache
      .getTree({
        id: listId,
        url: list.url,
        ttlMinutes: 0,
        maxDepth: cfg.settings.maxDepth,
        userAgent: list.options.userAgent || '',
        force,
        builder,
      })
      .then((entry) => {
        const stats = entry.tree.stats || {};
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
          `✔ list "${listName}" ready: ${stats.stations || 0} streams, ${stats.nodes || 0} branches, ` +
            `${stats.m3u || 0} imported m3u, ${stats.failed || 0} errors — in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
          { list: listName, id: listId }
        );

        // Give the list a name when the user did not choose one.
        const current = store.loadConfig();
        const saved = current.lists.find((item) => item.id === listId);
        if (saved && !saved.name && entry.tree.meta.name) {
          saved.name = entry.tree.meta.name;
          saved.options.name = entry.tree.meta.name;
          store.saveConfig(current);
        }
      })
      .catch((err) => {
        const message = err.message || String(err);
        // Fatal means retrying cannot work (video URL, huge list, HTML page):
        // the UI says so instead of suggesting "Refresh".
        store.updateListState(listId, {
          status: 'error',
          error: message,
          fatal: !!(err && err.fatal),
        });
        live.add(
          'download',
          'error',
          `✖ downloading list "${listName}" failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${message} — url: ${list.url}`,
          { list: listName, id: listId }
        );
      })
      .finally(() => refreshing.delete(listId));
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

  /** Refreshes enabled lists whose cached tree is older than their TTL. */
  function autoRefreshTick() {
    const cfg = store.loadConfig();
    for (const list of cfg.lists) {
      if (!list.options.enabled || !list.url) continue;
      // persisted state survives restarts (no need to parse the snapshot)
      const age = cache.ageMinutes({ fetchedAt: (list.state && list.state.fetchedAt) || '' });
      const ttl = list.options.refreshMinutes || cfg.settings.cacheTtlMinutes || 1440;
      if (age !== null && age <= ttl) continue;
      console.log(`[auto-refresh] refreshing "${list.name || list.id}"`);
      startRefresh(list.id, true);
    }
  }

  /** Starts the periodic auto-refresh timer, when configured. */
  function scheduleAutoRefresh() {
    const minutes = Number(store.loadConfig().settings.autoRefreshMinutes || 0);
    if (minutes <= 0) return null;
    setTimeout(autoRefreshTick, 5000);
    return setInterval(autoRefreshTick, minutes * 60000).unref();
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
