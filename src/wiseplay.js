'use strict';

/**
 * Parser del formato WisePlay (catene JSON servite via link condivisi/accorciati).
 *
 * Nodo radice:
 *   { name, author, image, url, info, groups: [ ... ] }
 *
 * Un nodo gruppo puo' essere:
 *   1) contenitore locale  -> { name, image, groups: [...], stations: [...] }
 *   2) riferimento esterno -> { name, image, url: "...", isHost?: true }
 *      - se l'URL punta a JSON WisePlay  -> ricorsione
 *      - se l'URL punta a una .m3u       -> import dei canali (isHost: true)
 *
 * Una stazione e' { name, image, url } con url = acestream:// | http(s) | rtmp ...
 */

const { parseM3U, epgUrlsFromHeader } = require('./m3u');
const { familyOf, aceHash } = require('./protocols');

const { USER_AGENT } = require('./constants');

const MAX_DEPTH = 8;
const MAX_NODES = 6000;
const MAX_STATIONS = 150000;
const FETCH_TIMEOUT_MS = 20000;
// le sorgenti Xtream/m3u_plus vengono generate dal pannello a ogni richiesta:
// con migliaia di voci (live+VOD+serie) possono richiedere molto piu' dei 20s
// usati per i singoli rami
const ROOT_FETCH_TIMEOUT_MS = 60000;
const ROOT_FETCH_RETRY_DELAY_MS = 1500;
const MAX_BYTES = 60 * 1024 * 1024;
const CONCURRENCY = 32;

/* ------------------------------------------------------------------ */
/* JSON tollerante: molti file WisePlay hanno BOM, virgole finali,      */
/* caratteri di controllo o testo HTML prima/dopo il payload.           */
/* ------------------------------------------------------------------ */

function stripControlChars(s) {
  // mantiene \t \n \r, rimuove gli altri caratteri di controllo non validi in JSON
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function looksLikeJson(s) {
  const t = s.trim();
  return t.startsWith('{') || t.startsWith('[') || /"stations"\s*:|"groups"\s*:/.test(t);
}

function parseLenientJson(raw) {
  let s = String(raw || '').replace(/^\uFEFF/, '');
  s = stripControlChars(s);

  const attempts = [];
  attempts.push(s);

  // estrai la porzione JSON se c'e' rumore intorno (es. HTML)
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) start = Math.min(firstBrace, firstBracket);
  else start = Math.max(firstBrace, firstBracket);
  if (start > 0) {
    const body = s.slice(start);
    const close = body[0] === '{' ? body.lastIndexOf('}') : body.lastIndexOf(']');
    if (close > 0) attempts.push(body.slice(0, close + 1));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      /* next */
    }
  }

  // ultima spiaggia: rimuove le virgole finali (,} oppure ,])
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1'));
    } catch (_) {
      /* next */
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

class FetchError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, application/x-mpegurl, */*',
      },
    });
    if (!res.ok) throw new FetchError(`HTTP ${res.status} per ${url}`, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new FetchError(`Risposta troppo grande (${buf.length} byte)`, res.status);
    return buf.toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

function isM3uText(text) {
  return /^\uFEFF?\s*#EXTM3U/im.test(text) || /#EXTINF\s*:/i.test(text);
}

function guessKind(url, text) {
  if (isM3uText(text)) return 'm3u';
  if (looksLikeJson(text)) return 'json';
  if (/\.m3u8?(\?|$)/i.test(url)) return 'm3u';
  if (/\.json(\?|$)/i.test(url)) return 'json';
  return 'unknown';
}

/**
 * Converte una playlist M3U in un albero WisePlay equivalente: un gruppo per
 * ogni group-title (i canali senza gruppo finiscono in "Generale"), cosi' tutto
 * il resto della pipeline (rami, generi, selezione, output) resta identico.
 */
function m3uToWisePlay(text, rootUrl) {
  const { header, entries } = parseM3U(text, 'Generale');
  const groups = new Map();
  for (const e of entries) {
    const g = (e.group || 'Generale').trim() || 'Generale';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ name: e.name, image: e.logo || '', url: e.url });
  }
  let name = (header.name || header.title || '').toString().trim();
  if (!name) {
    try {
      const u = new URL(rootUrl);
      const base = decodeURIComponent((u.pathname.split('/').filter(Boolean).pop() || ''));
      name = base.replace(/\.m3u8?$/i, '') || u.hostname;
    } catch (_) {
      name = 'Lista M3U';
    }
  }
  return {
    kind: 'm3u',
    name,
    author: 'M3U',
    info:
      `Playlist M3U (${entries.length} canali)` +
      (header['x-tvg-url'] || header['url-tvg'] ? ' · EPG incluso' : ''),
    url: rootUrl,
    // m3u_plus: l'EPG dichiarato dalla sorgente (x-tvg-url/url-tvg) si propaga
    // alla playlist finale generata dall'addon
    epgUrls: epgUrlsFromHeader(header),
    groups: [...groups.entries()].map(([g, stations]) => ({ name: g, stations })),
  };
}

/* ------------------------------------------------------------------ */
/* Costruzione albero                                                  */
/* ------------------------------------------------------------------ */

function makeNode(name, image, info, parentPath, index) {
  return {
    name: (name || 'Senza nome').toString().trim(),
    image: (image || '').toString().trim(),
    info: (info || '').toString().trim(),
    path: parentPath === '' ? String(index) : `${parentPath}.${index}`,
    stations: [],
    children: [],
    sourceUrl: '',
    error: '',
    counts: { groups: 0, stations: 0 },
  };
}

function newCounters() {
  return {
    nodes: 0,
    stations: 0,
    fetched: 0,
    failed: 0,
    external: 0,
    m3u: 0,
    duplicates: 0,
    truncated: false,
  };
}

/**
 * Scarica e normalizza una lista WisePlay partendo dall'URL radice.
 *
 * @param {string} rootUrl URL della lista (link accorciato, gist, php, ...)
 * @param {object} [options]
 * @param {number} [options.maxDepth]
 * @param {(event:object)=>void} [options.onEvent] callback di progresso
 * @returns {Promise<{meta:object, children:Array, stats:object, errors:Array}>}
 */
async function buildTree(rootUrl, options = {}) {
  const maxDepth = options.maxDepth || MAX_DEPTH;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const stats = newCounters();
  const errors = [];

  // Scarica la radice con timeout dedicato e un secondo tentativo automatico:
  // i pannelli Xtream lenti/instabili altrimenti finiscono in "failed to fetch".
  // Gli errori HTTP 4xx (credenziali o URL errati) non vengono riprovati.
  async function fetchRoot() {
    const opts = { ...options, timeout: ROOT_FETCH_TIMEOUT_MS };
    try {
      return await fetchText(rootUrl, opts);
    } catch (err) {
      const status = err && err.status;
      if (status && status >= 400 && status < 500) throw err;
      await new Promise((r) => setTimeout(r, ROOT_FETCH_RETRY_DELAY_MS));
      return fetchText(rootUrl, opts);
    }
  }

  const rootText = await fetchRoot();
  const rootKind = guessKind(rootUrl, rootText);
  let rootJson;
  if (rootKind === 'm3u') {
    rootJson = m3uToWisePlay(rootText, rootUrl);
    stats.m3u += 1;
  } else {
    rootJson = parseLenientJson(rootText);
  }
  if (!rootJson || typeof rootJson !== 'object') {
    // tipico con link Xtream copiati male (es. &amp; al posto di &): il server
    // risponde con una pagina/JSON d'errore. Mostriamo l'inizio della risposta
    // cosi' la causa e' leggibile direttamente nella configurazione.
    const snippet = String(rootText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new FetchError(
      'La risposta non sembra una lista WisePlay o M3U valida' +
        (snippet ? ` — inizio risposta: "${snippet}"` : ''),
      0
    );
  }

  // m3u_plus: URL EPG (XMLTV) ereditati dalle sorgenti m3u, radice e rami;
  // finiscono nell'header della playlist finale generata dall'addon
  const epgUrls = new Set(Array.isArray(rootJson.epgUrls) ? rootJson.epgUrls : []);

  const meta = {
    name: (rootJson.name || 'Lista WisePlay').toString().trim(),
    author: (rootJson.author || '').toString().trim(),
    image: (rootJson.image || '').toString().trim(),
    info: (rootJson.info || '').toString().trim(),
    url: (rootJson.url || rootUrl).toString().trim(),
    kind: rootKind === 'm3u' ? 'm3u' : 'wiseplay',
  };

  const root = makeNode(meta.name, meta.image, meta.info, '', -1);
  root.path = '';
  root.sourceUrl = rootUrl;

  const queue = [];

  async function expand(node, rawNode, depth) {
    if (stats.nodes > MAX_NODES) return;

    const groups = Array.isArray(rawNode.groups) ? rawNode.groups : [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g || typeof g !== 'object') continue;
      if (stats.nodes >= MAX_NODES) break;

      const child = makeNode(g.name, g.image, g.info, node.path, i);
      child.sourceUrl = (g.url || '').toString().trim();
      node.children.push(child);
      stats.nodes++;

      const inlineStations = Array.isArray(g.stations) ? g.stations : [];
      for (const s of inlineStations) pushStation(child, s);

      const inlineGroups = Array.isArray(g.groups) ? g.groups : [];
      if (inlineGroups.length) {
        queue.push({ node: child, raw: g, depth });
        continue;
      }

      if (child.sourceUrl && depth < maxDepth) {
        queue.push({ node: child, raw: g, depth, remote: true });
      }
    }
  }

  function pushStation(target, s) {
    if (!s || typeof s !== 'object') return;
    const url = (s.url || '').toString().trim();
    if (!url) return;
    if (stats.stations >= MAX_STATIONS) {
      stats.truncated = true;
      return;
    }
    // nelle liste reali lo stesso URL compare piu' volte nello stesso gruppo
    const key = url.toLowerCase();
    if (!target._seen) target._seen = new Set();
    if (target._seen.has(key)) {
      stats.duplicates++;
      return;
    }
    target._seen.add(key);
    // nello snapshot finiscono solo i campi essenziali: meno byte da
    // scrivere, comprimere e riparsare (su hardware lento cambia tanto)
    target.stations.push({
      name: (s.name || 'Stream').toString().trim(),
      // solo il logo proprio del canale: l'icona del gruppo resta sul gruppo
      image: (s.image || '').toString().trim(),
      url,
    });
    stats.stations++;
  }

  await expand(root, rootJson, 0);

  // BFS con fetch paralleli: risolve i riferimenti esterni (JSON annidati e m3u)
  async function resolve(job) {
    const { node, raw, depth } = job;

    if (!job.remote) {
      await expand(node, raw, depth);
      return;
    }

    let text;
    try {
      text = await fetchText(node.sourceUrl, options);
      stats.fetched++;
    } catch (err) {
      stats.failed++;
      node.error = err.message || String(err);
      errors.push({ path: node.path, name: node.name, url: node.sourceUrl, error: node.error });
      onEvent({ type: 'error', node: node.name, url: node.sourceUrl, error: node.error });
      return;
    }

    const kind = guessKind(node.sourceUrl, text);

    if (kind === 'm3u') {
      const parsed = parseM3U(text, node.name);
      stats.m3u++;
      for (const e of parsed.entries) {
        pushStation(node, { name: e.name, image: e.logo || '', url: e.url });
      }
      // anche i rami m3u (isHost) possono dichiarare un proprio EPG
      if (epgUrls.size < 50) {
        for (const u of epgUrlsFromHeader(parsed.header)) {
          if (epgUrls.size >= 50) break;
          epgUrls.add(u);
        }
      }
      node.m3uGroups = [...new Set(parsed.entries.map((e) => e.group).filter(Boolean))].slice(0, 20);
      return;
    }

    if (kind === 'json') {
      const sub = parseLenientJson(text);
      if (sub && typeof sub === 'object') {
        stats.external++;
        if (sub.image && !node.image) node.image = sub.image;
        if (sub.info && !node.info) node.info = sub.info;
        if (Array.isArray(sub.stations)) {
          for (const s of sub.stations) pushStation(node, s);
        }
        if (depth + 1 < maxDepth || Array.isArray(sub.stations)) {
          await expand(node, sub, depth + 1);
        }
        return;
      }
      node.error = 'JSON non valido';
      errors.push({ path: node.path, name: node.name, url: node.sourceUrl, error: node.error });
      return;
    }

    node.error = 'Formato non riconosciuto (ne JSON WisePlay ne M3U)';
    errors.push({ path: node.path, name: node.name, url: node.sourceUrl, error: node.error });
  }

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      await resolve(job);
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker);
  await Promise.all(workers);

  // i Set di deduplica non devono finire nello snapshot JSON
  (function clean(node) {
    delete node._seen;
    for (const c of node.children || []) clean(c);
  })(root);

  // conteggi ricorsivi
  function count(node) {
    let groups = node.children.length;
    let stations = node.stations.length;
    for (const c of node.children) {
      const sub = count(c);
      groups += sub.groups;
      stations += sub.stations;
    }
    node.counts = { groups, stations };
    return node.counts;
  }
  count(root);

  meta.epgUrls = [...epgUrls];

  return { meta, children: root.children, stats, errors, root };
}

/** Trova il nodo dato un path tipo "0.2.1". Path vuoto = radice. */
function findByPath(tree, path) {
  if (!path || path === '' || path === 'root') return tree;
  const parts = String(path).split('.').filter((p) => p !== '');
  let node = tree;
  for (const p of parts) {
    const idx = Number(p);
    if (!node.children || !node.children[idx]) return null;
    node = node.children[idx];
  }
  return node;
}

/**
 * Appiattisce i canali rispettando la selezione dei gruppi.
 * @param {object} tree risultato di buildTree()
 * @param {(path:string)=>boolean} isSelected accetta il path del gruppo
 * @param {{maxDepth?:number, prefix?:string|null, joiner?:string, emitLogo?:boolean, renames?:object, disabledChannels?:string[]|Set, channelRenames?:object, channelMoves?:object}} [opts]
 * @returns {Array<{name:string,url:string,logo:string,group:string,genre:string,path:string,idx:number,origName:string,gpath:string}>}
 * genre: il nome del gruppo che contiene direttamente il canale (eventualmente
 * rinominato dalla configurazione) — e' cio' che i client mostrano nei "generi".
 * I singoli canali possono essere esclusi (disabledChannels, chiavi "path::nome"),
 * rinominati (channelRenames, stesse chiavi) o spostati in un altro ramo/gruppo
 * personale (channelMoves: "path::nome" -> path destinazione o "@Nome");
 * idx e path restano quelli originali, cosi' i meta-id continuano a risolvere;
 * gpath e' la destinazione effettiva, usata per ordine e raggruppamento.
 */
function flattenStations(tree, isSelected, opts = {}) {
  const maxDepth = opts.maxDepth == null ? 1 : opts.maxDepth;
  const joiner = opts.joiner || ' › ';
  const prefix = opts.prefix === undefined ? '' : opts.prefix;
  const renames = opts.renames || null;
  const disabledChannels = opts.disabledChannels
    ? opts.disabledChannels instanceof Set
      ? opts.disabledChannels
      : new Set(opts.disabledChannels)
    : null;
  const deletedChannels = opts.deletedChannels
    ? opts.deletedChannels instanceof Set
      ? opts.deletedChannels
      : new Set(opts.deletedChannels)
    : null;
  const deletedBranches = opts.deletedBranches
    ? opts.deletedBranches instanceof Set
      ? opts.deletedBranches
      : new Set(opts.deletedBranches)
    : null;
  const channelRenames = opts.channelRenames || null;
  const moves = opts.channelMoves || null;
  const displayName = (n) => (renames && renames[n.path]) || n.name;
  const out = [];
  const nodeInfo = new Map(); // path -> { dn, label, image } dei rami visitati
  const moved = []; // canali riassegnati: risolti dopo la visita dell'albero

  const groupOf = (label) => (prefix ? `${prefix}${joiner}${label}` : label);

  function pushRow(child, s, i, genre, label, gpath, groupLogo) {
    const ckey = `${child.path}::${s.name}`;
    out.push({
      name: (channelRenames && channelRenames[ckey]) || s.name,
      origName: s.name,
      url: s.url,
      // l'icona del gruppo si usa solo se richiesto esplicitamente
      logo: s.image || (opts.emitLogo ? child.image || '' : ''),
      // icona del gruppo di destinazione: i cataloghi la usano come poster di riserva
      groupLogo: groupLogo != null ? groupLogo : child.image || '',
      group: groupOf(label),
      genre,
      path: child.path,
      idx: i,
      gpath,
    });
  }

  function walk(node, trail, depth) {
    for (const child of node.children || []) {
      // ramo eliminato dalla pagina: nessun canale nativo, ma i canali che ne
      // erano stati spostati fuori restano nella loro playlist di destinazione
      const branchDeleted = !!(deletedBranches && deletedBranches.has(child.path));
      const childTrail = [...trail, displayName(child)];
      const label = childTrail.slice(-maxDepth).join(joiner);
      const dn = displayName(child);
      nodeInfo.set(child.path, { dn, label, image: child.image || '' });
      // un gruppo non selezionato non contribuisce canali, ma i suoi figli
      // possono essere selezionati singolarmente (o ricevere canali spostati):
      // vanno comunque visitati
      if (child.stations && child.stations.length) {
        const selected = isSelected(child.path) && !branchDeleted;
        for (let i = 0; i < child.stations.length; i++) {
          const s = child.stations[i];
          const ckey = `${child.path}::${s.name}`;
          if (disabledChannels && disabledChannels.has(ckey)) continue;
          if (deletedChannels && deletedChannels.has(ckey)) continue;
          const target = moves && moves[ckey];
          if (target && target !== child.path) {
            moved.push({ child, s, i, target });
            continue;
          }
          if (selected) pushRow(child, s, i, dn, label, child.path, null);
        }
      }
      walk(child, childTrail, depth + 1);
    }
  }

  walk(tree, [], 0);

  // canali spostati: genre/gruppo della destinazione, identita' (path+idx) originale
  for (const m of moved) {
    const t = m.target;
    if (deletedBranches && deletedBranches.has(t)) continue; // destinazione eliminata
    if (t.startsWith('@')) {
      const name = (renames && renames[t]) || t.slice(1) || 'Gruppo personale';
      pushRow(m.child, m.s, m.i, name, name, t, '');
      continue;
    }
    const info = nodeInfo.get(t);
    if (!info || !isSelected(t)) continue; // destinazione inesistente o disattivata
    if (deletedBranches && deletedBranches.has(t)) continue; // destinazione eliminata
    pushRow(m.child, m.s, m.i, info.dn, info.label, t, info.image || '');
  }

  return out;
}

/** Nomi dei nodi lungo un path (per calcolare il genere di un canale). */
function pathNames(tree, path) {
  const names = [];
  let node = tree;
  for (const p of String(path || '').split('.').filter((x) => x !== '')) {
    node = (node.children || [])[Number(p)];
    if (!node) break;
    names.push(node.name);
  }
  return names;
}

/** Accorcia gli URL lunghi (gist) per non appesantire il payload della UI. */
function shortUrl(u) {
  const s = String(u || '');
  if (s.length <= 90) return s;
  try {
    const parsed = new URL(s);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return `${parsed.host}/…/${last.slice(-28)}`;
  } catch (_) {
    return `${s.slice(0, 40)}…${s.slice(-20)}`;
  }
}

/** Versione dell'albero serializzabile (e leggera) per la UI di configurazione. */
function treeForUi(tree, opts = {}) {
  const maxDepth = opts.maxDepth || 8;

  function map(node, depth) {
    const item = {
      name: node.name,
      path: node.path,
      image: depth <= 1 ? node.image : '',
      info: depth <= 1 ? shortUrl(node.info) : '',
      sourceUrl: shortUrl(node.sourceUrl),
      error: node.error,
      stations: node.stations.length,
      counts: node.counts,
      protocols: countProtocols(node.stations),
      children: [],
    };
    if (depth < maxDepth) item.children = (node.children || []).map((c) => map(c, depth + 1));
    return item;
  }

  return {
    meta: tree.meta,
    children: (tree.children || []).map((c) => map(c, 0)),
    stats: tree.stats,
    errors: (tree.errors || []).slice(0, 25),
    errorsTotal: (tree.errors || []).length,
  };
}

function countProtocols(stations) {
  const acc = { http: 0, ace: 0, rtmp: 0, rtsp: 0, other: 0 };
  for (const s of stations || []) {
    const f = s.family || familyOf(s.url);
    acc[f] = (acc[f] || 0) + 1;
  }
  return acc;
}

module.exports = {
  buildTree,
  findByPath,
  flattenStations,
  pathNames,
  treeForUi,
  parseLenientJson,
  fetchText,
  isM3uText,
  guessKind,
  FetchError,
};
