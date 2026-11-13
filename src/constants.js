'use strict';

/**
 * Costanti condivise dell'addon: un solo posto per versione, user-agent,
 * limiti e timeout usati da piu' moduli (niente hardcoding sparso).
 *
 * User-Agent personalizzato: alcuni pannelli/CDN bloccano la stringa di
 * WiseM3U (403). Dalle impostazioni l'utente puo' incollare una UA qualsiasi
 * (di un browser, di VLC, dell'app che usa di solito): vale per TUTTE le
 * richieste in uscita (liste, rami, JSON Xtream, loghi). Vuota = default.
 */

const pkg = require('../package.json');

/** UA predefinita delle richieste "di dati" (liste, JSON, Xtream). */
const DEFAULT_USER_AGENT =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/126.0 Safari/537.36 WiseM3U/${pkg.version}`;

/** UA predefinita dei loghi: niente suffisso WiseM3U perche' i CDN dietro
 *  Cloudflare worker (vavoo, Rakuten, Pluto...) lo trattano come bot. */
const DEFAULT_IMG_USER_AGENT =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/126.0.0.0 Safari/537.36`;

/** Normalizza una UA scritta dall'utente: una sola riga, niente CR/LF
 *  (header injection), lunghezza ragionevole. */
function sanitizeUserAgent(ua) {
  const s = String(ua == null ? '' : ua)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s.slice(0, 300);
}

let customUserAgent = '';

/** Imposta l'override globale (stringa vuota = torna ai default). */
function setCustomUserAgent(ua) {
  customUserAgent = sanitizeUserAgent(ua);
  return customUserAgent;
}

/** UA per liste/JSON/Xtream: personalizzata se impostata. */
function getUserAgent() {
  return customUserAgent || DEFAULT_USER_AGENT;
}

/** UA per i loghi: personalizzata se impostata, altrimenti quella "pulita". */
function getImgUserAgent() {
  return customUserAgent || DEFAULT_IMG_USER_AGENT;
}

module.exports = {
  /** Versione semver del rilascio (fonte di verita': package.json). */
  VERSION: pkg.version,

  /** Default esportati come costanti (chi vuole il valore "di fabbrica").
   *  Per le richieste vere usare getUserAgent()/getImgUserAgent(). */
  USER_AGENT: DEFAULT_USER_AGENT,
  IMG_USER_AGENT: DEFAULT_IMG_USER_AGENT,

  sanitizeUserAgent,
  setCustomUserAgent,
  getUserAgent,
  getImgUserAgent,

  /** Limite del body JSON accettato dalle API (la config puo' essere grande). */
  JSON_BODY_LIMIT: '4mb',

  /** Timeout del check /api/info di EasyProxy (pulsante Test). */
  EP_INFO_TIMEOUT_MS: 6000,

  /** Timeout del proxy di prova di EasyProxy (download di uno stream vero). */
  EP_PROXY_TIMEOUT_MS: 15000,

  /** Cache-Control per manifest e cataloghi: i client rifetchano meno, le
   *  modifiche alla configurazione diventano visibili entro un minuto. */
  PUBLIC_CACHE_CONTROL: 'public, max-age=60',

  /** Sotto questa dimensione le risposte non vengono compresse. */
  COMPRESSION_THRESHOLD: 1024,
};
