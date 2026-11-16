'use strict';

/**
 * Rotte della cronologia configurazione.
 *
 * Espone l'elenco degli snapshot, il ripristino selettivo per categorie, la
 * creazione di checkpoint nominati e l'undo delle operazioni distruttive.
 * Tutte le rotte sono protette dal middleware admin passato dal server.
 */

const express = require('express');
const store = require('../config');
const cache = require('../cache');
const history = require('../history');
const C = require('../constants');

/** Riporta nome/URL/tipo della lista corrente a quelli dello snapshot. */
function applyListIdentity(current, saved) {
  current.name = saved.name || current.name;
  current.url = saved.url || current.url;
  if (saved.kind) current.kind = saved.kind;
}

module.exports = function createHistoryRouter({ admin }) {
  const router = express.Router();

  router.get('/', admin, (req, res) => {
    const listId = String(req.query.list || '').trim();
    res.json({ entries: history.listEntries({ listId }) });
  });

  /** Crea un checkpoint nominato: sempre registrato, anche a config invariata. */
  router.post('/checkpoints', admin, (req, res) => {
    try {
      const name = String((req.body || {}).name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'serve un nome per il checkpoint' });
      const entry = history.checkpoint(store.loadConfig(), name);
      if (!entry) return res.status(500).json({ error: 'checkpoint non salvato' });
      res.json({ ok: true, entry: { id: entry.id, ts: entry.ts, name: entry.name } });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Ripristina da uno snapshot: tutto o solo le categorie scelte. */
  router.post('/:id/restore', admin, (req, res) => {
    try {
      const snap = history.getEntry(req.params.id);
      if (!snap) return res.status(404).json({ error: 'snapshot non trovato' });
      const body = req.body || {};
      const cfg = store.loadConfig();
      const targetList = body.listId ? String(body.listId) : '';
      const cats = Array.isArray(body.options)
        ? [...new Set(body.options.map(String))].filter((c) => c === 'listSettings' || history.CATEGORIES[c])
        : [];
      const restored = { settings: false, lists: false, options: {} };

      if (body.settings) {
        // il token non si ripristina: un vecchio snapshot potrebbe chiudere fuori
        const settings = { ...(snap.config.settings || {}) };
        delete settings.token;
        cfg.settings = { ...cfg.settings, ...settings };
        restored.settings = true;
      }

      if (body.lists) {
        // aggiorna nome/URL delle liste esistenti e riaggiunge quelle sparite;
        // non elimina le liste create dopo lo snapshot
        for (const saved of snap.config.lists || []) {
          const current = cfg.lists.find((l) => l.id === saved.id);
          if (current) {
            applyListIdentity(current, saved);
          } else {
            cfg.lists.push({ ...saved, state: { status: 'idle' } });
          }
        }
        restored.lists = true;
      }

      if (cats.length) {
        const ids = targetList ? [targetList] : (snap.config.lists || []).map((l) => l.id);
        for (const id of ids) {
          const saved = (snap.config.lists || []).find((l) => l.id === id);
          const current = cfg.lists.find((l) => l.id === id);
          if (!saved || !current) continue;
          current.options = history.mergeOptions(current.options, saved.options, cats);
          restored.options[id] = cats;
        }
      }

      if (!restored.settings && !restored.lists && !Object.keys(restored.options).length) {
        return res.status(400).json({ error: 'nessuna categoria selezionata' });
      }

      const list = targetList ? cfg.lists.find((l) => l.id === targetList) : null;
      const savedCfg = store.saveConfig(cfg, {
        reason: 'ripristino cronologia',
        listId: targetList,
        listName: list ? list.name || list.url : '',
      });
      if (restored.settings) C.setCustomUserAgent(savedCfg.settings.userAgent);
      res.json({ ok: true, restored });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Annulla un'operazione: riporta le liste indicate allo stato precedente. */
  router.post('/:id/undo', admin, (req, res) => {
    try {
      const snap = history.getEntry(req.params.id);
      if (!snap) return res.status(404).json({ error: 'snapshot non trovato' });

      const ids = Array.isArray((req.body || {}).listIds)
        ? [...new Set(req.body.listIds.map((x) => String(x || '')).filter(Boolean))]
        : [];
      if (!ids.length) return res.status(400).json({ error: 'serve la lista da ripristinare' });

      const cfg = store.loadConfig();
      const restored = [];

      for (const id of ids) {
        const saved = (snap.config.lists || []).find((l) => l.id === id);
        if (!saved) continue;
        const current = cfg.lists.find((l) => l.id === id);
        if (current) {
          applyListIdentity(current, saved);
          current.options = JSON.parse(JSON.stringify(saved.options || {}));
        } else {
          // la lista era stata eliminata: la riaggiungo com'era nello snapshot
          cfg.lists.push({ ...JSON.parse(JSON.stringify(saved)), state: { status: 'idle' } });
          cache.invalidate(id);
        }
        restored.push(id);
      }

      if (!restored.length) return res.status(404).json({ error: 'lista non presente nello snapshot' });

      const list = cfg.lists.find((l) => l.id === restored[0]);
      store.saveConfig(cfg, {
        reason: 'annullamento operazione',
        listId: restored[0],
        listName: list ? list.name || list.url : '',
      });
      res.json({ ok: true, lists: restored });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
