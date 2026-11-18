'use strict';

/**
 * Xtream account info: from a get.php URL with username/password it reads the
 * panel information via /player_api.php (expiry, status, connections).
 * Used to show list expiry on the configuration page.
 */

const { nodeFetchText, resolveViaPublicDns } = require('./wiseplay');
const { getUserAgent } = require('./constants');

const PANEL_TIMEOUT_MS = 8000;

/** True if the URL points to an Xtream panel with credentials in clear text. */
function xtreamInfo(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }
  if (!/\/get\.php/i.test(u.pathname)) return null;
  const username = u.searchParams.get('username') || '';
  const password = u.searchParams.get('password') || '';
  if (!username || !password) return null;
  return {
    origin: u.origin,
    username,
    password,
    panelApi: `${u.origin}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  };
}

/**
 * Downloads /player_api.php reusing the same list-download recovery
 * (http on an https port, self-signed TLS, public DNS). Never throws:
 * returns {ok:false, reason} on problems.
 */
async function fetchPanelInfo(url, userAgent = '') {
  const info = xtreamInfo(url);
  if (!info) return { ok: false, reason: 'not an Xtream URL (username/password missing in get.php)' };

  // targeted retry claims (like fetchRoot in wiseplay)
  async function tryFetch(target) {
    try {
      return await fetchText(target, userAgent);
    } catch (err) {
      const causeRef = (err && err.causeRef) || {};
      const causeStr = `${causeRef.code || ''} ${causeRef.message || ''} ${(err && err.message) || ''}`;
      if (/ERR_SSL_WRONG_VERSION_NUMBER/i.test(causeStr)) {
        const down = target.replace(/^https:\/\//i, 'http://');
        if (down !== target) return fetchText(down, userAgent);
      }
      if (err && err.certError) return nodeFetchText(target, { insecure: true, timeout: PANEL_TIMEOUT_MS, userAgent });
      if (/ENOTFOUND|EAI_AGAIN/i.test(causeRef.code || '')) {
        let ip = null;
        try { ip = await resolveViaPublicDns(new URL(target).hostname); } catch (_) { ip = null; }
        if (ip) return nodeFetchText(target, { ip, timeout: PANEL_TIMEOUT_MS, userAgent });
      }
      throw err;
    }
  }

  let raw;
  try {
    raw = await tryFetch(info.panelApi);
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
  let j;
  try { j = JSON.parse(raw); } catch (_) {
    return { ok: false, reason: 'non-JSON response from player_api.php' };
  }
  const ui = j.user_info || {};
  const exp = Number(ui.exp_date) || 0; // unix seconds
  const expiryIso = exp > 0 ? new Date(exp * 1000).toISOString() : null;
  const daysLeft = exp > 0 ? Math.ceil((exp * 1000 - Date.now()) / 86400000) : null;
  const statusRaw = String(ui.status || '').trim();
  return {
    ok: true,
    user: {
      status: statusRaw || '—',
      active: /active|attivo/i.test(statusRaw) || !statusRaw,
      expiryIso,
      daysLeft,
      expired: daysLeft != null && daysLeft < 0,
      maxConnections: Number(ui.max_connections) || 0,
      activeConnections: Number(ui.active_cons) || 0,
      isTrial: String(ui.is_trial) === '1',
    },
    fetchedAt: new Date().toISOString(),
  };
}

// textual micro-fetch with undici (like wiseplay.fetchText but with no content limits)
async function fetchText(url, userAgent = '') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PANEL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': getUserAgent(userAgent), Accept: 'application/json' },
    });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} from the Xtream panel`);
      e.status = res.status;
      throw e;
    }
    return (await res.text()).slice(0, 500000);
  } catch (err) {
    const cause = err && err.cause;
    const e = new Error(`panel unreachable: ${cause ? `${cause.code}: ${cause.message}` : err.message}`);
    e.certError = !!cause && /CERT|SSL|TLS/i.test(`${cause.code} ${cause.message}`);
    e.causeRef = { code: (cause && cause.code) || '', message: (cause && cause.message) || (err && err.message) || '' };
    throw e;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { xtreamInfo, fetchPanelInfo };
