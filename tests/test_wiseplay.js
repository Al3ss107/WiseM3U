#!/usr/bin/env node
'use strict';
/**
 * Compatibility test for NeroZone-style "chained lists" (v1.4.8)
 * ==============================================================
 * Replicates the real defects found in the gists reported by the user:
 *  - non-strict JSON: trailing comma `},]` and empty element `, ,` (SPORT branch)
 *  - root group with "import": false (WisePlay = lazy loading: we resolve it
 *    anyway, it is the only way to show the content)
 *  - root with "url" pointing to itself (meta only, must NOT loop)
 *  - "embed": true stations (web pages Serially/Plex/...): not streams, excluded
 *  - m3u URL with a TRAILING SPACE: trim must save it
 *  - v1.5.2 huge response (video/archive/binary pasted instead of the
 *    list): DEFINITIVE and immediate error, no full download and no retry
 *  - huge m3u in streaming (Xtream panel replica): imported
 *    with no MB cap, stopped by channel count and without downloading everything
 */
const http = require('http');
const path = require('path');
const zlib = require('zlib');

// the byte limit is no longer an env override: cap tests
// call collectCapped with an explicit limit (see the huge-response section)
// low channel cap: verify truncation without generating 150,000 entries
process.env.WISEM3U_MAX_STATIONS = '1000';

const REPO = path.resolve(__dirname, '..');
const { buildTree, parseLenientJson, __test } = require(path.join(REPO, 'src', 'wiseplay'));
const UA = require(path.join(REPO, 'src', 'constants'));

const MOCK_PORT = 9853;
const BASE = `http://127.0.0.1:${MOCK_PORT}`;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.log(`FAIL  ${msg}`); }
  else console.log(`PASS  ${msg}`);
}

// index.php: root with a url pointing to ITSELF + ENTRA branch with import:false
const INDEX_PHP = `{
\t"name": "NeroZone",
\t"author": "nΣro",
\t"url": "${BASE}/raw/index.php",
\t"groups": [
\t\t{
\t\t\t"name": "ENTRA",
\t\t\t"info": "ENTER",
\t\t\t"url": "${BASE}/raw/inizio.json",
\t\t\t"import": false
\t\t}
\t]
}`;

// inizio.json: BROKEN JSON like the real gist: trailing },] and , , in the SPORT branch
const INIZIO_JSON = `{
  "name": "NeroZone",
  "author": "Usare dns cloudflare",
  "groups": [
    {
      "name": "TV",
      "groups": [
        {
          "name": "SKY (TEST)",
          "url": "${BASE}/raw/sky.m3u",
          "isHost": true
        },
        {
          "name": "RAKUTEN TV",
          "url": "${BASE}/raw/rakuten.m3u ",
          "isHost": true
        }
      ]
    },
    {
      "name": "SPORT",
      "groups": [
        {
          "name": "EVENTI SPORT 1",
          "url": "${BASE}/raw/sport1.m3u",
          "isHost": true
        },
        ,
        {
          "name": "EVENTI SPORT 2",
          "url": "${BASE}/raw/sport2.m3u",
          "isHost": true
        }
      ]
    },
    {
      "name": "VOD",
      "groups": [
        {
          "name": "VOD",
          "url": "${BASE}/raw/vod.json",
          "isHost": true
        }
      ]
    },
    {
      "name": "VOD (mobile ver.)",
      "stations": [
        { "name": "Serially", "url": "https://serially.it/", "embed": "true" },
        { "name": "Plex tv", "url": "https://watch.plex.tv/it", "embed": true },
        { "name": "Real channel", "url": "acestream://abcdef0123456789abcdef0123456789abcdef01" }
      ]
    },
  ]
}`;

// vod.json sublist: trailing-comma guard ring here too
const VOD_JSON = `{
  "name": "VOD",
  "stations": [
    { "name": "Film 1", "url": "http://srv/film1.mkv" },
    { "name": "Film 2", "url": "http://srv/film2.mkv" },
  ]
}`;

const M3U = (n, tag) => {
  const p = ['#EXTM3U'];
  for (let i = 0; i < n; i++) {
    p.push(`#EXTINF:-1 group-title="G${tag}",Channel ${tag} ${i}`);
    p.push(`http://127.0.0.1:1/stream/${tag}_${i}.ts`);
  }
  return p.join('\n');
};

const ROUTES = {
  '/raw/index.php': INDEX_PHP,
  '/raw/inizio.json': INIZIO_JSON,
  '/raw/vod.json': VOD_JSON,
  '/raw/sky.m3u': M3U(3, 'sky'),
  '/raw/rakuten.m3u': M3U(2, 'rakuten'),
  '/raw/sport1.m3u': M3U(2, 'sport1'),
  '/raw/sport2.m3u': M3U(2, 'sport2'),
};

(async () => {
  let lastUa = '';
  let videoBytesSent = 0;   // quanto il server riesce a spingere sull'URL "video"
  let endlessClosed = false;
  let bigLiveSent = 0;      // byte effettivamente serviti per l'm3u enorme
  let bigLiveClosed = false;
  const BIG_LIVE_TOTAL = 4000 * 115; // stima per eccesso dei byte totali
  const mock = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    lastUa = req.headers['user-agent'] || '';

    // fake video file (real case: .mp4 movie pasted instead of the list).
    // The video/* content-type is enough to reject without downloading anything.
    if (pathname === '/big-video.mp4') {
      const body = Buffer.alloc(768 * 1024, 0x47);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
      res.on('close', () => { /* client ha annullato */ });
      return res.end(body);
    }
    // "endless" stream without Content-Length (typical live .ts): the
    // video/mp2t content-type rejects it immediately, without reading the stream
    if (pathname === '/endless.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const chunk = Buffer.alloc(64 * 1024, 0x47);
      const t = setInterval(() => {
        if (res.destroyed) { clearInterval(t); return; }
        videoBytesSent += chunk.length;
        res.write(chunk);
      }, 5);
      res.on('close', () => { clearInterval(t); endlessClosed = true; });
      return;
    }
    // HUGE m3u in streaming (replica of the 581 MB Xtream panel): must
    // be imported up to the channel cap and then stopped, without reading everything
    if (pathname === '/big-live.m3u') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('#EXTM3U\n');
      let i = 0;
      const t = setInterval(() => {
        if (res.destroyed) { clearInterval(t); return; }
        if (i >= 4000) { clearInterval(t); return res.end(); }
        let block = '';
        for (let k = 0; k < 20 && i < 4000; k++, i++) {
          block +=
            `#EXTINF:-1 tvg-id="c${i}" tvg-name="Channel ${i}" tvg-logo="http://logo/${i}.png" group-title="LIVE ${i % 40}",Channel ${i}\n` +
            `http://example.test/live/${i}.ts\n`;
        }
        bigLiveSent += Buffer.byteLength(block);
        res.write(block);
      }, 1);
      res.on('close', () => { clearInterval(t); bigLiveClosed = true; });
      return;
    }

    // m3u served as raw gzip (application/octet-stream, without
    // Content-Encoding): many panels distribute it this way
    if (pathname === '/list.m3u.gz') {
      const gz = zlib.gzipSync(Buffer.from(M3U(2, 'gzip')));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(gz);
    }
    // m3u in UTF-16LE with BOM (legacy panels)
    if (pathname === '/utf16.m3u') {
      const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(M3U(2, 'u16'), 'utf16le')]);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(body);
    }
    // ZIP archive instead of the playlist
    if (pathname === '/archivio.zip') {
      const body = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(600 * 1024, 0)]);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length });
      return res.end(body);
    }

    if (pathname === '/ua.m3u') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(M3U(1, 'ua'));
    }

    if (ROUTES[pathname] != null) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(ROUTES[pathname]); }
    else { res.writeHead(404); res.end(''); }
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  // --- unit: the sanitizer must not corrupt strings -----------------------
  const mixed = '{"x":"virgola, ] dentro la stringa","y":"a,,b","list":[1,2,]}';
  const ok = parseLenientJson(mixed);
  assert(ok && ok.x === 'virgola, ] dentro la stringa' && ok.y === 'a,,b' && ok.list.length === 2,
    'sanitizer: virgole finali tolte ma stringhe simili intatte');

  const hole = parseLenientJson('{"a":[{\n},\n,\n{ "b": 1 }\n],\n}');
  assert(hole && hole.a.length === 2 && hole.a[1].b === 1, 'array with empty element (, ,) recovered');

  // --- integration: the whole NeroZone chain ------------------------------
  const { root, stats, errors } = await buildTree(`${BASE}/raw/index.php`);

  const entra = root.children.find((c) => c.name === 'ENTRA');
  assert(entra, 'ENTRA branch present (import:false ignored as in WisePlay)');
  assert(!entra.error, `ENTRA has no error (${entra.error || 'ok'})`);
  assert(!errors.some((e) => /invalid JSON/.test(e.error)),
    `no 'invalid JSON' in the chain: ${JSON.stringify(errors)}`);

  const names = entra.children.map((c) => c.name);
  assert(['TV', 'SPORT', 'VOD', 'VOD (mobile ver.)'].every((n) => names.includes(n)),
    `TV/SPORT/VOD families present: ${names.join('|')}`);

  const tv = entra.children.find((c) => c.name === 'TV');
  const sky = tv.children.find((c) => c.name === 'SKY (TEST)');
  assert(sky && sky.stations.length === 3, `SKY (TEST) has 3 channels (${sky && sky.stations.length})`);

  const rak = tv.children.find((c) => c.name === 'RAKUTEN TV');
  assert(rak && rak.stations.length === 2, `URL with trailing space trimmed, RAKUTEN ok (${rak && rak.stations.length})`);

  const sport = entra.children.find((c) => c.name === 'SPORT');
  const sportHosts = sport.children.filter((c) => c.name.startsWith('EVENTI SPORT'));
  assert(sportHosts.length === 2 && sportHosts.every((h) => h.stations.length === 2),
    `SPORT branch recovered despite the empty element (${sportHosts.length} hosts)`);

  const vod = entra.children.find((c) => c.name === 'VOD');
  assert(vod && vod.children[0] && vod.children[0].stations.length === 2,
    'vod.json sublist (nested WisePlay with trailing comma) parsed');

  const mob = entra.children.find((c) => c.name === 'VOD (mobile ver.)');
  assert(mob.stations.length === 1 && mob.stations[0].name === 'Real channel',
    `embed:true stations excluded, only the real stream remains: ${JSON.stringify(mob.stations)}`);
  assert(stats.embedded === 2, `embed counter: ${stats.embedded}, expected 2`);

  assert(root.counts.stations === 3 + 2 + 2 + 2 + 2 + 1, `conteggi: ${root.counts.stations}`);

  // --- v1.5.6: User-Agent personalizzato --------------------------------------
  const customUa = 'VLC/3.0.20 LibVLC/3.0.20';
  await buildTree(`${BASE}/ua.m3u`, { userAgent: customUa });
  assert(lastUa === customUa, `per-request UA sent to the panel: ${lastUa}`);

  UA.setCustomUserAgent('GlobalUA/9.9');
  await buildTree(`${BASE}/ua.m3u`);
  assert(lastUa === 'GlobalUA/9.9', `global UA from settings: ${lastUa}`);
  UA.setCustomUserAgent('');
  await buildTree(`${BASE}/ua.m3u`);
  assert(/WiseM3U\//.test(lastUa), `default UA restored: ${lastUa}`);

  const dirty = UA.setCustomUserAgent('Evil\r\nX-Injected: 1');
  assert(!/[\r\n]/.test(dirty) && !dirty.includes(': 1\n'), `UA stripped of CR/LF (header injection): "${dirty}"`);
  UA.setCustomUserAgent('');

  // --- v1.5.2: huge / non-playlist responses -------------------------------
  const t0 = Date.now();
  let eVideo = null;
  try { await buildTree(`${BASE}/big-video.mp4`); } catch (e) { eVideo = e; }
  const dtVideo = Date.now() - t0;
  assert(eVideo && eVideo.fatal === true, `video with Content-Length -> definitive error (${eVideo && eVideo.message.slice(0, 60)}…)`);
  assert(/VIDEO FILE/i.test((eVideo && eVideo.message) || ''), 'the message says it is a VIDEO FILE, not a playlist');
  assert(/get\.php/.test((eVideo && eVideo.message) || ''), 'the message suggests the correct Xtream link');
  assert(dtVideo < 1200, `rejected WITHOUT retry or full download: ${dtVideo} ms`);

  const before = videoBytesSent;
  const t1 = Date.now();
  let eLive = null;
  try { await buildTree(`${BASE}/endless.ts`); } catch (e) { eLive = e; }
  const dtLive = Date.now() - t1;
  const sentForLive = videoBytesSent - before;
  await new Promise((r) => setTimeout(r, 40));
  assert(eLive && eLive.fatal === true, `stream without Content-Length -> definitive error (${eLive && eLive.message.slice(0, 60)}…)`);
  assert(sentForLive < 2 * 1024 * 1024, `did not read the stream forever: ${(sentForLive / 1024).toFixed(0)} KB before the stop`);
  assert(dtLive < 1500, `stopped in ${dtLive} ms`);
  assert(endlessClosed, 'live socket closed on our side (no phantom download)');

  // --- v1.5.3: gzip nudo, UTF-16, archivi ------------------------------------
  const gzTree = await buildTree(`${BASE}/list.m3u.gz`);
  assert(gzTree.stats.stations === 2, `m3u in gzip served as octet-stream imported (${gzTree.stats.stations} channels)`);
  const u16Tree = await buildTree(`${BASE}/utf16.m3u`);
  assert(u16Tree.stats.stations === 2, `m3u in UTF-16LE with BOM imported (${u16Tree.stats.stations} channels)`);

  const tZip = Date.now();
  let eZip = null;
  try { await buildTree(`${BASE}/archivio.zip`); } catch (e) { eZip = e; }
  assert(eZip && eZip.fatal === true && /ZIP ARCHIVE/i.test(eZip.message),
    `zip -> definitive error saying ZIP ARCHIVE (${(eZip && eZip.message.slice(0, 70))}…)`);
  assert(Date.now() - tZip < 1200, `zip rejected after a few KB, not after the download (${Date.now() - tZip} ms)`);

  // --- v1.5.4: m3u enorme in streaming ---------------------------------------
  const tBig = Date.now();
  const big = await buildTree(`${BASE}/big-live.m3u`);
  const dtBig = Date.now() - tBig;
  await new Promise((r) => setTimeout(r, 50));
  assert(big.stats.stations === 1000, `huge m3u: imported ${big.stats.stations} channels (cap 1000)`);
  assert(big.stats.truncated === true, 'huge m3u: stats.truncated = true');
  assert(big.children.length === 40, `huge m3u: ${big.children.length} LIVE groups preserved`);
  assert(bigLiveSent < BIG_LIVE_TOTAL * 0.6,
    `stopped without downloading everything: ${(bigLiveSent / 1024).toFixed(0)} KB of ~${(BIG_LIVE_TOTAL / 1024).toFixed(0)} KB`);
  assert(bigLiveClosed, 'connection closed on our side after the cap (no phantom download)');
  assert(dtBig < 5000, `import in streaming in ${dtBig} ms`);

  // huge text: collectCapped with an explicit 1 MB limit (in production
  // the limit is 60 MB, but real m3u files go through the streaming parser)
  let eHuge = null;
  const bigText = (async function* () {
    for (let i = 0; i < 12; i++) yield Buffer.from('text line is not a playlist ' + 'x'.repeat(100 * 1024));
  })();
  try { await __test.collectCapped(bigText, 'text/plain', 0, 1024 * 1024); } catch (e) { eHuge = e; }
  assert(eHuge && eHuge.fatal === true, 'text over the limit -> definitive error');
  assert(/limit/i.test((eHuge && eHuge.message) || '') && /1 MB/.test((eHuge && eHuge.message) || ''),
    `the message explains the size limit: ${(eHuge && eHuge.message.slice(0, 100))}…`);

  mock.close();
  console.log(failures ? `\n${failures} TESTS FAILED ✖` : '\nALL WISEPLAY TESTS PASSED ✔');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
