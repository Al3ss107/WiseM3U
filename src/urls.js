'use strict';

/**
 * Small URL normalization shared by the configuration, the fetcher and the
 * EPG module. Kept dependency-free to avoid config <-> HTTP cycles.
 */

/** `&amp;` / `&#38;` copied from an HTML page become a real `&`. */
function decodeHtmlAmp(url) {
  return String(url == null ? '' : url)
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#0?38;/gi, '&');
}

/**
 * GitHub's normal file page is HTML; the actual file is on
 * raw.githubusercontent.com. Users naturally copy the address bar, so convert
 * it instead of importing the HTML page as a playlist.
 */
function githubRawUrl(value) {
  const url = String(value || '').trim();
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i.exec(url);
  if (!m) return url;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
}

/** Normalizes a user-supplied list/EPG URL without changing other schemes. */
function normalizeSourceUrl(value) {
  return githubRawUrl(decodeHtmlAmp(value));
}

module.exports = { decodeHtmlAmp, githubRawUrl, normalizeSourceUrl };
