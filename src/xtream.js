'use strict';

/**
 * Info account Xtream: da un URL get.php con username/password ricava le
 * informazioni del pannello via /player_api.php (scadenza, stato, connessioni).
 * Serve per mostrare la scadenza della lista nella pagina di configurazione.
 */

const { nodeFetchText, resolveViaPublicDns } = require('./wiseplay');

const PANEL_TIMEOUT_MS = 8000;

/** Vero se l'URL punta a un pannello Xtream con credenziali in chiaro. */
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
 * Scarica /player_api.php riusando le stesse recovery del download liste
 * (http su porta https, TLS self-signed, DNS pubblici). Mai eccezioni:
 * ritorna {ok:false, reason} in caso di problema.
 */
async function fetchPanelInfo(url) {
  const info = xtreamInfo(url);
  if (!info) return { ok: false, reason: 'non un URL Xtream (mancano username/password in get.php)' };

  // claims delle retry mirati (come fetchRoot in wiseplay)
  async function tryFetch(target) {
    try {
      return await fetchText(target);
    } catch (err) {
      const causeRef = (err && err.causeRef) || {};
      const causeStr = `${causeRef.code || ''} ${causeRef.message || ''} ${(err && err.message) || ''}`;
      if (/ERR_SSL_WRONG_VERSION_NUMBER/i.test(causeStr)) {
        const down = target.replace(/^https:\/\//i, 'http://');
        if (down !== target) return fetchText(down);
      }
      if (err && err.certError) return nodeFetchText(target, { insecure: true, timeout: PANEL_TIMEOUT_MS });
      if (/ENOTFOUND|EAI_AGAIN/i.test(causeRef.code || '')) {
        let ip = null;
        try { ip = await resolveViaPublicDns(new URL(target).hostname); } catch (_) { ip = null; }
        if (ip) return nodeFetchText(target, { ip, timeout: PANEL_TIMEOUT_MS });
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
    return { ok: false, reason: 'risposta non JSON da player_api.php' };
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

// micro-fetch testuale con undici (come wiseplay.fetchText ma senza limiti di contenuto)
async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PANEL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'WiseM3U/1.4 (+xtream-info)', Accept: 'application/json' },
    });
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status} dal pannello Xtream`);
      e.status = res.status;
      throw e;
    }
    return (await res.text()).slice(0, 500000);
  } catch (err) {
    const cause = err && err.cause;
    const e = new Error(`pannello irraggiungibile: ${cause ? `${cause.code}: ${cause.message}` : err.message}`);
    e.certError = !!cause && /CERT|SSL|TLS/i.test(`${cause.code} ${cause.message}`);
    e.causeRef = { code: (cause && cause.code) || '', message: (cause && cause.message) || (err && err.message) || '' };
    throw e;
  } finally {
    clearTimeout(t);
  }
}

module.exports = { xtreamInfo, fetchPanelInfo };
