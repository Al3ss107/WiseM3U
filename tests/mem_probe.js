#!/usr/bin/env node
'use strict';
/**
 * Profilazione memoria WiseM3U: costo per-stazione dell'albero (che è ciò che
 * resta in RAM per tutta la vita del container, per OGNI lista caricata).
 * Esegui con: node --expose-gc tests/mem_probe.js
 */
const http = require('http');
const path = require('path');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..');
const { buildTree, flattenStations, treeForUi } = require(path.join(REPO, 'src', 'wiseplay'));

const N = 9000;      // canali per lista
const GROUPS = 120;
const LISTS = 3;

function makeM3u(n, seed) {
  const parts = ['#EXTM3U'];
  for (let i = 0; i < n; i++) {
    parts.push(`#EXTINF:-1 tvg-logo="http://logo.srv/${(i + seed) % 60}.png" group-title="Gruppo ${i % GROUPS}",Canale ${seed} ${i}`);
    parts.push(`http://127.0.0.1:9808/live/user_${seed}_${i}/pass/ch_${i}.ts?id=${'y'.repeat(24)}`);
  }
  return parts.join('\n');
}

function mb(v) { return Math.round(v / 1048576); }
function report(tag) {
  global.gc(); global.gc();
  const m = process.memoryUsage();
  console.log(`${tag.padEnd(34)} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}MB heapTot=${mb(m.heapTotal)}MB ext=${mb(m.external)}MB`);
  return mb(m.rss);
}

(async () => {
  const srv = http.createServer((req, res) => {
    const seed = Number((req.url.match(/l(\d+)/) || [])[1]) || 0;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(makeM3u(N, seed));
  });
  await new Promise((r) => srv.listen(9808, '127.0.0.1', r));

  const base = report('boot');
  const trees = [];
  for (let l = 0; l < LISTS; l++) {
    trees.push(await buildTree(`http://127.0.0.1:9808/lista_l${l}.m3u`, { maxDepth: 5 }));
    report(`dopo buildTree lista ${l + 1} (+${N} stazioni)`);
  }
  const ui = trees.map((t) => treeForUi(t));
  report('dopo +ui (treeForUi)');
  const rows = trees.map((t) =>
    flattenStations(t, () => true, { maxDepth: 8, joiner: ' › ', prefix: '[A]', emitLogo: true })
  );
  report('dopo +rows memoized (flatten per lista)');
  const gzs = trees.map((t) => zlib.gzipSync(JSON.stringify(t)));
  report('dopo +snapshot gz (transiente)');
  gzs.length = 0;
  report('snapshot liberati');

  const rowsObj = rows[0].rows || rows[0];
  console.log(`\nlet ai totali: ${LISTS} liste x ${N} = ${LISTS * N} stazioni in RAM`);
  const rssNow = 0;
  report('fine misura');
  console.log(`delta totale dal boot: RSS = ${report('conferma') - base} MB (≈ ${(process.memoryUsage.rss() / (+base * 1048576 + 1)).toFixed(2)}x boot)`);
  console.log(`costo medio: ${Math.round((process.memoryUsage.rss() - base * 1048576) / (LISTS * N))} byte/stazione (tree+ui+rows)`);
  srv.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
