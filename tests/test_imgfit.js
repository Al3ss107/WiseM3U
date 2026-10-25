#!/usr/bin/env node
'use strict';
/**
 * Test composizione poster (v1.5.0)
 * =================================
 * Regressione "poster tagliati": i CDN dei canali servono WebP/SVG/ICO oltre
 * al classico PNG/JPEG (Pluto TV, Rakuten). Solo P/J fallivano in decode e il
 * client finiva per mostrare l'immagine GREZZA ritagliata cover. Con sharp
 * (libvips) tutti i formati entrano nel flusso contain su tela 640x360.
 */
const http = require('http');
const express = require('express');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { produce, icoToPng, handle } = require(path.join(REPO, 'src', 'imgfit'));
const sharp = require(path.join(REPO, 'node_modules', 'sharp'));

const PORT = 9862;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const assert = (c, m) => { if (!c) { failures++; console.log(`FAIL  ${m}`); } else console.log(`PASS  ${m}`); };
const isCanvas = async (buf, W, H) => { try { const m = await sharp(buf).metadata(); return m.format === 'jpeg' && m.width === W && m.height === H; } catch { return false; } };

(async () => {
  // fixture: png verticale, webp banner orizzontale (tipo Rakuten genre),
  // svg vettoriale (tipo Pluto logo), ico con png embedded (favicon Rakuten)
  const png = await sharp({ create: { width: 50, height: 300, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 1 } } }).png().toBuffer();
  const webp = await sharp({ create: { width: 1200, height: 200, channels: 4, background: { r: 0, g: 0, b: 200, alpha: 1 } } }).webp().toBuffer();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="300"><rect width="700" height="300" fill="#a00"/><text x="40" y="170" font-size="90" fill="#fff">FILM</text></svg>');
  const inner = await sharp({ create: { width: 48, height: 48, channels: 4, background: { r: 255, g: 255, b: 0, alpha: 1 } } }).png().toBuffer();
  const hdr = Buffer.alloc(22);
  hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
  hdr.writeUInt8(48, 6); hdr.writeUInt8(48, 7); hdr.writeUInt32LE(inner.length, 14); hdr.writeUInt32LE(22, 18);
  const ico = Buffer.concat([hdr, inner]);

  const media = { '/x.png': png, '/x.webp': webp, '/x.svg': svg, '/x.ico': ico, '/x.txt': 'not-an-image' };
  const mediaSrv = http.createServer((q, r) => {
    const m = media[new URL(q.url, 'http://x').pathname];
    if (m == null) { r.writeHead(404); return r.end(''); }
    r.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    r.end(m);
  });
  await new Promise((r) => mediaSrv.listen(PORT, '127.0.0.1', r));

  // --- extract: ICO ----------------------------------------------------------------
  assert(icoToPng(ico) && icoToPng(ico).length === inner.length, 'ico parser: png embedded estratto');
  assert(icoToPng(Buffer.from('MZ��')) === null, 'ico parser: non-ico -> null');

  // --- produce(): tutti i formati rendono la stessa tela --------------------------------
  for (const [f, exp] of [['x.png', true], ['x.webp', true], ['x.svg', true], ['x.ico', true], ['x.txt', false]]) {
    let out = null;
    try { out = await produce(`${BASE}/${f}`, 'landscape'); } catch (_) { out = null; }
    if (exp) assert(out && (await isCanvas(out, 640, 360)), `produce ${f} -> canvas JPEG 640x360`);
    else assert(out === null, `produce ${f} -> ignoto resta null (fallback redirect)`);
  }

  const sq = await produce(`${BASE}/x.webp`, 'square');
  assert(sq && (await isCanvas(sq, 512, 512)), 'produce square -> canvas JPEG 512x512');

  // --- handler express: 200 jpeg, 302 fallback, cache su disco ---------------------------
  const app = express();
  app.get('/imgfit', (req, res) => handle(req, res));
  const appSrv = app.listen(0, '127.0.0.1');
  await new Promise((r) => appSrv.once('listening', r));
  const acc = `http://127.0.0.1:${appSrv.address().port}`;

  const okRes = await fetch(`${acc}/imgfit?shape=landscape&url=${encodeURIComponent(`${BASE}/x.webp`)}`);
  assert(okRes.status === 200 && (okRes.headers.get('content-type') || '').includes('image/jpeg'),
    `handler: ${okRes.status} jpeg (canvas servito)`);
  assert(await isCanvas(Buffer.from(await okRes.arrayBuffer()), 640, 360), 'handler: il deposito e\' la tela');
  const fall = await fetch(`${acc}/imgfit?shape=landscape&url=${encodeURIComponent(`${BASE}/x.txt`)}`, { redirect: 'manual' });
  assert(fall.status === 302, `handler: immagine ignota -> 302 all'origine (${fall.status})`);
  const cached = await fetch(`${acc}/imgfit?shape=landscape&url=${encodeURIComponent(`${BASE}/x.webp`)}`);
  assert(cached.status === 200, 'handler: seconda richiesta servita (cache disco)');

  appSrv.close();
  mediaSrv.close();
  console.log(failures ? `\n${failures} TEST FALLITI ✖` : '\nTUTTI I TEST IMGFIT PASSATI ✔');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERRORE TEST:', e); process.exit(1); });
