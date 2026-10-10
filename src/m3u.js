'use strict';

/**
 * Parser e serializzatore M3U / M3U8, con supporto al formato esteso
 * "m3u_plus" (Xtream Codes: tvg-id/tvg-name/tvg-logo/group-title, EPG
 * x-tvg-url/url-tvg, direttiva #EXTGRP delle playlist type=m3u).
 * Serve sia per importare i rami "isHost" delle liste WisePlay (che sono vere m3u)
 * sia per produrre la playlist finale esposta dall'addon.
 */

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

/**
 * @param {string} text contenuto grezzo della m3u
 * @param {string} [fallbackGroup] group-title da usare quando assente
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
      // direttiva delle playlist Xtream "type=m3u": vale per il canale successivo
      lastExtGrp = line.slice('#EXTGRP:'.length).trim();
      continue;
    }
    if (line.startsWith('#')) continue; // #EXTVLCOPT, #KODIPROP, commenti...

    // riga URL
    const url = line;
    const meta = pending || {};
    // precedenza: group-title dell'EXTINF, poi #EXTGRP, poi il fallback passato dal chiamante
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
 * Gli URL EPG (XMLTV) dichiarati nell'header della playlist
 * (x-tvg-url e' la forma Kodi/Xtream, url-tvg quella di molte app IPTV;
 * entrambi ammettono piu' URL separati da virgola).
 * @param {object} header attributi della riga #EXTM3U
 * @returns {string[]} URL http(s) unici, nell'ordine in cui compaiono
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
 * Divide "#EXTINF:<durata> attr...,Titolo canale" in testa e titolo.
 * Il separatore e' la prima virgola FUORI dalle virgolette: nelle liste
 * m3u_plus i valori tvg-name/group-title possono contenere virgole
 * (es. group-title="Sport, Calcio"), e non devono spezzare il titolo.
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
  // gli attributi si leggono solo dalla parte prima del titolo: virgolette
  // e coppie chiave="valore" nel nome del canale non devono diventare attributi
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

module.exports = { parseM3U, buildM3U, epgUrlsFromHeader };
