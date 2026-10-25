'use strict';

/**
 * Costanti condivise dell'addon: un solo posto per versione, user-agent,
 * limiti e timeout usati da piu' moduli (niente hardcoding sparso).
 */

const pkg = require('../package.json');

module.exports = {
  /** Versione semver del rilascio (fonte di verita': package.json). */
  VERSION: pkg.version,

  /** User-agent unico per tutte le richieste in uscita. */
  USER_AGENT:
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/126.0 Safari/537.36 WiseM3U/${pkg.version}`,

  /** User-agent "pulito" per i loghi/poster: i CDN dietro Cloudflare worker
   *  (quelli dei loghi vavoo, Rakuten, Pluto...) bloccano anche solo il
   *  suffisso "WiseM3U/x.y" come traffico bot -> 403 -> poster ritagliati. */
  IMG_USER_AGENT:
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/126.0.0.0 Safari/537.36`,

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
