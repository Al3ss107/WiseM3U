'use strict';

/**
 * Addon live log: in-memory ring buffer (last N events) read by
 * the /api/logs endpoint and the configuration page. Every entry is
 * also mirrored to the console, so "docker logs" shows everything in real time.
 *
 * Scopes used: stream | download | playlist | catalog | meta | system
 */

const MAX_ENTRIES = Number(process.env.LIVE_LOG_BUFFER || 1000);

let seq = 0;
const buffer = [];
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * @param {string} scope  functional area (stream, download, playlist, ...)
 * @param {string} level  debug | info | warn | error
 * @param {string} msg    human-readable message (single line)
 * @param {object} [data] extra structured fields (url, listId, channel, ...)
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

  // mirror to the console for "docker logs -f wisem3u"
  const line = `[${entry.scope}] ${entry.msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

/**
 * @param {object} q { since?: number, limit?: number, scope?: string, level?: string }
 * since: returns only entries with id > since (incremental UI polling)
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
