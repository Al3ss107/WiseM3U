'use strict';

/**
 * Riformatta i loghi dei canali in poster proporzionati (contain su tela
 * scura), cosi' i client che ritagliano "cover" non li mostrano zoomati.
 *
 * Solo JS puro (pngjs + jpeg-js), niente native: adatto ad ARM lenti.
 * - on-demand: elabora solo i loghi effettivamente richiesti dai client;
 * - cache su disco (data/imgcache) con Cache-Control lungo;
 * - single-flight + concurrency limitata;
 * - qualsiasi problema (formato non PNG/JPEG, timeout, decode) -> 302
 *   all'URL originale: nessuna regressione rispetto a prima.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { USER_AGENT } = require('./constants');

const CACHE_DIR = process.env.IMGFIT_DIR || path.join(__dirname, '..', 'data', 'imgcache');
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;
const FETCH_TIMEOUT_MS = 6000;
const CONCURRENCY = 4;
const MAX_QUEUE = 12;
const BG = [16, 20, 24]; // #101418, tono scuro da app TV

const SHAPES = {
  square: [512, 512],     // poster canali (posterShape square)
  landscape: [640, 360],  // poster gruppi/landing (posterShape landscape)
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
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('immagine troppo grande');
    return buf;
  } finally {
    clearTimeout(t);
  }
}

/** Decodifica PNG o JPEG; altro formato -> null (il chiamante fa redirect). */
function decode(buf) {
  try {
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const png = PNG.sync.read(buf);
      if (png.width * png.height > MAX_PIXELS) return null;
      return { width: png.width, height: png.height, rgba: png.data, hasAlpha: true };
    }
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
      const img = jpeg.decode(buf, { maxMemoryUsageInMB: 256, useTArray: true });
      if (img.width * img.height > MAX_PIXELS) return null;
      return { width: img.width, height: img.height, rgba: img.data, hasAlpha: false };
    }
  } catch (_) {
    return null;
  }
  return null;
}

/** Disegna l'immagine in contain con padding, su fondo scuro opaco. */
function fitOnCanvas(img, W, H) {
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = BG[0]; out[i * 4 + 1] = BG[1]; out[i * 4 + 2] = BG[2]; out[i * 4 + 3] = 255;
  }
  const pad = 0.10;
  const s = Math.min((W * (1 - 2 * pad)) / img.width, (H * (1 - 2 * pad)) / img.height);
  const dw = Math.max(1, Math.round(img.width * s));
  const dh = Math.max(1, Math.round(img.height * s));
  const ox = Math.round((W - dw) / 2);
  const oy = Math.round((H - dh) / 2);
  // nearest-neighbor: veloce su ARM; la tela 512px viene poi ridotta
  // dolcemente dal client nella griglia
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / s));
    const rowS = sy * img.width;
    const rowD = (oy + y) * W + ox;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / s));
      const si = (rowS + sx) * 4;
      const di = (rowD + x) * 4;
      const a = img.hasAlpha ? img.rgba[si + 3] / 255 : 1;
      out[di] = Math.round(img.rgba[si] * a + BG[0] * (1 - a));
      out[di + 1] = Math.round(img.rgba[si + 1] * a + BG[1] * (1 - a));
      out[di + 2] = Math.round(img.rgba[si + 2] * a + BG[2] * (1 - a));
      out[di + 3] = 255;
    }
  }
  return out;
}

async function produce(url, shape) {
  const [W, H] = SHAPES[shape] || SHAPES.square;
  const buf = await fetchBuf(url);
  const img = decode(buf);
  if (!img) return null;
  const rgba = fitOnCanvas(img, W, H);
  return jpeg.encode({ data: rgba, width: W, height: H }, 82).data;
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

/** Handler express: GET /imgfit?shape=square&url=https://… */
async function handle(req, res) {
  const url = String(req.query.url || '');
  const shape = String(req.query.shape || 'square');
  if (!/^https?:\/\//i.test(url)) return res.status(400).end();

  const key = crypto.createHash('sha1').update(`${shape}|${url}`).digest('hex');
  const file = cachePath(key);

  try {
    const cached = await fsp.readFile(file); // async: non blocca l'event loop
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', 'image/jpeg');
    return res.send(cached);
  } catch (_) { /* non in cache: si elabora */ }

  if (queue.length >= MAX_QUEUE) return res.redirect(302, url);

  try {
    let p = inflight.get(key);
    if (!p) {
      p = runQueued(() => produce(url, shape).catch(() => null));
      inflight.set(key, p);
      p.finally(() => inflight.delete(key));
    }
    const out = await p;
    if (!out) return res.redirect(302, url);
    ensureDir();
    fsp.writeFile(file, out).catch(() => { /* disco pieno: risponde comunque */ });
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', 'image/jpeg');
    return res.send(Buffer.from(out));
  } catch (_) {
    return res.redirect(302, url);
  }
}

/** Svuota la cache su disco (chiamato da /api/cache/clear). */
function purge() {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (_) { /* ignora */ }
}

module.exports = { handle, purge, CACHE_DIR };
