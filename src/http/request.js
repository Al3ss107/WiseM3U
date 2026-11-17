'use strict';

const store = require('../config');
const streamdiag = require('../streamdiag');

/** Token from query string or headers. */
function tokenOf(req) {
  return (req.query.token || req.query.access_token || req.headers['x-access-token'] || '').toString();
}

/** Client identification for live logs (ip + user-agent). */
function clientInfo(req) {
  return {
    ip: (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '')
      .toString().split(',')[0].trim(),
    ua: (req.headers['user-agent'] || '').toString().slice(0, 160),
  };
}

/** Middleware protecting client-facing endpoints with the configured token. */
function requireToken(req, res, next) {
  const expected = store.loadConfig().settings.token;
  if (!expected) return next();
  if (tokenOf(req) === expected) return next();
  return res.status(401).json({ error: 'missing or invalid token' });
}

/** Builds the middleware protecting admin endpoints with ADMIN_TOKEN. */
function createRequireAdmin(adminToken) {
  return function requireAdmin(req, res, next) {
    if (!adminToken) return next();
    if (tokenOf(req) === adminToken) return next();
    return res.status(401).json({ error: 'invalid ADMIN_TOKEN' });
  };
}

/** Appends the configured token to an absolute URL. */
function withToken(url, req) {
  const token = store.loadConfig().settings.token;
  if (!token) return url;
  return url.includes('?')
    ? `${url}&token=${encodeURIComponent(token)}`
    : `${url}?token=${encodeURIComponent(token)}`;
}

/** Absolute base URL derived from the incoming request. */
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/** Preferred public base (public URL in settings), otherwise from the request. */
function publicBase(req, cfg) {
  const configured = ((cfg && cfg.settings && cfg.settings.publicBaseUrl) || '').trim();
  return (configured || baseUrl(req)).replace(/\/+$/, '');
}

/** Rewrites a stream URL through the diagnostic proxy when enabled. */
function diagStreamUrl(cfg, req, url, name, listName) {
  if (!cfg.settings.streamDiag) return url;
  return streamdiag.diagUrl(publicBase(req, cfg), cfg.settings.token || '', url, name, listName);
}

/**
 * List URL pasted from an HTML page/message: `&` often becomes `&amp;`
 * (or `&#38;`) and Xtream receives wrong parameters. Always normalize on input.
 */
function sanitizeListUrl(url) {
  return String(url || '')
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#0?38;/gi, '&');
}

module.exports = {
  tokenOf,
  clientInfo,
  requireToken,
  createRequireAdmin,
  withToken,
  baseUrl,
  publicBase,
  diagStreamUrl,
  sanitizeListUrl,
};
