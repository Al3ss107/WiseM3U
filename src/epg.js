'use strict';

/**
 * XMLTV guide support for the Stremio/Nuvio addon.
 *
 * The generated M3U already declares its EPG header, but addon clients never
 * read that file: they only see manifest/catalog/meta JSON. This module turns
 * a configured XMLTV URL into:
 *   - channel matching by tvg-id, tvg-name and (normalized) channel name;
 *   - `meta.videos` programmes with startTime/endTime (Stremio Native EPG);
 *   - a short Now/Next line in descriptions, which is also visible in Nuvio.
 *
 * The guide is cached in RAM for a few minutes: one download serves every
 * channel detail, guide page and search request.
 */

const cache = require('./cache');
const { fetchText } = require('./wiseplay');
const { getUserAgent } = require('./constants');
const { normalizeSourceUrl } = require('./urls');

const TTL_MS = 15 * 60 * 1000;
const MAX_URLS = 4;
const MAX_GUIDES = 4;
const MAX_PROGRAMMES = 100000;
const FETCH_TIMEOUT_MS = 30000;

// One cached guide per effective URL set: lists can use different EPGs.
const guides = new Map(); // key -> { guide, fetchedAt, error }
const inflight = new Map(); // key -> promise

/** Accepts only http(s), and rewrites GitHub "blob" links to the raw file. */
function cleanUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    const u = new URL(normalizeSourceUrl(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

/**
 * Effective XMLTV URLs for one list, in priority order:
 *   1. the list's own EPG;
 *   2. the general setting;
 *   3. the EPGs declared by the source (detected while downloading it).
 * `detected` lets callers pass the URLs already in hand and avoid touching
 * the cache; otherwise they are read from the memory-only cache accessor.
 */
function effectiveUrls(config, list, detected = null) {
  const own = cleanUrl(list && list.options && list.options.epgUrl);
  if (own) return [own];
  const fallback = cleanUrl(config && config.settings && config.settings.epgUrl);
  if (fallback) return [fallback];
  const inherited = detected || (list ? cache.epgUrls(list.id) : []);
  const out = [];
  for (const value of inherited) {
    const clean = cleanUrl(value);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, MAX_URLS);
}

/** All effective URLs of the enabled lists (union, no duplicates). */
function sourceUrls(config, list, detected = null) {
  if (list) return effectiveUrls(config, list, detected);
  const out = [];
  for (const item of (config && config.lists) || []) {
    if (!item.options || !item.options.enabled) continue;
    for (const url of effectiveUrls(config, item)) {
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}

/** With a list, tells whether that list has a usable guide. */
function hasEpg(config, list) {
  return (list ? effectiveUrls(config, list) : sourceUrls(config)).length > 0;
}

function codePoint(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => codePoint(parseInt(n, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    }[name.toLowerCase()]));
}

function attr(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(attrs || '');
  return m ? decodeEntities(m[1]).trim() : '';
}

function tagText(body, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(body || '');
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** XMLTV time: YYYYMMDDHHMMSS[ +ZZZZ] (seconds/minutes optional). */
function parseTime(value) {
  const m = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{4})?$/);
  if (!m) return 0;
  const [y, mo, d, h = '0', mi = '0', s = '0'] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => x || '0');
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    const mins = Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3, 5));
    ms -= sign * mins * 60000;
  }
  return Number.isFinite(ms) ? ms : 0;
}

/** Lowercase, strip accents/brackets/quality suffixes and punctuation. */
function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\.(?:it|com|net|org|tv)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(?:hd|fhd|uhd|4k|8k|sd|h265|h264|hevc)$/g, '');
}

function parseXmltv(text) {
  const channels = new Map(); // id -> { id, name, programmes: [] }
  const display = new Map(); // guide id -> display name

  const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let m;
  while ((m = channelRe.exec(text)) !== null) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    const name = tagText(m[2], 'display-name') || id;
    if (!display.has(id)) display.set(id, name);
  }

  let count = 0;
  const programmeRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  while ((m = programmeRe.exec(text)) !== null) {
    if (count >= MAX_PROGRAMMES) break;
    const attrs = m[1];
    const channel = attr(attrs, 'channel');
    const start = parseTime(attr(attrs, 'start'));
    const stop = parseTime(attr(attrs, 'stop'));
    if (!channel || !start || !stop || stop <= start) continue;
    const title = tagText(m[2], 'title');
    if (!title) continue;
    let ch = channels.get(channel);
    if (!ch) {
      ch = { id: channel, name: display.get(channel) || channel, programmes: [] };
      channels.set(channel, ch);
    }
    const iconMatch = /<icon\b[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(m[2]);
    const category = tagText(m[2], 'category');
    const episode = tagText(m[2], 'episode-num');
    ch.programmes.push({
      title,
      start,
      stop,
      description: tagText(m[2], 'desc'),
      icon: iconMatch ? decodeEntities(iconMatch[1]).trim() : '',
      category,
      episode,
    });
    count++;
  }

  // merge duplicate channel ids and drop zero-length/duplicate rows
  for (const [id, ch] of channels) {
    if (!display.has(id)) display.set(id, ch.name);
    ch.programmes.sort((a, b) => a.start - b.start || a.stop - b.stop);
    const seen = new Set();
    ch.programmes = ch.programmes.filter((p) => {
      const key = `${p.start}|${p.stop}|${p.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (!channels.size) return null;

  // alias index: raw XMLTV id, normalized id, display name and its core form
  const aliases = new Map();
  const put = (key, ch) => {
    if (!key) return;
    const old = aliases.get(key);
    if (!old || ch.programmes.length > old.programmes.length) aliases.set(key, ch);
  };
  for (const ch of channels.values()) {
    put(ch.id.toLowerCase(), ch);
    put(normalizeKey(ch.id), ch);
    put(normalizeKey(ch.name), ch);
  }

  return {
    channels,
    aliases,
    display,
    fetchedAt: Date.now(),
    programmes: count,
  };
}

/** Finds the guide channel for a station/meta row. */
function match(guide, channel) {
  if (!guide || !channel) return null;
  const candidates = [channel.tvgId, channel.tvgName, channel.name]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  for (const value of candidates) {
    const hit = guide.aliases.get(value.toLowerCase()) || guide.aliases.get(normalizeKey(value));
    if (hit) return hit;
  }
  return null;
}

function programmesBetween(guide, channel, from, to) {
  const hit = match(guide, channel);
  if (!hit) return [];
  return hit.programmes.filter((p) => p.stop > from && p.start < to);
}

/** Current and next programme, used for meta descriptions. */
function nowNext(guide, channel, now = Date.now()) {
  const hit = match(guide, channel);
  if (!hit) return { now: null, next: null };
  let currentProgramme = null;
  let next = null;
  for (const p of hit.programmes) {
    if (p.start <= now && p.stop > now) currentProgramme = p;
    else if (p.start > now && (!next || p.start < next.start)) next = p;
  }
  return { now: currentProgramme, next };
}

function descriptionLine(guide, channel, now = Date.now()) {
  const { now: currentProgramme, next } = nowNext(guide, channel, now);
  const lines = [];
  if (currentProgramme) lines.push(`Now: ${currentProgramme.title}`);
  if (next) lines.push(`Next: ${next.title}`);
  return lines.join('\n');
}

/** Converts a guide programme to a Stremio Native EPG video. */
function toVideo(channelId, programme, now = Date.now()) {
  const minutes = Math.max(1, Math.round((programme.stop - programme.start) / 60000));
  return {
    id: `${channelId}:epg:${new Date(programme.start).toISOString()}`,
    title: programme.title,
    released: new Date(programme.start).toISOString(),
    startTime: new Date(programme.start).toISOString(),
    endTime: new Date(programme.stop).toISOString(),
    overview: programme.description || undefined,
    thumbnail: programme.icon || undefined,
    runtime: `${minutes} min`,
    genres: programme.category ? [programme.category] : undefined,
    releaseInfo: programme.episode || undefined,
  };
}

function buildGuide(channels) {
  if (!channels.size) return null;
  const aliases = new Map();
  const display = new Map();
  let programmes = 0;
  for (const ch of channels.values()) {
    display.set(ch.id, ch.name);
    ch.programmes.sort((a, b) => a.start - b.start || a.stop - b.stop);
    programmes += ch.programmes.length;
    const put = (key) => {
      if (!key) return;
      const old = aliases.get(key);
      if (!old || ch.programmes.length > old.programmes.length) aliases.set(key, ch);
    };
    put(ch.id.toLowerCase());
    put(normalizeKey(ch.id));
    put(normalizeKey(ch.name));
  }
  return { channels, aliases, display, fetchedAt: Date.now(), programmes };
}

async function downloadGuide(urls) {
  const results = await Promise.allSettled(
    urls.map((url) => fetchText(url, { timeout: FETCH_TIMEOUT_MS, userAgent: getUserAgent() }))
  );
  const merged = new Map();
  const errors = [];
  results.forEach((res, i) => {
    if (res.status === 'rejected') {
      errors.push(`${urls[i]}: ${res.reason && res.reason.message ? res.reason.message : res.reason}`);
      return;
    }
    const guide = parseXmltv(res.value);
    if (!guide) {
      errors.push(`${urls[i]}: no programmes`);
      return;
    }
    for (const ch of guide.channels.values()) {
      let dst = merged.get(ch.id);
      if (!dst) {
        dst = { id: ch.id, name: ch.name, programmes: [] };
        merged.set(ch.id, dst);
      }
      dst.programmes.push(...ch.programmes);
    }
  });
  return { guide: buildGuide(merged), errors };
}

/** Cached guide for the effective URL set of one list (or of all lists). */
async function getGuide(config, list = null) {
  const urls = sourceUrls(config, list);
  if (!urls.length) return null;
  const key = urls.join('\n');
  const now = Date.now();

  const cached = guides.get(key);
  if (cached && now - cached.fetchedAt < TTL_MS) return cached.guide;
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    const { guide, errors } = await downloadGuide(urls);
    if (!guide) {
      // keep the previous guide (if any) and retry after a minute instead of
      // downloading a broken URL on every channel request
      const previous = guides.get(key);
      guides.delete(key);
      guides.set(key, {
        guide: previous ? previous.guide : null,
        fetchedAt: Date.now() - TTL_MS + 60 * 1000,
        error: errors.join('; '),
      });
      if (errors.length) console.warn('[epg] guide unavailable:', errors.join('; ').slice(0, 400));
      return previous ? previous.guide : null;
    }
    guides.delete(key);
    guides.set(key, { guide, fetchedAt: Date.now(), error: '' });
    if (errors.length) console.warn('[epg] partial guide:', errors.join('; ').slice(0, 400));
    // Keep only the most recently used guides: each one can be several MB.
    while (guides.size > MAX_GUIDES) guides.delete(guides.keys().next().value);
    return guide;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/** Non-blocking cache read for catalogs (never starts a download). */
function peekGuide(config, list = null) {
  const urls = sourceUrls(config, list);
  if (!urls.length) return null;
  const cached = guides.get(urls.join('\n'));
  if (!cached || Date.now() - cached.fetchedAt >= TTL_MS) return null;
  return cached.guide;
}

/** Starts background downloads when none are cached (boot, refresh, save). */
function warmGuide(config, list = null) {
  if (list) {
    if (peekGuide(config, list)) return;
    getGuide(config, list).catch((err) => {
      console.warn('[epg] warm-up failed:', err && err.message ? err.message : err);
    });
    return;
  }
  const keys = new Set();
  for (const item of (config && config.lists) || []) {
    if (!item.options || !item.options.enabled) continue;
    const urls = sourceUrls(config, item);
    const key = urls.join('\n');
    if (!key || keys.has(key)) continue;
    keys.add(key);
    if (peekGuide(config, item)) continue;
    getGuide(config, item).catch((err) => {
      console.warn('[epg] warm-up failed:', err && err.message ? err.message : err);
    });
  }
}

/** Drops the cache (used by tests; configuration changes use a new key). */
function invalidate() {
  guides.clear();
  inflight.clear();
}

module.exports = {
  effectiveUrls,
  hasEpg,
  getGuide,
  peekGuide,
  warmGuide,
  match,
  programmesBetween,
  descriptionLine,
  toVideo,
  parseXmltv,
  invalidate,
  cleanUrl,
  __test: { cleanUrl, decodeEntities, MAX_URLS },
};
