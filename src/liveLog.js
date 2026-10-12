'use strict';

/**
 * Log live dell'addon: buffer circolare in memoria (ultimi N eventi) letto
 * dall'endpoint /api/logs e dalla pagina di configurazione. Ogni voce viene
 * anche specchiata su console, cosi' "docker logs" mostra tutto in tempo reale.
 *
 * Scope usati: stream | download | playlist | catalog | meta | system
 */

const MAX_ENTRIES = Number(process.env.LIVE_LOG_BUFFER || 1000);

let seq = 0;
const buffer = [];
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * @param {string} scope  area funzionale (stream, download, playlist, ...)
 * @param {string} level  debug | info | warn | error
 * @param {string} msg    messaggio leggibile (riga singola)
 * @param {object} [data] campi extra strutturati (url, listId, channel, ...)
 */
function add(scope, level, msg, data) {
  if (!LEVELS.has(level)) level = 'info';
  seq += 1;
  const entry = {
    id: seq,
    ts: new Date().toISOString(),
    scope: String(scope || 'system'),
    level,
    msg: String(msg),
    ...(data && typeof data === 'object' ? { data } : {}),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);

  // specchio su console per "docker logs -f wisem3u"
  const line = `[${entry.scope}] ${entry.msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

/**
 * @param {object} q { since?: number, limit?: number, scope?: string, level?: string }
 * since: restituisce solo voci con id > since (polling incrementale della UI)
 */
function list(q = {}) {
  const since = Number(q.since) || 0;
  const limit = Math.max(1, Math.min(2000, Number(q.limit) || 500));
  const scope = q.scope ? String(q.scope) : '';
  let out = buffer;
  if (since || scope) {
    out = out.filter((e) => e.id > since && (!scope || scope === 'all' || e.scope === scope));
  }
  return out.slice(-limit);
}

function clear() {
  buffer.length = 0;
}

module.exports = { add, list, clear };
