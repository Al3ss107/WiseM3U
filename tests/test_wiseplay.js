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
 */
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { buildTree, parseLenientJson } = require(path.join(REPO, 'src', 'wiseplay'));

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
  const mock = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
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

  mock.close();
  console.log(failures ? `\n${failures} TEST FALLITI ✖` : '\nTUTTI I TEST WISEPLAY PASSATI ✔');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERRORE TEST:', e); process.exit(1); });
