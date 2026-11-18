'use strict';

const streamdiag = require('../streamdiag');
const { normalizeSourceUrl } = require('../urls');

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

/** Builds the middleware protecting admin endpoints with ADMIN_TOKEN. */
function createRequireAdmin(adminToken) {
  return function requireAdmin(req, res, next) {
    if (!adminToken) return next();
    if (tokenOf(req) === adminToken) return next();
    return res.status(401).json({ error: 'invalid ADMIN_TOKEN' });
  };
}

/** Absolute base URL derived from the incoming request. */
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/** Rewrites a stream URL through the diagnostic proxy when enabled. */
function diagStreamUrl(cfg, req, url, name, listName) {
  if (!cfg.settings.streamDiag) return url;
  return streamdiag.diagUrl(baseUrl(req).replace(/\/+$/, ''), url, name, listName);
}

/**
 * List URL pasted from an HTML page/message: `&` often becomes `&amp;`
 * (or `&#38;`) and Xtream receives wrong parameters. Always normalize on input.
 */
function sanitizeListUrl(url) {
  return normalizeSourceUrl(url);
}

module.exports = {
  tokenOf,
  clientInfo,
  createRequireAdmin,
  baseUrl,
  diagStreamUrl,
  sanitizeListUrl,
};
