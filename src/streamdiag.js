'use strict';

/**
 * Diagnostica degli stream "a schermo" (impostazione streamDiag).
 *
 * Il problema: quando un pannello IPTV rifiuta uno stream (403, limite
 * connessioni, server spento...), i player (Nuvio/Stremio) restano in
 * buffering infinito SENZA spiegare nulla. Con la diagnostica attiva gli URL
 * nella playlist/catalogo puntano a /proxy/play, che:
 *  - stream OK  -> semplice redirect 302 alla fonte: la banda resta diretta
 *                  (niente traffico video attraverso il container);
 *  - stream KO  -> genera con FFmpeg un VIDEO DI ERRORE che appare a schermo
 *                  con canale, lista e motivo, e lo registrar nei log live.
 *
 * Se FFmpeg non e' installato, ricade in una risposta 502 testuale.
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

/* ---------------------------- probe della fonte ---------------------------- */

/**
 * Simula il player: GET con Range + chiusura appenaarrivati gli header.
 * Ritorna sempre (mai eccezioni): { ok, finalUrl, status, reason }.
 */
function probe(urlText, redirectsLeft = 3) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlText);
    } catch (_) {
      return resolve({ ok: false, reason: 'URL non valido' });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ ok: false, reason: `protocollo non supportato: ${u.protocol}` });
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
          // qui segnaliamo solo se lo stream e' davvero irraggiungibile
          rejectUnauthorized: false,
          ...(require('net').isIP(u.hostname) ? {} : { servername: u.hostname }),
        },
        (res) => {
          const code = res.statusCode;
          if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            const next = new URL(res.headers.location, urlText).toString();
            return resolve(probe(next, redirectsLeft - 1));
          }
          res.resume();
          if (code === 200 || code === 206) {
            return resolve({ ok: true, finalUrl: urlText, status: code });
          }
          const reason =
            code === 401 || code === 403
              ? `accesso negato dal pannello (HTTP ${code}): credenziali errate, account scaduto, limite connessioni raggiunto o paese/user-agent bloccati`
              : code === 404
                ? 'canale non trovato sul pannello (HTTP 404): la lista e\' cambiata — prova "Aggiorna" dalla configurazione'
                : code >= 500
                  ? `il server di origine e' in errore (HTTP ${code}): riprova tra poco`
                  : `risposta inattesa del pannello (HTTP ${code})`;
          resolve({ ok: false, status: code, reason });
        }
      );
    } catch (e) {
      return resolve({ ok: false, reason: `richiesta non partita: ${e.message}` });
    }
    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        reason: `nessuna risposta in ${Math.round(PROBE_TIMEOUT_MS / 1000)}s: server lento o offline (e' lo stesso problema del buffering infinito)`,
      });
    });
    req.on('error', (e) => {
      const c = String((e && e.code) || '');
      const m = String((e && e.message) || '');
      const reason = /ENOTFOUND|EAI_AGAIN/i.test(c)
        ? `dominio non risolto (${u.hostname}): DNS casalingo/box o pannello scaduto`
        : /ECONNREFUSED/i.test(c)
          ? `connessione rifiutata da ${u.host}: server spento o porta errata`
          : /ECONNRESET|EPIPE|UND_ERR_SOCKET|closed/i.test(`${c} ${m}`)
            ? 'il pannello ha chiuso la connessione mentre rispondeva'
            : /CERT|SSL|TLS|HANDSHAKE|WRONG_VERSION/i.test(`${c} ${m}`)
              ? `problema TLS verso ${u.hostname} (${c || m})`
              : `errore di rete: ${c || m}`;
      resolve({ ok: false, reason });
    });
    req.end();
  });
}

/** ffprobe best-effort: risoluzione/codec per i log live (mai bloccante). */
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

/* --------------------------- video di errore a schermo --------------------------- */

/** Spezza il testo in righe da max `max` caratteri per la drawtext. */
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
    let stat;
    try {
      stat = fs.statSync(VIDEOS_DIR);
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
      console.error(`[streamdiag] ffmpeg uscito con codice ${code}:`, lastErr);
      resolve(null);
    });
    p.on('error', () => resolve(null));
  });
}

/* --------------------------------- handler --------------------------------- */

/**
 * Route /proxy/play — registrata solo quando l'impostazione e' attiva.
 * Parametri: u (url originale), n (nome canale), l (nome lista), token.
 */
async function handlePlay(req, res, ctx = {}) {
  const u = String(req.query.u || '');
  const name = String(req.query.n || 'canale');
  const listName = String(req.query.l || '');

  const r = await probe(u);
  if (r.ok) {
    const c = capabilities();
    live.add(
      'stream',
      c.ffprobe ? 'info' : 'debug',
      `⏯ "${name}"${listName ? ` (${listName})` : ''} raggiungibile (HTTP ${r.status}) → redirect diretto`,
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
    `⛔ "${name}"${listName ? ` (${listName})` : ''} non riproducibile — ${r.reason} — url: ${u}`,
    { ms: ctx.t0 ? Date.now() - ctx.t0 : undefined, ...(ctx.client || {}) }
  );

  const body = wrapLines([`Canale: ${name}`, listName && `Lista: ${listName}`, r.reason]);
  const file = await renderErrorVideo('STREAM NON DISPONIBILE', body);
  res.set('Cache-Control', 'no-store');
  if (!file) {
    // senza ffmpeg ricadiamo su testo: i player meno "pazienti" lo mostrano,
    // e la causa resta nei log live
    res.status(502).type('text/plain; charset=utf-8');
    return res.send(`STREAM NON DISPONIBILE\n${body.join('\n')}\n`);
  }
  res.set('Content-Type', 'video/mp2t');
  fs.createReadStream(file).pipe(res);
}

/** Costruisce lo URL di diagnostica per uno stream della lista. */
function diagUrl(base, token, origUrl, name, listName) {
  const qs = new URLSearchParams({ u: origUrl, n: name, l: listName });
  if (token) qs.set('token', token);
  return `${base.replace(/\/+$/, '')}/proxy/play?${qs.toString()}`;
}

module.exports = { probe, handlePlay, diagUrl, capabilities };
