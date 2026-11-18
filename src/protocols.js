'use strict';

/**
 * Protocol handling for streams found in WisePlay lists.
 *
 * In the real files analyzed we see:
 *   acestream://<hash>                                   -> AceStream P2P
 *   http://127.0.0.1:6878/ace/getstream?id=<hash>        -> local AceStream Engine
 *   http/https (m3u8, ts, php proxy, pluto, ...)         -> direct HTTP
 *   rtmp / rtsp / mms / udp / rtp                        -> legacy
 */

const DEFAULT_ENABLED = { http: true, ace: false, rtmp: false, rtsp: false, other: false };

function schemeOf(url) {
  if (typeof url !== 'string') return '';
  const m = url.trim().match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return m ? m[1].toLowerCase() : '';
}

/** Protocol family used by the UI filters. */
function familyOf(url) {
  const s = schemeOf(url);
  if (s === 'http' || s === 'https') return 'http';
  if (s === 'acestream') return 'ace';
  if (s === 'rtmp' || s === 'rtmps' || s === 'rtmpe') return 'rtmp';
  if (s === 'rtsp' || s === 'rtsps') return 'rtsp';
  return 'other';
}

function isAceEngineUrl(url) {
  if (typeof url !== 'string') return false;
  return /\/ace\/getstream/i.test(url) || /webui\/ace\/getstream/i.test(url);
}

/** acestream://hash or http://127.0.0.1:6878/ace/getstream?id=hash */
function aceHash(url) {
  if (typeof url !== 'string') return null;
  let m = url.trim().match(/^acestream:\/\/([0-9a-fA-F]{20,64})/);
  if (m) return m[1].toLowerCase();
  m = url.trim().match(/[?&]id=([0-9a-fA-F]{20,64})/i);
  if (m && isAceEngineUrl(url)) return m[1].toLowerCase();
  return null;
}

/**
 * Normalizes the URL based on the list options.
 * aceMode: 'off' (scarta) | 'keep' (acestream://) | 'engine' (http://host/ace/getstream?id=)
 */
function normalizeStreamUrl(rawUrl, options = {}) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) return null;

  const fam = familyOf(url);
  const proto = options.protocols ? { ...DEFAULT_ENABLED, ...options.protocols } : { ...DEFAULT_ENABLED };

  const hash = aceHash(url);
  if (hash) {
    const mode = options.aceMode || 'keep';
    if (mode === 'off' || !proto.ace) return null;
    if (mode === 'engine') {
      const engine = normalizeEngineHost(options.aceEngineHost);
      return `${engine}/ace/getstream?id=${hash}`;
    }
    return `acestream://${hash}`;
  }

  if (!proto[fam]) return null;
  return url;
}

function normalizeEngineHost(host) {
  let h = (host || '').trim();
  if (!h) h = 'http://127.0.0.1:6878';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '');
}

/** Human-readable label for the UI / stream badges. */
function protocolBadge(url) {
  const fam = familyOf(url);
  if (fam === 'ace') return 'ACE';
  if (fam === 'http') return /\.m3u8(\?|$)/i.test(url) ? 'HLS' : 'HTTP';
  return fam.toUpperCase() || '?';
}

module.exports = {
  DEFAULT_ENABLED,
  familyOf,
  normalizeStreamUrl,
  protocolBadge,
};
