'use strict';

/**
 * Rotte del cestino delle liste.
 *
 * Eliminazione (singola o in blocco), elenco delle voci eliminabili, ripristino
 * e svuotamento. Ogni eliminazione crea il punto di ripristino usato dal toast
 * "Annulla" della pagina di configurazione.
 */

const express = require('express');
const store = require('../config');
const cache = require('../cache');
const history = require('../history');
const playlist = require('../playlist');
const { findByPath } = require('../wiseplay');

/** Metadati di lista usati dalla cronologia (nome vuoto -> URL). */
function listMeta(list) {
  return { listId: list.id, listName: list.name || list.url };
}

module.exports = function createTrashRouter({ admin }) {
  const router = express.Router();

  /** Elimina un canale (name presente) o un'intera playlist (solo path). */
  router.post('/:id/delete', admin, (req, res) => {
    const cfg = store.loadConfig();
    const list = store.findList(req.params.id);
    if (!list) return res.status(404).json({ error: 'lista non trovata' });

    const body = req.body || {};
    const path = String(body.path || '');
    const name = body.name;
    const options = list.options;
    const cp = history.ensureCheckpoint(cfg, {
      reason: 'prima di eliminare contenuti',
      listId: list.id,
      listName: list.name || list.url,
    });
    const undo = cp ? { id: cp.id, listIds: [list.id] } : null;

    // cancellazione IN BLOCCO: { paths: [pathRamo, ...] } — un solo salvataggio.
    // Usata dal tasto "Cancella selezionate": stessi effetti del delete singolo
    // (rami nel cestino, ripristinabili da /api/lists/:id/deleted).
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
      if (added) store.saveConfig(cfg, { reason: `${added} playlist eliminate`, ...listMeta(list) });
      return res.json({ ok: true, deleted: added, undo });
    }

    if (!path) return res.status(400).json({ error: 'serve il path' });

    if (typeof name === 'string' && name.trim()) {
      const key = `${path}::${name}`;
      options.deletedChannels = options.deletedChannels || [];
      if (!options.deletedChannels.includes(key)) options.deletedChannels.push(key);
      // mosse e disattivazioni restano intatte: il cestino ripristina tutto com'era
      store.saveConfig(cfg, { reason: 'canale eliminato', ...listMeta(list) });
      return res.json({ ok: true, deleted: key, undo });
    }

    // playlist (ramo reale o gruppo personale "@Nome"): finisce nel cestino
    options.deletedBranches = options.deletedBranches || [];
    if (!options.deletedBranches.includes(path)) options.deletedBranches.push(path);
    store.saveConfig(cfg, { reason: 'playlist eliminata', ...listMeta(list) });
    res.json({ ok: true, deleted: path, undo });
  });

  /** Cestino: canali e playlist eliminati, pronti da ripristinare. */
  router.get('/:id/deleted', admin, async (req, res) => {
    const list = store.findList(req.params.id);
    if (!list) return res.status(404).json({ error: 'lista non trovata' });

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

  /** Ripristina un canale o una playlist dal cestino. */
  router.post('/:id/restore', admin, (req, res) => {
    const cfg = store.loadConfig();
    const list = store.findList(req.params.id);
    if (!list) return res.status(404).json({ error: 'lista non trovata' });

    const body = req.body || {};
    const path = String(body.path || '');
    const name = body.name;
    if (!path) return res.status(400).json({ error: 'serve il path' });

    const options = list.options;
    if (typeof name === 'string' && name.trim()) {
      const key = `${path}::${name}`;
      options.deletedChannels = (options.deletedChannels || []).filter((k) => k !== key);
      store.saveConfig(cfg, { reason: 'ripristino dal cestino', ...listMeta(list) });
      return res.json({ ok: true, restored: key });
    }

    options.deletedBranches = (options.deletedBranches || []).filter((p) => p !== path);
    store.saveConfig(cfg, { reason: 'ripristino dal cestino', ...listMeta(list) });
    res.json({ ok: true, restored: path });
  });

  /** Svuota il cestino: le voci restano fuori dall'output ma non sono piu'
   *  ripristinabili e spariscono dal cestino. */
  router.post('/:id/emptytrash', admin, (req, res) => {
    const cfg = store.loadConfig();
    const list = store.findList(req.params.id);
    if (!list) return res.status(404).json({ error: 'lista non trovata' });

    const options = list.options;
    const cp = history.ensureCheckpoint(cfg, {
      reason: 'prima di svuotare il cestino',
      listId: list.id,
      listName: list.name || list.url,
    });
    const purgedChannels = new Set(options.purgedChannels || []);
    const purgedBranches = new Set(options.purgedBranches || []);
    const freshChannels = (options.deletedChannels || []).filter((k) => !purgedChannels.has(k));
    const freshBranches = (options.deletedBranches || []).filter((p) => !purgedBranches.has(p));

    options.purgedChannels = [...new Set([...purgedChannels, ...freshChannels])];
    options.purgedBranches = [...new Set([...purgedBranches, ...freshBranches])];
    store.saveConfig(cfg, { reason: 'svuota cestino', ...listMeta(list) });

    res.json({
      ok: true,
      removed: freshChannels.length + freshBranches.length,
      undo: cp ? { id: cp.id, listIds: [list.id] } : null,
    });
  });

  return router;
};
