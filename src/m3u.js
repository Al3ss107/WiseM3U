'use strict';

/**
 * Parser e serializzatore M3U / M3U8.
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
    if (line.startsWith('#')) continue; // #EXTVLCOPT, #KODIPROP, commenti...

    // riga URL
    const url = line;
    const meta = pending || {};
    const groupTitle = (meta['group-title'] || fallbackGroup || '').trim();
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
  }

  return { header, entries };
}

function parseAttrs(line) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(line)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function parseExtInf(line) {
  const attrs = parseAttrs(line);
  // #EXTINF:-1 tvg-logo="..." group-title="...",Nome canale
  const commaIdx = line.indexOf(',');
  const title = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
  const head = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
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

module.exports = { parseM3U, buildM3U };
