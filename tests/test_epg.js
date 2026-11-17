#!/usr/bin/env node
'use strict';

/**
 * XMLTV / Native EPG tests: parser/matching plus a real addon flow.
 *
 * The mock M3U declares tvg-id="canale5.it" and its own x-tvg-url; the mock
 * XMLTV guide offers a programme around "now". The test checks:
 *   - manifest opt-in (epgProvider + catalog date extra);
 *   - meta.videos with startTime/endTime and Now/Next in the description;
 *   - /catalog/.../date=YYYY-MM-DD.json returns metasDetailed.
 */
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const epg = require(path.join(REPO, 'src', 'epg'));

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log('PASS ' + message); }
  else { fail++; console.log('FAIL ' + message); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function xmltvTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

(async () => {
  // ---- parser and matching (no server needed) ----
  const now = Date.now();
  const start = now - 30 * 60 * 1000;
  const stop = now + 30 * 60 * 1000;
  const guideXml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="canale5.it"><display-name>Canale 5 HD.it</display-name></channel>
  <programme start="${xmltvTime(start)}" stop="${xmltvTime(stop)}" channel="canale5.it">
    <title lang="it">Test Programme</title><desc>Live test</desc><category>News</category>
  </programme>
</tv>`;

  const parsed = epg.parseXmltv(guideXml);
  ok(parsed && parsed.programmes === 1, 'parser reads one programme');
  ok(epg.match(parsed, { name: 'CANALE 5 (1)' }).id === 'canale5.it', 'matches by normalized channel name');
  ok(epg.match(parsed, { tvgId: 'canale5.it' }).id === 'canale5.it', 'matches by tvg-id');
  ok(epg.programmesBetween(parsed, { name: 'CANALE 5 (1)' }, start, stop).length === 1, 'programme overlaps the requested window');
  ok(epg.descriptionLine(parsed, { name: 'CANALE 5 (1)' }, now).includes('Now: Test Programme'), 'description exposes Now');
  ok(epg.__test.cleanUrl('https://github.com/o/r/blob/main/epg.xml') === 'https://raw.githubusercontent.com/o/r/main/epg.xml', 'GitHub blob URL converted to raw');

  // ---- integration ----
  const appPort = await freePort();
  const epgPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  const token = 'epg-test';
  const epgUrl = `http://127.0.0.1:${epgPort}/epg.xml`;
  const api = async (pathname, options = {}) => {
    const sep = pathname.includes('?') ? '&' : '?';
    const res = await fetch(`${base}${pathname}${sep}token=${token}`, {
      headers: { 'Content-Type': 'application/json' }, ...options,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };

  const guideServer = http.createServer((req, res) => {
    if (req.url.startsWith('/epg.xml')) {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.end(guideXml.replace('canale5.it', 'canale5.it'));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => guideServer.listen(epgPort, '127.0.0.1', resolve));

  const listServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.end([
      `#EXTM3U x-tvg-url="${epgUrl}"`,
      '#EXTINF:-1 tvg-id="canale5.it" tvg-name="Canale 5" group-title="Mediaset",CANALE 5 (1)',
      'http://127.0.0.1:9/canale5.m3u8',
      '',
    ].join('\n'));
  });
  const listPort = await freePort();
  await new Promise((resolve) => listServer.listen(listPort, '127.0.0.1', resolve));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-epg-'));
  const app = spawn('node', [path.join(REPO, 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(appPort), HOST: '127.0.0.1',
      CONFIG_FILE: path.join(dir, 'config.json'),
      CACHE_DIR: path.join(dir, 'cache'),
      ADMIN_TOKEN: token, LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${base}/healthz`)).ok; } catch (_) { /* starting */ }
    if (!up) await sleep(100);
  }
  ok(up, 'server started');
  if (!up) { app.kill(); guideServer.close(); listServer.close(); process.exit(1); }

  try {
    const added = await api('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ url: `http://127.0.0.1:${listPort}/list.m3u`, name: 'EPG list' }),
    });
    const listId = added.body.list && added.body.list.id;
    ok(added.status === 200 && listId, 'list added');

    let state = null;
    for (let i = 0; i < 80; i++) {
      state = await api(`/api/lists/${listId}/state`);
      if (state.body.status === 'ready') break;
      await sleep(100);
    }
    ok(state && state.body.status === 'ready', 'list downloaded');

    const cfg = (await api('/api/config')).body;
    const saved = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        baseRev: cfg.rev,
        settings: { epgUrl },
        lists: cfg.lists,
        reason: 'EPG URL',
      }),
    });
    ok(saved.status === 200 && saved.body.settings.epgUrl === epgUrl, 'EPG URL saved in the general settings');

    const manifest = await api('/manifest.json');
    ok(manifest.body.behaviorHints && manifest.body.behaviorHints.epgProvider === true, 'manifest opts in to Native EPG');
    const catalog = manifest.body.catalogs.find((c) => c.id === `wise:${listId}`);
    ok(catalog && (catalog.extra || []).some((e) => e.name === 'date'), 'catalog declares the date extra');

    const preview = await api(`/catalog/tv/wise:${listId}.json`);
    ok(preview.status === 200 && Array.isArray(preview.body.metas) && preview.body.metas.length === 1, 'channel catalog still returns metas');
    const metaId = preview.body.metas[0].id;

    const meta = await api(`/meta/tv/${encodeURIComponent(metaId)}.json`);
    ok(meta.status === 200 && meta.body.meta, 'meta returned');
    ok(meta.body.meta.behaviorHints && meta.body.meta.behaviorHints.hasScheduledVideos === true, 'meta advertises scheduled videos');
    ok(Array.isArray(meta.body.meta.videos) && meta.body.meta.videos.length >= 1, 'meta contains programme videos');
    const video = meta.body.meta.videos && meta.body.meta.videos[0];
    ok(video && video.startTime && video.endTime && Date.parse(video.endTime) > Date.parse(video.startTime), 'programme has valid start/end times');
    ok(String(meta.body.meta.description || '').includes('Now: Test Programme'), 'meta description shows Now');

    const programmeStream = await api(`/stream/tv/${encodeURIComponent(video.id)}.json`);
    ok(programmeStream.status === 200 && programmeStream.body.streams.length === 1, 'programme id still resolves to the channel stream');

    const search = await api(`/catalog/tv/wise:${listId}/search=canale.json`);
    ok(search.status === 200 && String(search.body.metas[0].description || '').includes('Now:'), 'search result description shows Now');

    const day = new Date().toISOString().slice(0, 10);
    const dated = await api(`/catalog/tv/wise:${listId}/date=${day}.json`);
    ok(dated.status === 200 && Array.isArray(dated.body.metasDetailed), 'dated catalog returns metasDetailed');
    const detailed = dated.body.metasDetailed && dated.body.metasDetailed[0];
    ok(detailed && Array.isArray(detailed.videos) && detailed.videos.length >= 1, 'dated catalog contains programme videos');
    ok(detailed && detailed.behaviorHints && detailed.behaviorHints.hasScheduledVideos === true, 'dated rows advertise scheduled videos');
  } finally {
    app.kill();
    guideServer.close();
    listServer.close();
  }

  console.log('');
  console.log(fail === 0 ? `ALL EPG TESTS PASSED (${pass})` : `${fail} EPG TESTS FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
