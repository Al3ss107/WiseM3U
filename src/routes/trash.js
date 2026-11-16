'use strict';

/**
 * List trash routes.
 *
 * Deletion (single or bulk), list of deleted items, restore and emptying.
 * Every deletion creates the restore point used by the "Undo" toast on the
 * configuration page.
 */

const express = require('express');
const store = require('../config');
const cache = require('../cache');
const history = require('../history');
const playlist = require('../playlist');
const { findByPath } = require('../wiseplay');

/** List metadata used by history (empty name -> URL). */
function listMeta(list) {
  return { listId: list.id, listName: list.name || list.url };
}

module.exports = function createTrashRouter({ admin }) {
  const router = express.Router();

  /** Deletes a channel (name present) or a whole playlist (path only). */
  router.post('/:id/delete', admin, (req, res) => {
    const cfg = store.loadConfig();
    const list = store.findList(req.params.id);
    if (!list) return res.status(404).json({ error: 'list not found' });

    const body = req.body || {};
    const path = String(body.path || '');
    const name = body.name;
    const options = list.options;
    const cp = history.ensureCheckpoint(cfg, {
      reason: 'before deleting content',
      listId: list.id,
      listName: list.name || list.url,
    });
    const undo = cp ? { id: cp.id, listIds: [list.id] } : null;

    // BULK deletion: { paths: [branchPath, ...] } — a single save.
    // Used by the "Delete selected" button: same effects as a single delete
    // (branches in the trash, restorable from /api/lists/:id/deleted).
    const bulk = Array.isArray(body.paths) ? body.paths : null;
    if (bulk && bulk.length) {
      options.deletedBranches = options.deletedBranches || [];
      let added = 0;
      for (const p of bulk) {
        const branch = String(p || '');
        if (branch && !options.deletedBranches.includes(branch)) {
          options.deletedBranches.push(branch);
          added++;
        }
      }
      if (added) store.saveConfig(cfg, { reason: `${added} playlists deleted`, ...listMeta(list) });
      return res.json({ ok: true, deleted: added, undo });
    }

    if (!path) return res.status(400).json({ error: 'path required' });

    if (typeof name === 'string' && name.trim()) {
      const key = `${path}::${name}`;
      options.deletedChannels = options.deletedChannels || [];
      if (!options.deletedChannels.includes(key)) options.deletedChannels.push(key);
      // moves and disables stay intact: the trash restores everything as it was
      store.saveConfig(cfg, { reason: 'channel deleted', ...listMeta(list) });
      return res.json({ ok: true, deleted: key, undo });
    }

    // playlist (real branch or "@Name" custom group): goes to the trash
    options.deletedBranches = options.deletedBranches || [];
    if (!options.deletedBranches.includes(path)) options.deletedBranches.push(path);
    store.saveConfig(cfg, { reason: 'playlist deleted', ...listMeta(list) });
    res.json({ ok: true, deleted: path, undo });
  });

  /** Trash: deleted channels and playlists, ready to restore. */
  router.get('/:id/deleted', admin, async (req, res) => {
    const list = store.findList(req.params.id);
    if (!list) return res.status(404).json({ error: 'list not found' });

    const options = list.options;
    let entry = null;
    try {
      entry = await playlist.entryFor(store.loadConfig(), list);
    } catch (_) {
      entry = cache.getEntry(list.id);
    }

    const renames = options.renames || {};
    const channelRenames = options.channelRenames || {};
    const moves = options.channelMoves || {};
    const deletedChannels = new Set(options.deletedChannels || []);
    const purgedBranches = new Set(options.purgedBranches || []);
    const purgedChannels = new Set(options.purgedChannels || []);

    // stessi conteggi di buildBranches: nativi - eliminati - spostati via + arrivati
    const countFor = (path, node) => {
      let out = 0;
      let incoming = 0;
      for (const [key, destination] of Object.entries(moves)) {
        if (key.startsWith(`${path}::`)) {
          if (destination !== path) out++;
        } else if (destination === path) {
          incoming++;
        }
      }
      let deleted = 0;
      for (const station of (node && node.stations) || []) {
        if (deletedChannels.has(`${path}::${station.name}`)) deleted++;
      }
      const native = node ? (node.stations || []).length : 0;
      return Math.max(0, native - deleted - out) + incoming;
    };

    const branches = [];
    for (const path of options.deletedBranches || []) {
      if (purgedBranches.has(path)) continue; // cestino svuotato: eliminazione definitiva
      if (path.startsWith('@')) {
        const stations = Object.values(moves).filter((v) => v === path).length;
        branches.push({ path, name: renames[path] || path.slice(1), stations, custom: true });
        continue;
      }
      const node = entry && entry.tree ? findByPath(entry.tree, path) : null;
      branches.push({
        path,
        name: node ? renames[path] || node.name : path,
        stations: countFor(path, node),
      });
    }

    const channels = [];
    for (const key of options.deletedChannels || []) {
      if (purgedChannels.has(key)) continue; // cestino svuotato: eliminazione definitiva
      const separator = key.lastIndexOf('::');
      if (separator < 0) continue;
      const path = key.slice(0, separator);
      const name = key.slice(separator + 2);
      const node = entry && entry.tree ? findByPath(entry.tree, path) : null;
      channels.push({
        path,
        name,
        shown: channelRenames[key] || name,
        branch: node ? renames[path] || node.name : path,
      });
    }

    res.json({ branches, channels });
  });

  /** Restores a channel or playlist from the trash. */
  router.post('/:id/restore', admin, (req, res) => {
    const cfg = store.loadConfig();
    const list = store.findList(req.params.id);
    if (!list) return res.status(404).json({ error: 'list not found' });

    const body = req.body || {};
    const path = String(body.path || '');
    const name = body.name;
    if (!path) return res.status(400).json({ error: 'path required' });

    const options = list.options;
    if (typeof name === 'string' && name.trim()) {
      const key = `${path}::${name}`;
      options.deletedChannels = (options.deletedChannels || []).filter((k) => k !== key);
      store.saveConfig(cfg, { reason: 'trash restore', ...listMeta(list) });
      return res.json({ ok: true, restored: key });
    }

    options.deletedBranches = (options.deletedBranches || []).filter((p) => p !== path);
    store.saveConfig(cfg, { reason: 'trash restore', ...listMeta(list) });
    res.json({ ok: true, restored: path });
  });

  /** Empties the trash: items stay out of the output but can no longer be
   *  restored and disappear from the trash. */
  router.post('/:id/emptytrash', admin, (req, res) => {
    const cfg = store.loadConfig();
    const list = store.findList(req.params.id);
    if (!list) return res.status(404).json({ error: 'list not found' });

    const options = list.options;
    const cp = history.ensureCheckpoint(cfg, {
      reason: 'before emptying the trash',
      listId: list.id,
      listName: list.name || list.url,
    });
    const purgedChannels = new Set(options.purgedChannels || []);
    const purgedBranches = new Set(options.purgedBranches || []);
    const freshChannels = (options.deletedChannels || []).filter((k) => !purgedChannels.has(k));
    const freshBranches = (options.deletedBranches || []).filter((p) => !purgedBranches.has(p));

    options.purgedChannels = [...new Set([...purgedChannels, ...freshChannels])];
    options.purgedBranches = [...new Set([...purgedBranches, ...freshBranches])];
    store.saveConfig(cfg, { reason: 'empty trash', ...listMeta(list) });

    res.json({
      ok: true,
      removed: freshChannels.length + freshBranches.length,
      undo: cp ? { id: cp.id, listIds: [list.id] } : null,
    });
  });

  return router;
};
