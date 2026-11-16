'use strict';

/**
 * Configuration persistence (JSON file, mountable as a Docker volume).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_ENABLED } = require('./protocols');
const history = require('./history');

const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, '..', 'data', 'config.json');

function defaultListOptions() {
  return {
    enabled: true,
    name: '',
    groupPrefix: 'list', // 'list' | 'none' | 'custom'
    customPrefix: '',
    groupDepth: 1, // how many path parts to use as group-title
    emitLogo: false, // true = use the group icon as tvg-logo when the channel has none
    protocols: { ...DEFAULT_ENABLED },
    aceMode: 'keep', // 'keep' | 'engine' | 'off'
    aceEngineHost: 'http://127.0.0.1:6878',
    dedupe: true,
    excludeKeywords: [],
    disabledPaths: [], // branches (groups with channels) disabled from the configuration page
    renames: {}, // path -> custom branch name
    order: [], // branch order; missing ones go to the end
    disabledChannels: [], // excluded channels, key "path::originalName"
    channelRenames: {}, // "path::originalName" -> new channel name
    channelOrder: {}, // branch path -> [original channel names, in the chosen order]
    channelMoves: {}, // "path::originalName" -> destination: another branch path or "@Name" for custom groups
    inCatalog: true,
    catalogName: '',
    refreshMinutes: 1440, // list refresh: daily by default
    easyProxy: '', // EasyProxy URL: IP or domain (e.g. http://192.168.10.10:7860 or https://proxy.mydomain.com); empty = disabled
    easyProxyPassword: '', // EasyProxy API_PASSWORD (if set)
    easyProxyParams: '', // extra parameters appended to the proxy request (e.g. "warp=off")
  };
}

function defaultConfig() {
  return {
    version: 1,
    rev: 0,
    settings: {
      addonName: 'WiseM3U',
      addonId: 'community.wisem3u',
      cacheTtlMinutes: 1440,
      autoRefreshMinutes: 1440, // default: daily refresh
      maxDepth: 8,
      dedupeGlobal: true,
      fitLogos: true, // rescale channel logos into "contain" posters (endpoint /imgfit)
      userAgent: '', // custom UA for outgoing requests (empty = default)
      streamDiag: false, // stream diagnostics: on-screen error (video) instead of silent buffering
      personalLists: [], // personal lists: channels pulled from all lists [{id,name,includeInMain,channels:["listId::path::name"]}]
      token: '',
      publicBaseUrl: '', // public URL (e.g. https://my.domain with nginx+cert): base for displayed links
      epgUrl: '', // manual XMLTV URL declared in the generated playlist (added to EPGs inherited from m3u_plus sources)
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
  // migration: previous builds used excludePaths for tree selection
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
  // per-channel customizations: keys "path::originalName"
  options.disabledChannels = Array.isArray(options.disabledChannels)
    ? options.disabledChannels.map(String)
    : [];
  options.channelRenames =
    options.channelRenames && typeof options.channelRenames === 'object' && !Array.isArray(options.channelRenames)
      ? Object.fromEntries(Object.entries(options.channelRenames).map(([k, v]) => [k, String(v)]))
      : {};
  // permanent deletions from the page: keys "path::originalName" / branch path
  options.deletedChannels = Array.isArray(options.deletedChannels)
    ? options.deletedChannels.map(String)
    : [];
  options.deletedBranches = Array.isArray(options.deletedBranches)
    ? options.deletedBranches.map(String)
    : [];
  // items whose trash was emptied: they stay deleted but no longer appear
  // in the trash (they can no longer be restored)
  options.purgedChannels = Array.isArray(options.purgedChannels)
    ? options.purgedChannels.map(String)
    : [];
  options.purgedBranches = Array.isArray(options.purgedBranches)
    ? options.purgedBranches.map(String)
    : [];
  options.channelOrder =
    options.channelOrder && typeof options.channelOrder === 'object' && !Array.isArray(options.channelOrder)
      ? Object.fromEntries(
          Object.entries(options.channelOrder).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []])
        )
      : {};
  // channel moves: keys "path::name", value = destination path or "@Group"
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
  // personal list items (composite): { id, src: "listId::path::name|*" , dst? }
  // dst (optional) = path of an existing branch where the channel is nested
  options.personalEntries = Array.isArray(options.personalEntries)
    ? options.personalEntries
        .filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && e.id && typeof e.src === 'string' && e.src.includes('::'))
        .map((e) => ({ id: e.id, src: e.src, ...(typeof e.dst === 'string' && e.dst !== '' ? { dst: e.dst } : {}) }))
    : [];
  // custom (empty) playlists/branches created from the page: names without '@'
  options.customGroups = Array.isArray(options.customGroups)
    ? [...new Set(options.customGroups.map((g) => String(g || '').trim()).filter(Boolean))]
    : [];
  options.groupDepth = Math.max(1, Math.min(6, Number(options.groupDepth) || 1));
  options.easyProxy = String(options.easyProxy || '').trim().replace(/\/+$/, '');
  if (options.easyProxy && !/^https?:\/\//i.test(options.easyProxy)) options.easyProxy = '';
  options.easyProxyPassword = String(options.easyProxyPassword || '').trim();
  options.easyProxyParams = String(options.easyProxyParams || '').trim().replace(/^[?&]+/, '');
  delete options.easyProxyDns; // previous-build option: the URL now accepts IP or domain
  delete options.easyProxyInsecure; // previous-build option: no CA check, the client handles the certificate

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
      // true = the error cannot be fixed by retrying (inherently wrong URL):
      // the UI shows "check the link" instead of "retry with Refresh"
      fatal: !!(list.state && list.state.fatal),
      fetchedAt: (list.state && list.state.fetchedAt) || '',
      stats: (list.state && list.state.stats) || null,
      kind: (list.state && list.state.kind) || '',
      // Xtream account info (expiry): 30 min cache for the configuration badge
      ...(list.state && list.state.xtream ? { xtream: list.state.xtream } : {}),
    },
  };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const settings = { ...base.settings, ...(cfg.settings || {}) };
  // removed field (never checked by any route): it must not remain in
  // old configs after saving
  delete settings.configPassword;
  // custom UA: a single line, no CR/LF (header injection)
  settings.userAgent = String(settings.userAgent || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300);
  settings.publicBaseUrl = String(settings.publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (settings.publicBaseUrl && !/^https?:\/\//i.test(settings.publicBaseUrl)) settings.publicBaseUrl = '';
  // manual EPG: like the public URL, accepts only http(s), otherwise it is cleared
  settings.epgUrl = String(settings.epgUrl || '').trim();
  if (settings.epgUrl && !/^https?:\/\//i.test(settings.epgUrl)) settings.epgUrl = '';
  settings.personalLists = Array.isArray(settings.personalLists)
    ? settings.personalLists
        .filter((p) => p && typeof p === 'object')
        .map((p) => ({
          id: typeof p.id === 'string' && p.id ? p.id : `p_${crypto.randomBytes(4).toString('hex')}`,
          name: String(p.name || '').trim() || 'My list',
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

  /* migration: old "personal lists" (settings.personalLists) become
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
    // renames/overrides from the old model -> customizations of synthetic branches
    // (positional path: the i-th entry becomes branch "i")
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
    // "stable" configuration revision: used to reject UI saves
    // based on stale state (409) instead of overwriting
    rev: Math.max(0, Number(cfg.rev) || 0),
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
          `${CONFIG_FILE} is a DIRECTORY: Docker created it automatically on first ` +
            'startup because the path did not exist on the host. The container entrypoint ' +
            'fixes it automatically; if you see this message, remove the directory ' +
            `("${CONFIG_FILE}") from the volume and restart.`
        );
      }
      cache = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
      return cache;
    }
  } catch (err) {
    console.error('[config] read failed, using defaults:', err.message);
  }
  cache = defaultConfig();
  return cache;
}

function saveConfig(cfg, meta = {}) {
  const next = normalizeConfig(cfg);
  const prev = cache;
  // the revision changes only when the "stable" configuration changes:
  // state updates (fetching/ready/statistics) do not count
  const changed = !prev ||
    JSON.stringify(history.stableConfig(prev)) !== JSON.stringify(history.stableConfig(next));
  next.rev = changed ? ((prev && prev.rev) || 0) + 1 : ((prev && prev.rev) || next.rev || 0);
  if (fs.existsSync(CONFIG_FILE) && fs.statSync(CONFIG_FILE).isDirectory()) {
    throw new Error(
      `${CONFIG_FILE} is a directory, not a file: remove it from the volume and restart the container.`
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
        `Permission denied on ${CONFIG_FILE}: the mounted volume belongs to another user ` +
          '(usually root). Recent images fix permissions automatically at startup: ' +
          'recreate the container with the latest build. Alternatively, on the host volume run ' +
          '"chown -R <uid>:<gid>" on the data folder or start the container as root.'
      );
    }
    throw err;
  }
  cache = next;
  // history snapshot (skipped when only runtime state is updated)
  if (meta.history !== false) history.record(next, meta);
  return cache;
}

/** Updates a list's state without touching the rest (atomic write). */
function updateListState(id, patch) {
  const cfg = loadConfig();
  const list = cfg.lists.find((l) => l.id === id);
  if (!list) return null;
  list.state = { ...list.state, ...patch };
  return saveConfig(cfg, { history: false });
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
