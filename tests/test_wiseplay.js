#!/usr/bin/env node
'use strict';
/**
 * Test compatibilita' "liste a catena" tipo NeroZone (v1.4.8)
 * ============================================================
 * Replica i difetti reali trovati nei gist segnalati dall'utente:
 *  - JSON non stretto: virgola finale `},]` e elemento vuoto `, ,` (ramo SPORT)
 *  - gruppo radice con "import": false (WisePlay = caricamento lazy: noi lo
 *    risolviamo comunque, e' l'unico modo per mostrare il contenuto)
 *  - root con "url" che punta a se stessa (solo meta, NON deve ciclare)
 *  - stazioni "embed": true (pagine web Serially/Plex/...): non stream, escluse
 *  - URL m3u con SPAZIO finale: il trim deve salvarlo
 *  - v1.5.2 risposta enorme (video/archivio/binario incollato al posto della
 *    lista): errore DEFINITIVO e immediato, senza scaricare tutto e senza retry
 *  - v1.5.4 liste Xtream enormi (581 MB di testo): import in STREAMING,
 *    senza tetto di MB, fermato dal numero di canali e senza scaricare tutto
 */
const http = require('http');
const path = require('path');
const zlib = require('zlib');

// limite piccolo: testiamo in pochi KB il comportamento "risposta enorme"
// (in produzione 60 MB) senza scaricare centinaia di MB
process.env.WISEM3U_MAX_LIST_BYTES = String(512 * 1024);
// tetto canali basso: verifichiamo il troncamento senza generare 150.000 voci
process.env.WISEM3U_MAX_STATIONS = '1000';

const REPO = path.resolve(__dirname, '..');
const { buildTree, parseLenientJson } = require(path.join(REPO, 'src', 'wiseplay'));
const UA = require(path.join(REPO, 'src', 'constants'));

const MOCK_PORT = 9853;
const BASE = `http://127.0.0.1:${MOCK_PORT}`;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.log(`FAIL  ${msg}`); }
  else console.log(`PASS  ${msg}`);
}

// index.php: radice con url che punta a SE STESSA + ramo ENTRA con import:false
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

// inizio.json: JSON ROTTO come nel gist reale: },] finale e , , nel ramo SPORT
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
      "name": "VOD (vers. mobile)",
      "stations": [
        { "name": "Serially", "url": "https://serially.it/", "embed": "true" },
        { "name": "Plex tv", "url": "https://watch.plex.tv/it", "embed": true },
        { "name": "Canale vero", "url": "acestream://abcdef0123456789abcdef0123456789abcdef01" }
      ]
    },
  ]
}`;

// vod.json sottolista: guard ring di virgola finale anche qui
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
    p.push(`#EXTINF:-1 group-title="G${tag}",Canale ${tag} ${i}`);
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

    // finto file video con Content-Length esplicito (caso reale: film .mp4
    // incollato al posto della lista). Il client deve rifiutare SENZA scaricare.
    if (pathname === '/big-video.mp4') {
      const body = Buffer.alloc(768 * 1024, 0x47); // 768 KB (> limite test 512 KB)
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
      res.on('close', () => { /* client ha annullato */ });
      return res.end(body);
    }
    // stream "infinito" senza Content-Length (tipico live .ts): deve essere
    // interrotto appena supera il limite, non letto fino alla fine
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
    // m3u ENORME in streaming (replica del pannello Xtream da 581 MB): deve
    // essere importato fino al tetto canali e poi interrotto, senza leggere tutto
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
            `#EXTINF:-1 tvg-id="c${i}" tvg-name="Canale ${i}" tvg-logo="http://logo/${i}.png" group-title="LIVE ${i % 40}",Canale ${i}\n` +
            `http://example.test/live/${i}.ts\n`;
        }
        bigLiveSent += Buffer.byteLength(block);
        res.write(block);
      }, 1);
      res.on('close', () => { clearInterval(t); bigLiveClosed = true; });
      return;
    }

    // testo enorme in chunked encoding (NON una playlist): qui vale il tetto MB
    if (pathname === '/huge.m3u') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      let n = 0;
      const line = 'riga di testo che non e\' una playlist ' + 'x'.repeat(100) + '\n';
      const t = setInterval(() => {
        if (res.destroyed || n++ > 20000) { clearInterval(t); return res.end(); }
        res.write(line);
      }, 1);
      res.on('close', () => clearInterval(t));
      return;
    }

    // m3u servita in gzip "nudo" (application/octet-stream, senza
    // Content-Encoding): molti pannelli la distribuiscono cosi'
    if (pathname === '/list.m3u.gz') {
      const gz = zlib.gzipSync(Buffer.from(M3U(2, 'gzip')));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(gz);
    }
    // m3u in UTF-16LE con BOM (pannelli legacy)
    if (pathname === '/utf16.m3u') {
      const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(M3U(2, 'u16'), 'utf16le')]);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(body);
    }
    // archivio ZIP al posto della playlist
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

  // --- unit: il sanitizer non deve corrompere le stringhe -------------------
  const mixed = '{"x":"virgola, ] dentro la stringa","y":"a,,b","list":[1,2,]}';
  const ok = parseLenientJson(mixed);
  assert(ok && ok.x === 'virgola, ] dentro la stringa' && ok.y === 'a,,b' && ok.list.length === 2,
    'sanitizer: virgole finali tolte ma stringhe simili intatte');

  const hole = parseLenientJson('{"a":[{\n},\n,\n{ "b": 1 }\n],\n}');
  assert(hole && hole.a.length === 2 && hole.a[1].b === 1, 'array con elemento vuoto (, ,) recuperato');

  // --- integrazione: la catena NeroZone intera ------------------------------
  const { root, stats, errors } = await buildTree(`${BASE}/raw/index.php`);

  const entra = root.children.find((c) => c.name === 'ENTRA');
  assert(entra, 'ramo ENTRA presente (import:false ignorato come in WisePlay)');
  assert(!entra.error, `ENTRA non in errore (${entra.error || 'ok'})`);
  assert(!errors.some((e) => /JSON non valido/.test(e.error)),
    `nessun 'JSON non valido' nella catena: ${JSON.stringify(errors)}`);

  const names = entra.children.map((c) => c.name);
  assert(['TV', 'SPORT', 'VOD', 'VOD (vers. mobile)'].every((n) => names.includes(n)),
    `famiglie TV/SPORT/VOD presenti: ${names.join('|')}`);

  const tv = entra.children.find((c) => c.name === 'TV');
  const sky = tv.children.find((c) => c.name === 'SKY (TEST)');
  assert(sky && sky.stations.length === 3, `SKY (TEST) ha 3 canali (${sky && sky.stations.length})`);

  const rak = tv.children.find((c) => c.name === 'RAKUTEN TV');
  assert(rak && rak.stations.length === 2, `URL con spazio finale trimmato, RAKUTEN ok (${rak && rak.stations.length})`);

  const sport = entra.children.find((c) => c.name === 'SPORT');
  const sportHosts = sport.children.filter((c) => c.name.startsWith('EVENTI SPORT'));
  assert(sportHosts.length === 2 && sportHosts.every((h) => h.stations.length === 2),
    `ramo SPORT recuperato nonostante l'elemento vuoto (${sportHosts.length} host)`);

  const vod = entra.children.find((c) => c.name === 'VOD');
  assert(vod && vod.children[0] && vod.children[0].stations.length === 2,
    'sottolista vod.json (WisePlay annidata con trailing comma) parsata');

  const mob = entra.children.find((c) => c.name === 'VOD (vers. mobile)');
  assert(mob.stations.length === 1 && mob.stations[0].name === 'Canale vero',
    `stazioni embed:true escluse, resta solo lo stream vero: ${JSON.stringify(mob.stations)}`);
  assert(stats.embedded === 2, `contatore embed: ${stats.embedded} atteso 2`);

  assert(root.counts.stations === 3 + 2 + 2 + 2 + 2 + 1, `conteggi: ${root.counts.stations}`);

  // --- v1.5.6: User-Agent personalizzato --------------------------------------
  const customUa = 'VLC/3.0.20 LibVLC/3.0.20';
  await buildTree(`${BASE}/ua.m3u`, { userAgent: customUa });
  assert(lastUa === customUa, `UA per-richiesta inviata al pannello: ${lastUa}`);

  UA.setCustomUserAgent('GlobalUA/9.9');
  await buildTree(`${BASE}/ua.m3u`);
  assert(lastUa === 'GlobalUA/9.9', `UA globale dalle impostazioni: ${lastUa}`);
  UA.setCustomUserAgent('');
  await buildTree(`${BASE}/ua.m3u`);
  assert(/WiseM3U\//.test(lastUa), `UA di default ripristinata: ${lastUa}`);

  const dirty = UA.setCustomUserAgent('Evil\r\nX-Injected: 1');
  assert(!/[\r\n]/.test(dirty) && !dirty.includes(': 1\n'), `UA ripulita da CR/LF (header injection): "${dirty}"`);
  UA.setCustomUserAgent('');

  // --- v1.5.2: risposte enormi / non-playlist ---------------------------------
  const t0 = Date.now();
  let eVideo = null;
  try { await buildTree(`${BASE}/big-video.mp4`); } catch (e) { eVideo = e; }
  const dtVideo = Date.now() - t0;
  assert(eVideo && eVideo.fatal === true, `video con Content-Length -> errore definitivo (${eVideo && eVideo.message.slice(0, 60)}…)`);
  assert(/FILE VIDEO/i.test((eVideo && eVideo.message) || ''), 'il messaggio dice che e\' un FILE VIDEO, non una playlist');
  assert(/get\.php/.test((eVideo && eVideo.message) || ''), 'il messaggio suggerisce il link Xtream corretto');
  assert(dtVideo < 1200, `rifiutato SENZA retry ne download completo: ${dtVideo} ms`);

  const before = videoBytesSent;
  const t1 = Date.now();
  let eLive = null;
  try { await buildTree(`${BASE}/endless.ts`); } catch (e) { eLive = e; }
  const dtLive = Date.now() - t1;
  const sentForLive = videoBytesSent - before;
  await new Promise((r) => setTimeout(r, 40));
  assert(eLive && eLive.fatal === true, `stream senza Content-Length -> errore definitivo (${eLive && eLive.message.slice(0, 60)}…)`);
  assert(sentForLive < 2 * 1024 * 1024, `non ha letto lo stream all'infinito: ${(sentForLive / 1024).toFixed(0)} KB prima dello stop`);
  assert(dtLive < 1500, `interrotto in ${dtLive} ms`);
  assert(endlessClosed, 'socket del live chiuso dal nostro lato (niente download fantasma)');

  // --- v1.5.3: gzip nudo, UTF-16, archivi ------------------------------------
  const gzTree = await buildTree(`${BASE}/list.m3u.gz`);
  assert(gzTree.stats.stations === 2, `m3u in gzip servita come octet-stream importata (${gzTree.stats.stations} canali)`);
  const u16Tree = await buildTree(`${BASE}/utf16.m3u`);
  assert(u16Tree.stats.stations === 2, `m3u in UTF-16LE con BOM importata (${u16Tree.stats.stations} canali)`);

  const tZip = Date.now();
  let eZip = null;
  try { await buildTree(`${BASE}/archivio.zip`); } catch (e) { eZip = e; }
  assert(eZip && eZip.fatal === true && /ARCHIVIO ZIP/i.test(eZip.message),
    `zip -> errore definitivo che dice ARCHIVIO ZIP (${(eZip && eZip.message.slice(0, 70))}…)`);
  assert(Date.now() - tZip < 1200, `zip rifiutato dopo pochi KB, non dopo il download (${Date.now() - tZip} ms)`);

  // --- v1.5.4: m3u enorme in streaming ---------------------------------------
  const tBig = Date.now();
  const big = await buildTree(`${BASE}/big-live.m3u`);
  const dtBig = Date.now() - tBig;
  await new Promise((r) => setTimeout(r, 50));
  assert(big.stats.stations === 1000, `m3u enorme: importati ${big.stats.stations} canali (tetto 1000)`);
  assert(big.stats.truncated === true, 'm3u enorme: stats.truncated = true');
  assert(big.children.length === 40, `m3u enorme: ${big.children.length} gruppi LIVE preservati`);
  assert(bigLiveSent < BIG_LIVE_TOTAL * 0.6,
    `interrotto senza scaricare tutto: ${(bigLiveSent / 1024).toFixed(0)} KB su ~${(BIG_LIVE_TOTAL / 1024).toFixed(0)} KB`);
  assert(bigLiveClosed, 'connessione chiusa dal nostro lato dopo il tetto (niente download fantasma)');
  assert(dtBig < 5000, `import in streaming in ${dtBig} ms`);

  let eHuge = null;
  try { await buildTree(`${BASE}/huge.m3u`); } catch (e) { eHuge = e; }
  assert(eHuge && eHuge.fatal === true, 'testo enorme in chunked -> errore definitivo');
  assert(/limite/i.test((eHuge && eHuge.message) || '') && /MB/i.test((eHuge && eHuge.message) || ''),
    `il messaggio spiega il limite di dimensione: ${(eHuge && eHuge.message.slice(0, 90))}…`);

  mock.close();
  console.log(failures ? `\n${failures} TEST FALLITI ✖` : '\nTUTTI I TEST WISEPLAY PASSATI ✔');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERRORE TEST:', e); process.exit(1); });
