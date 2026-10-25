'use strict';

/**
 * Riformatta i loghi dei canali in poster proporzionati (contain su tela
 * scura), cosi' i client che ritagliano "cover" non li mostrano tagliati.
 *
 * Decodifica e composizione con sharp/libvips (binari precompilati, anche
 * musl/ARM): digerisce PNG, JPEG, WebP, SVG, GIF, TIFF, e — con un parsing
 * minimo — anche i FAVICON .ICO moderni (PNG embedded): i CDN di Pluto TV /
 * Rakuten servono proprio quei formati e coi decoder "solo PNG/JPEG" i
 * canali passavano in grezzo al client, che li ritagliava (poster tagliati).
 *
 * - on-demand: elabora solo i loghi effettivamente richiesti dai client;
 * - cache su disco (data/imgcache) con Cache-Control lungo;
 * - single-flight + concurrency limitata;
 * - qualsiasi problema (formato ignoto, rete, timeout) -> 302 all'URL
 *   originale: nessuna regressione rispetto a prima.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { IMG_USER_AGENT } = require('./constants');

const CACHE_DIR = process.env.IMGFIT_DIR || path.join(__dirname, '..', 'data', 'imgcache');
const MAX_BYTES = 8 * 1024 * 1024; // webp/svg di brand possono pesare
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

async function fetchBuf(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // niente suffisso WiseM3U (vedi IMG_USER_AGENT) + Accept da browser:
        // diversi CDN di loghi rispondono 403/i-frame challenge altrimenti
        'User-Agent': IMG_USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('immagine vuota');
    if (buf.length > MAX_BYTES) throw new Error('immagine troppo grande');
    return buf;
  } finally {
    clearTimeout(t);
  }
}

/**
 * ICO: i favicon moderni (es. quelli di Rakuten) incorporano direttamente
 * un PNG: lo estraiamo e lo diamo a sharp. BMP-in-ICO classici -> null
 * (il chiamante fa redirect, formato di nicchia).
 */
function icoToPng(buf) {
  // header ICO: reserved(2)=0, type(2)=1, count(2); entry: w,h,pal,res,planes,bitcount,size,offset
  if (buf.length < 6 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1 || buf[3] !== 0) return null;
  const count = buf.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) break;
    const size = buf.readUInt32LE(off + 8);
    const dataOff = buf.readUInt32LE(off + 12);
    if (dataOff + size > buf.length) continue;
    // dentro c'e' un PNG?
    if (buf[dataOff] === 0x89 && buf[dataOff + 1] === 0x50 && buf[dataOff + 2] === 0x4e && buf[dataOff + 3] === 0x47) {
      const w = buf[off] || 256;
      if (!best || w > best.w) best = { w: dataOff, data: buf.subarray(dataOff, dataOff + size) };
    }
  }
  return best ? best.data : null;
}

async function produce(url, shape) {
  const [W, H] = SHAPES[shape] || SHAPES.landscape;
  let buf = await fetchBuf(url);
  const png = icoToPng(buf);
  if (png) buf = png;
  // padding ~10%: logo in contain su tela (W-2p)x(H-2p), poi estesa alla
  // dimensione finale — il client mostra la tela gia' delle sue proporzioni
  const padX = Math.round(W * 0.10);
  const padY = Math.round(H * 0.10);
  return sharp(buf, { limitInputPixels: MAX_PIXELS, density: 150, animated: false })
    .flatten({ background: BG }) // trasparenza -> fondo scuro (JPEG non ha alpha)
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

/** Fallback: passa l'immagine GREZZA al client. Cache breve cosi' il client
 *  non martella gli stessi URL ma il poster puo' sistemarsi da solo più tardi. */
function fallbackRedirect(res, url) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.redirect(302, url);
}

// un avviso per poster fallito (diagnosi da docker logs; host-only = niente URL)
const WARNED = new Set();
function warnFailed(key, url, err) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  if (WARNED.size > 200) WARNED.clear();
  let host = 'sconosciuto';
  try { host = new URL(url).hostname; } catch (_) { /* url grezza */ }
  console.warn(`[imgfit] logo non processato da ${host}: ${(err && err.message) || 'formato ignoto'} — fallback all'originale`);
}

/** Handler express: GET /imgfit?shape=landscape&url=https://… */
async function handle(req, res) {
  const url = String(req.query.url || '');
  const shape = String(req.query.shape || 'landscape');
  if (!/^https?:\/\//i.test(url)) return res.status(400).end();

  const key = crypto.createHash('sha1').update(`${shape}|${url}`).digest('hex');
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
      p = runQueued(() => produce(url, shape).catch((err) => {
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

/** Svuota la cache su disco (chiamato da /api/cache/clear). */
function purge() {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (_) { /* ignora */ }
}

module.exports = { handle, purge, CACHE_DIR, produce, icoToPng };
