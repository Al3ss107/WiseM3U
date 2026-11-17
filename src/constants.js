'use strict';

/**
 * Shared addon constants: a single place for version, user-agent, limits and
 * timeouts used by multiple modules (no scattered hardcoding).
 *
 * Custom User-Agent: some panels/CDNs block the WiseM3U string (403). Each
 * list can carry its own UA (browser, VLC, the app the user usually uses):
 * it applies to that list's downloads, Xtream panel and logos.
 * Empty = default.
 */

const pkg = require('../package.json');

/** Default UA for "data" requests (lists, JSON, Xtream). */
const DEFAULT_USER_AGENT =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/126.0 Safari/537.36 WiseM3U/${pkg.version}`;

/** Default UA for logos: no WiseM3U suffix because CDNs behind Cloudflare
 *  workers (vavoo, Rakuten, Pluto...) treat it as a bot. */
const DEFAULT_IMG_USER_AGENT =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/126.0.0.0 Safari/537.36`;

/** Normalizes a user-written UA: a single line, no CR/LF (header
 *  injection), reasonable length. */
function sanitizeUserAgent(ua) {
  const s = String(ua == null ? '' : ua)
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s.slice(0, 300);
}

/** UA for lists/JSON/Xtream: the list-specific UA when set. */
function getUserAgent(custom = '') {
  return sanitizeUserAgent(custom) || DEFAULT_USER_AGENT;
}

/** UA for logos: the list-specific UA when set, otherwise the "clean" one. */
function getImgUserAgent(custom = '') {
  return sanitizeUserAgent(custom) || DEFAULT_IMG_USER_AGENT;
}

module.exports = {
  /** Release semver version (source of truth: package.json). */
  VERSION: pkg.version,

  /** Defaults exported as constants (for the "factory" value).
   *  For real requests use getUserAgent()/getImgUserAgent(). */
  USER_AGENT: DEFAULT_USER_AGENT,
  IMG_USER_AGENT: DEFAULT_IMG_USER_AGENT,

  sanitizeUserAgent,
  getUserAgent,
  getImgUserAgent,

  /** JSON body limit accepted by the APIs (the config can be large). */
  JSON_BODY_LIMIT: '4mb',

  /** Timeout for the EasyProxy /api/info check (Test button). */
  EP_INFO_TIMEOUT_MS: 6000,

  /** Timeout for the EasyProxy test proxy (download of a real stream). */
  EP_PROXY_TIMEOUT_MS: 15000,

  /** Cache-Control for manifest and catalogs: clients refetch less, and
   *  configuration changes become visible within a minute. */
  PUBLIC_CACHE_CONTROL: 'public, max-age=60',

  /** Responses below this size are not compressed. */
  COMPRESSION_THRESHOLD: 1024,
};
