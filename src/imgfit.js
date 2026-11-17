'use strict';

/**
 * Reformats channel logos into proportional posters (contain on a dark
 * canvas), so clients that crop "cover" do not cut them.
 *
 * Decoding and composition with sharp/libvips (prebuilt binaries, including
 * musl/ARM): handles PNG, JPEG, WebP, SVG, GIF, TIFF, and — with minimal
 * parsing — modern .ICO FAVICONS (embedded PNG): Pluto TV / Rakuten CDNs
 * serve exactly those formats, and with "PNG/JPEG only" decoders the
 * channels were passed through raw and cropped by the client (cut posters).
 *
 * - on-demand: processes only the logos actually requested by clients;
 * - disk cache (data/imgcache) with a long Cache-Control;
 * - single-flight + limited concurrency;
 * - any problem (unknown format, network, timeout) -> 302 to the original
 *   URL: no regression compared to before.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { getImgUserAgent } = require('./constants');

const CACHE_DIR = process.env.IMGFIT_DIR || path.join(__dirname, '..', 'data', 'imgcache');
const MAX_BYTES = 8 * 1024 * 1024; // brand webp/svg files can be large
const MAX_PIXELS = 4096 * 4096;
const FETCH_TIMEOUT_MS = 6000;
const CONCURRENCY = 4;
const MAX_QUEUE = 24;
const BG = { r: 16, g: 20, b: 24, alpha: 1 }; // #101418, tono scuro da app TV

const SHAPES = {
  square: [512, 512],     // preset residuo/fallback (posterShape square)
  landscape: [640, 360],  // poster canali e gruppi (posterShape landscape)
};

let active = 0;
const queue = [];
const inflight = new Map(); // key -> Promise<Buffer|null>

function ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) { /* read-only? */ }
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.jpg`);
}

async function fetchBuf(url, userAgent = '') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // niente suffisso WiseM3U (vedi getImgUserAgent) + Accept da browser:
        // diversi CDN di loghi rispondono 403/i-frame challenge altrimenti
        'User-Agent': getImgUserAgent(userAgent),
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('immagine vuota');
    if (buf.length > MAX_BYTES) throw new Error('image too large');
    return buf;
  } finally {
    clearTimeout(t);
  }
}

/**
 * ICO: modern favicons (e.g. Rakuten's) embed a PNG directly: we extract it
 * and pass it to sharp. Classic BMP-in-ICO -> null (the caller redirects,
 * it is a niche format).
 */
function icoToPng(buf) {
  // ICO header: reserved(2)=0, type(2)=1, count(2); entry: w,h,pal,res,planes,bitcount,size,offset
  if (buf.length < 6 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1 || buf[3] !== 0) return null;
  const count = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) break;
    const size = buf.readUInt32LE(off + 8);
    const dataOff = buf.readUInt32LE(off + 12);
    if (dataOff + size > buf.length) continue;
    // is there a PNG inside?
    if (buf[dataOff] === 0x89 && buf[dataOff + 1] === 0x50 && buf[dataOff + 2] === 0x4e && buf[dataOff + 3] === 0x47) {
      const w = buf[off] || 256;
      if (!best || w > best.w) best = { w: dataOff, data: buf.subarray(dataOff, dataOff + size) };
    }
  }
  return best ? best.data : null;
}

async function produce(url, shape, userAgent = '') {
  const [W, H] = SHAPES[shape] || SHAPES.landscape;
  let buf = await fetchBuf(url, userAgent);
  const png = icoToPng(buf);
  if (png) buf = png;
  // padding ~10%: logo contained in a (W-2p)x(H-2p) canvas, then extended to
  // the final size — the client shows the canvas already at its proportions
  const padX = Math.round(W * 0.10);
  const padY = Math.round(H * 0.10);
  return sharp(buf, { limitInputPixels: MAX_PIXELS, density: 150, animated: false })
    .flatten({ background: BG }) // transparency -> dark background (JPEG has no alpha)
    .resize(W - 2 * padX, H - 2 * padY, { fit: 'contain', background: BG })
    .extend({ top: padY, bottom: padY, left: padX, right: padX, background: BG })
    .jpeg({ quality: 82 })
    .toBuffer();
}

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const next = () => {
      active++;
      fn().then(resolve, reject).finally(() => {
        active--;
        const job = queue.shift();
        if (job) job();
      });
    };
    if (active < CONCURRENCY) next();
    else queue.push(next);
  });
}

/** Fallback: passes the RAW image to the client. Short cache so the client
 *  does not hammer the same URLs, but the poster can fix itself later. */
function fallbackRedirect(res, url) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.redirect(302, url);
}

// one warning per failed poster (diagnostics from docker logs; host-only = no URL)
const WARNED = new Set();
function warnFailed(key, url, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (WARNED.size > 200) WARNED.clear();
  let host = 'sconosciuto';
  try { host = new URL(url).hostname; } catch (_) { /* url grezza */ }
  console.warn(`[imgfit] logo not processed from ${host}: ${(err && err.message) || 'unknown format'} — falling back to the original`);
}

/** Handler express: GET /imgfit?shape=landscape&url=https://… */
async function handle(req, res) {
  const url = String(req.query.url || '');
  const shape = String(req.query.shape || 'landscape');
  const listId = String(req.query.list || '');
  if (!/^https?:\/\//i.test(url)) return res.status(400).end();

  // The logo belongs to a list: use that list's custom UA (empty = default).
  let userAgent = '';
  if (listId) {
    try {
      const cfg = require('./config').loadConfig();
      const list = (cfg.lists || []).find((l) => l.id === listId);
      if (list) userAgent = list.options.userAgent || '';
    } catch (_) { /* config unreadable: default UA */ }
  }

  const key = crypto.createHash('sha1').update(`${shape}|${url}|${userAgent}`).digest('hex');
  const file = cachePath(key);

  try {
    const cached = await fsp.readFile(file); // async: non blocca l'event loop
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', 'image/jpeg');
    return res.send(cached);
  } catch (_) { /* non in cache: si elabora */ }

  if (queue.length >= MAX_QUEUE) return fallbackRedirect(res, url);

  try {
    let p = inflight.get(key);
    if (!p) {
      p = runQueued(() => produce(url, shape, userAgent).catch((err) => {
        warnFailed(key, url, err);
        return null;
      }));
      inflight.set(key, p);
      p.finally(() => inflight.delete(key));
    }
    const out = await p;
    if (!out) return fallbackRedirect(res, url);
    ensureDir();
    fsp.writeFile(file, out).catch(() => { /* disco pieno: risponde comunque */ });
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', 'image/jpeg');
    return res.send(Buffer.from(out));
  } catch (_) {
    return fallbackRedirect(res, url);
  }
}

/** Clears the disk cache (called by /api/cache/clear). */
function purge() {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (_) { /* ignora */ }
}

module.exports = { handle, purge, CACHE_DIR, produce, icoToPng };
