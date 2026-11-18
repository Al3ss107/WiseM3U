'use strict';

/**
 * On-screen stream diagnostics (streamDiag setting).
 *
 * The problem: when an IPTV panel rejects a stream (403, connection limit,
 * server down...), players (Nuvio/Stremio) stay in endless buffering WITHOUT
 * explaining anything. With diagnostics enabled, playlist/catalog URLs point
 * to /proxy/play, which:
 *  - stream OK  -> simple 302 redirect to the source: bandwidth stays direct
 *                  (no video traffic through the container);
 *  - stream KO  -> generates with FFmpeg an ERROR VIDEO shown on screen
 *                  with channel, list and reason, and records it in the live logs.
 *
 * If FFmpeg is not installed, it falls back to a textual 502 response.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const live = require('./liveLog');

const DIAG_UA = process.env.STREAM_DIAG_UA || 'VLC/3.0.20 LibVLC/3.0.20';
const PROBE_TIMEOUT_MS = Number(process.env.STREAM_DIAG_PROBE_TIMEOUT_MS || 8000) || 8000;
const VIDEO_DURATION_S = 60;
const VIDEOS_DIR = path.join(
  process.env.CACHE_DIR || path.join(__dirname, '..', 'data', 'cache'),
  'videos'
);

/* ------------------------------ tool esterni ------------------------------ */

function which(bin) {
  try {
    const r = spawnSync('sh', ['-lc', `command -v ${bin}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const out = String(r.stdout || '').trim();
    return out ? out.split('\n')[0] : null;
  } catch (_) {
    return null;
  }
}

const FFMPEG = which('ffmpeg');
const FFPROBE = which('ffprobe');

function findFont() {
  for (const p of [
    '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf', // alpine ttf-dejavu
    '/usr/share/fonts/dejavu/DejaVuSans.ttf', // debian fonts-dejavu
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const FONT = findFont();

function capabilities() {
  return { ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE, font: !!FONT };
}

/* ---------------------------- source probe ---------------------------- */

/**
 * Simulates the player: GET with Range + close as soon as headers arrive.
 * Always returns (never throws): { ok, finalUrl, status, reason }.
 */
function probe(urlText, redirectsLeft = 3, chain) {
  return new Promise((resolve) => {
    if (!chain) chain = [urlText]; // traccia gli hop: [...url visitati]
    let u;
    try {
      u = new URL(urlText);
    } catch (_) {
      return resolve({ ok: false, reason: 'invalid URL', chain });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ ok: false, reason: `unsupported protocol: ${u.protocol}`, chain });
    }
    const lib = u.protocol === 'https:' ? https : http;
    let req;
    try {
      req = lib.request(
        {
          host: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + (u.search || ''),
          method: 'GET',
          headers: { 'User-Agent': DIAG_UA, Accept: '*/*', Range: 'bytes=0-0', Connection: 'close' },
          timeout: PROBE_TIMEOUT_MS,
          // molti pannelli hanno certificati self-signed e i player li accettano:
          // here we only report if the stream is truly unreachable
          rejectUnauthorized: false,
          ...(require('net').isIP(u.hostname) ? {} : { servername: u.hostname }),
        },
        (res) => {
          const code = res.statusCode;
          if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            const next = new URL(res.headers.location, urlText).toString();
            return resolve(probe(next, redirectsLeft - 1, chain.concat([next])));
          }
          res.resume();
          if (code === 200 || code === 206) {
            return resolve({ ok: true, finalUrl: urlText, status: code, chain });
          }
          const reason =
            code === 401 || code === 403
              ? `access denied by the panel (HTTP ${code}): wrong credentials, expired account, connection limit reached or country/user-agent blocked`
              : code === 404
                ? 'channel not found on the panel (HTTP 404): the list changed — try "Refresh" from the configuration page'
                : code >= 500
                  ? `the origin server returned an error (HTTP ${code}): try again shortly`
                  : `unexpected response from the panel (HTTP ${code})`;
          resolve({ ok: false, status: code, reason, chain });
        }
      );
    } catch (e) {
      return resolve({ ok: false, reason: `request not sent: ${e.message}`, chain });
    }
    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        reason: `no response within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s: slow or offline server (the same problem as endless buffering)`,
        chain,
      });
    });
    req.on('error', (e) => {
      const c = String((e && e.code) || '');
      const m = String((e && e.message) || '');
      const reason = /ENOTFOUND|EAI_AGAIN/i.test(c)
        ? `unresolved domain (${u.hostname}): home/box DNS or expired panel`
        : /ECONNREFUSED/i.test(c)
          ? `connection refused by ${u.host}: server down or wrong port`
          : /ECONNRESET|EPIPE|UND_ERR_SOCKET|closed/i.test(`${c} ${m}`)
            ? 'the panel closed the connection while responding'
            : /CERT|SSL|TLS|HANDSHAKE|WRONG_VERSION/i.test(`${c} ${m}`)
              ? `TLS problem with ${u.hostname} (${c || m})`
              : `network error: ${c || m}`;
      resolve({ ok: false, reason, chain });
    });
    req.end();
  });
}

/** Best-effort ffprobe: resolution/codec for live logs (never blocking). */
function probeMedia(url) {
  if (!FFPROBE) return Promise.resolve(null);
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(
        FFPROBE,
        ['-v', 'error', '-print_format', 'json', '-show_streams', url],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch (_) {
      return resolve(null);
    }
    let out = '';
    const killer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch (_) { /* gia' morto */ }
      resolve(null);
    }, 8000);
    killer.unref();
    p.stdout.on('data', (c) => {
      out += c;
      if (out.length > 1000000) { try { p.kill(); } catch (_) { /* ok */ } }
    });
    p.on('close', () => {
      clearTimeout(killer);
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === 'video');
        const a = (j.streams || []).find((s) => s.codec_type === 'audio');
        if (!v && !a) return resolve(null);
        resolve({
          video: v ? `${v.codec_name} ${v.width}x${v.height}` : '—',
          audio: a ? `${a.codec_name}${a.channels ? `/${a.channels}ch` : ''}` : '—',
        });
      } catch (_) {
        resolve(null);
      }
    });
    p.on('error', () => {
      clearTimeout(killer);
      resolve(null);
    });
  });
}

/* --------------------------- video di error a schermo --------------------------- */

/** Splits text into lines of at most `max` characters for drawtext. */
function wrapLines(texts, max = 58) {
  const lines = [];
  for (const t of texts) {
    let s = String(t || '').trim();
    while (s.length > max) {
      let cut = s.lastIndexOf(' ', max);
      if (cut < 20) cut = max;
      lines.push(s.slice(0, cut));
      s = s.slice(cut).trim();
    }
    if (s) lines.push(s);
  }
  return lines.slice(0, 8); // non oltre: deve stare a schermo
}

const videoPromiseByKey = new Map(); // hash -> Promise<file|null>

function renderErrorVideo(title, bodyLines) {
  if (!FFMPEG || !FONT) return Promise.resolve(null);
  const key = crypto.createHash('sha1').update(title + '\n' + bodyLines.join('\n')).digest('hex');
  if (videoPromiseByKey.has(key)) return videoPromiseByKey.get(key);
  const promise = actuallyRender(key, title, bodyLines);
  videoPromiseByKey.set(key, promise);
  return promise;
}

function actuallyRender(key, title, bodyLines) {
  return new Promise((resolve) => {
    try {
      if (!fs.statSync(VIDEOS_DIR).isDirectory()) return resolve(null);
    } catch (_) {
      try { fs.mkdirSync(VIDEOS_DIR, { recursive: true }); } catch (_) { return resolve(null); }
    }
    const out = path.join(VIDEOS_DIR, `err-${key}.ts`);
    if (fs.existsSync(out)) return resolve(out);
    const titleFile = path.join(VIDEOS_DIR, `err-${key}.title.txt`);
    const bodyFile = path.join(VIDEOS_DIR, `err-${key}.body.txt`);
    try {
      fs.writeFileSync(titleFile, `${title}\n`);
      fs.writeFileSync(bodyFile, `${bodyLines.join('\n')}\n`);
    } catch (_) {
      return resolve(null);
    }
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x10182c:s=1280x720:r=10:d=${VIDEO_DURATION_S}`,
      '-vf',
      [
        `drawtext=fontfile='${FONT}':textfile='${titleFile}':fontcolor=0xff6b5c:fontsize=60:x=(w-text_w)/2:y=170:line_spacing=12`,
        `drawtext=fontfile='${FONT}':textfile='${bodyFile}':fontcolor=0xe6ecf5:fontsize=30:x=(w-text_w)/2:y=330:box=1:boxcolor=0x0a0f1ecc:boxborderw=26:line_spacing=14`,
      ].join(','),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-t', String(VIDEO_DURATION_S),
      '-f', 'mpegts', '-y', out,
    ];
    let p;
    try {
      p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_) {
      return resolve(null);
    }
    let lastErr = '';
    p.stderr.on('data', (c) => { lastErr = String(c).slice(-400); });
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out)) return resolve(out);
      console.error(`[streamdiag] ffmpeg exited with code ${code}:`, lastErr);
      resolve(null);
    });
    p.on('error', () => resolve(null));
  });
}

/* --------------------------------- handler --------------------------------- */

/**
 * /proxy/play route — registered only when the setting is enabled.
 * Parameters: u (original url), n (channel name), l (list name).
 */
async function handlePlay(req, res, ctx = {}) {
  const u = String(req.query.u || '');
  const name = String(req.query.n || 'channel');
  const listName = String(req.query.l || '');

  const r = await probe(u);
  if (r.ok) {
    const c = capabilities();
    live.add(
      'stream',
      c.ffprobe ? 'info' : 'debug',
      `⏯ "${name}"${listName ? ` (${listName})` : ''} reachable (HTTP ${r.status}) → direct redirect`,
      { url: r.finalUrl, ms: ctx.t0 ? Date.now() - ctx.t0 : undefined, ...(ctx.client || {}) }
    );
    if (c.ffprobe) {
      probeMedia(r.finalUrl)
        .then((info) => {
          if (info) {
            live.add('stream', 'info', `⏯ ffprobe "${name}": video ${info.video}, audio ${info.audio}`, ctx.client || {});
          }
        })
        .catch(() => { /* best effort */ });
    }
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, r.finalUrl);
  }

  live.add(
    'stream',
    'error',
    `⛔ "${name}"${listName ? ` (${listName})` : ''} not playable — ${r.reason} — url: ${u}`,
    { ms: ctx.t0 ? Date.now() - ctx.t0 : undefined, ...(ctx.client || {}) }
  );

  const body = wrapLines([`Channel: ${name}`, listName && `List: ${listName}`, r.reason]);
  const file = await renderErrorVideo('STREAM UNAVAILABLE', body);
  res.set('Cache-Control', 'no-store');
  if (!file) {
    // without ffmpeg we fall back to text: less "patient" players show it,
    // and the cause remains in the live logs
    res.status(502).type('text/plain; charset=utf-8');
    return res.send(`STREAM UNAVAILABLE\n${body.join('\n')}\n`);
  }
  res.set('Content-Type', 'video/mp2t');
  fs.createReadStream(file).pipe(res);
}

/** Builds the diagnostic URL for a list stream. */
function diagUrl(base, origUrl, name, listName) {
  const qs = new URLSearchParams({ u: origUrl, n: name, l: listName });
  return `${base.replace(/\/+$/, '')}/proxy/play?${qs.toString()}`;
}

module.exports = { probe, handlePlay, diagUrl, capabilities };
