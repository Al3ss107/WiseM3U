'use strict';

/**
 * M3U / M3U8 parser and serializer, with support for the extended
 * "m3u_plus" format (Xtream Codes: tvg-id/tvg-name/tvg-logo/group-title, EPG
 * x-tvg-url/url-tvg, #EXTGRP directive of type=m3u playlists).
 * Used both to import "isHost" branches of WisePlay lists (real m3u files)
 * and to produce the final playlist exposed by the addon.
 */

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

/**
 * @param {string} text raw m3u content
 * @param {string} [fallbackGroup] group-title to use when missing
 * @returns {{header: object, entries: Array}}
 */
function parseM3U(text, fallbackGroup = '') {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  const entries = [];
  let header = {};
  let pending = null;
  let lastExtGrp = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) {
      header = parseAttrs(line);
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      pending = parseExtInf(line);
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      // Xtream "type=m3u" playlist directive: applies to the next channel
      lastExtGrp = line.slice('#EXTGRP:'.length).trim();
      continue;
    }
    if (line.startsWith('#')) continue; // #EXTVLCOPT, #KODIPROP, commenti...

    // URL line
    const url = line;
    const meta = pending || {};
    // precedence: EXTINF group-title, then #EXTGRP, then the caller fallback
    const groupTitle = (meta['group-title'] || lastExtGrp || fallbackGroup || '').trim();
    entries.push({
      name: (meta.title || '').trim() || url,
      url,
      logo: (meta['tvg-logo'] || meta.logo || '').trim(),
      group: groupTitle,
      tvgId: (meta['tvg-id'] || '').trim(),
      tvgName: (meta['tvg-name'] || '').trim(),
      duration: meta.duration != null ? meta.duration : -1,
    });
    pending = null;
    lastExtGrp = '';
  }

  return { header, entries };
}

/**
 * EPG (XMLTV) URLs declared in the playlist header
 * (x-tvg-url is the Kodi/Xtream form, url-tvg the one used by many IPTV apps;
 * both allow multiple comma-separated URLs).
 * @param {object} header attributes of the #EXTM3U line
 * @returns {string[]} unique http(s) URLs, in order of appearance
 */
function epgUrlsFromHeader(header) {
  const raw = header && (header['url-tvg'] || header['x-tvg-url']);
  if (!raw) return [];
  const seen = new Set();
  for (const u of String(raw).split(',').map((s) => s.trim())) {
    if (/^https?:\/\//i.test(u)) seen.add(u);
  }
  return [...seen];
}

function parseAttrs(line) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(line)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

/**
 * Splits "#EXTINF:<duration> attr...,Channel title" into head and title.
 * The separator is the first comma OUTSIDE quotes: in m3u_plus lists
 * tvg-name/group-title values may contain commas
 * (e.g. group-title="Sport, Football"), and must not split the title.
 */
function splitExtInf(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && !inQuote) {
      return { head: line.slice(0, i), title: line.slice(i + 1).trim() };
    }
  }
  return { head: line, title: '' };
}

function parseExtInf(line) {
  const { head, title } = splitExtInf(line);
  // attributes are read only from the part before the title: quotes
  // and key="value" pairs in the channel name must not become attributes
  const attrs = parseAttrs(head);
  const durMatch = head.match(/#EXTINF:\s*(-?[\d.]+)/);
  return { ...attrs, title, duration: durMatch ? Number(durMatch[1]) : -1 };
}

function escAttr(v) {
  return String(v == null ? '' : v).replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
}

/**
 * @param {Array<{name:string,url:string,logo?:string,group?:string,tvgId?:string}>} entries
 * @param {{header?:object, name?:string}} [opts]
 * @returns {string}
 */
function buildM3U(entries, opts = {}) {
  const out = [];
  const headerAttrs = { ...(opts.header || {}) };
  let headerLine = '#EXTM3U';
  const keys = Object.keys(headerAttrs);
  if (keys.length) {
    headerLine += ' ' + keys.map((k) => `${k}="${escAttr(headerAttrs[k])}"`).join(' ');
  }
  out.push(headerLine);
  if (opts.name) out.push(`# Playlist generata da WiseM3U - ${opts.name} - ${new Date().toISOString()}`);

  for (const e of entries) {
    if (!e || !e.url) continue;
    const attrs = [];
    if (e.tvgId) attrs.push(`tvg-id="${escAttr(e.tvgId)}"`);
    if (e.name) attrs.push(`tvg-name="${escAttr(e.name)}"`);
    if (e.logo) attrs.push(`tvg-logo="${escAttr(e.logo)}"`);
    attrs.push(`group-title="${escAttr(e.group || '')}"`);
    const duration = e.duration == null || Number.isNaN(Number(e.duration)) ? -1 : Number(e.duration);
    out.push(`#EXTINF:${duration} ${attrs.join(' ')},${escAttr(e.name || '')}`);
    out.push(e.url);
  }

  return out.join('\n') + '\n';
}

module.exports = { parseM3U, buildM3U, epgUrlsFromHeader, parseAttrs, parseExtInf };
