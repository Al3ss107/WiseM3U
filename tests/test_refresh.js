#!/usr/bin/env node
'use strict';
/**
 * Refresh policy: one effective interval per list (global default or custom
 * override), legacy migration, safe minimums and stale-while-revalidate.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const REPO = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-refresh-'));
process.env.CACHE_DIR = path.join(tmp, 'cache');
const {
  defaultConfig,
  defaultListOptions,
  normalizeConfig,
  normalizeList,
  effectiveRefreshMinutes,
  MIN_REFRESH_MINUTES,
} = require(path.join(REPO, 'src', 'config.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };

(async () => {
  ok(defaultConfig().settings.refreshMinutes === 360, 'global default is 6 hours');
  ok(defaultListOptions().refreshMode === 'inherit', 'new lists inherit the global interval');
  ok(!('cacheTtlMinutes' in defaultConfig().settings), 'no separate cache TTL');
  ok(!('autoRefreshMinutes' in defaultConfig().settings), 'no separate scheduler interval');

  const legacy = normalizeConfig({
    version: 2,
    settings: { autoRefreshMinutes: 180, cacheTtlMinutes: 1440 },
    lists: [
      { id: 'default', url: 'http://example.com/a.m3u', options: { refreshMinutes: 1440 } },
      { id: 'custom', url: 'http://example.com/b.m3u', options: { refreshMinutes: 1 } },
      { id: 'off', url: 'http://example.com/c.m3u', options: { refreshMinutes: 0 } },
    ],
  });
  ok(legacy.settings.refreshMinutes === 360, 'legacy install gets the new 6-hour default');
  ok(!('cacheTtlMinutes' in legacy.settings) && !('autoRefreshMinutes' in legacy.settings), 'legacy fields are removed');
  ok(legacy.lists[0].options.refreshMode === 'inherit', 'old default 1440 migrates to inherit');
  ok(legacy.lists[1].options.refreshMode === 'custom', 'explicit old value migrates to custom');
  ok(legacy.lists[1].options.refreshMinutes === MIN_REFRESH_MINUTES, 'legacy 1 minute is raised to the safe minimum');
  ok(legacy.lists[2].options.refreshMode === 'inherit', 'legacy 0 migrates to inherit');

  const customGlobal = normalizeConfig({ settings: { cacheTtlMinutes: 60, autoRefreshMinutes: 180 } });
  ok(customGlobal.settings.refreshMinutes === 60, 'legacy non-default cache TTL becomes the global interval');

  const manual = normalizeConfig({
    settings: { autoRefreshMinutes: 0 },
    lists: [{ id: 'm', url: 'http://example.com/x.m3u' }],
  });
  ok(manual.settings.refreshMinutes === 0, 'legacy auto-refresh=0 becomes manual only');
  ok(effectiveRefreshMinutes(manual.lists[0], manual.settings) === 0, 'inherit + global 0 = manual');

  const explicit = normalizeConfig({
    settings: { refreshMinutes: 90 },
    lists: [
      { id: 'a', url: 'http://example.com/a.m3u', options: { refreshMode: 'inherit' } },
      { id: 'b', url: 'http://example.com/b.m3u', options: { refreshMode: 'custom', refreshMinutes: 15 } },
      { id: 'c', url: 'http://example.com/c.m3u', options: { refreshMode: 'manual', refreshMinutes: 15 } },
    ],
  });
  ok(explicit.settings.refreshMinutes === 90, 'explicit global interval is kept');
  ok(effectiveRefreshMinutes(explicit.lists[0], explicit.settings) === 90, 'inherit uses the global interval');
  ok(effectiveRefreshMinutes(explicit.lists[1], explicit.settings) === 15, 'custom overrides the global interval');
  ok(effectiveRefreshMinutes(explicit.lists[2], explicit.settings) === 0, 'manual disables automatic refresh');
  ok(normalizeList({ id: 'x', url: 'http://example.com/x.m3u', options: { refreshMode: 'custom', refreshMinutes: 1 } }).options.refreshMinutes === 5, 'custom interval has a 5-minute minimum');

  // Per-list options: catalog name was removed, EPG accepts http(s) only.
  const oldCatalog = normalizeList({ id: 'c', url: 'http://example.com/c.m3u', options: { catalogName: 'Old name' } });
  ok(!('catalogName' in oldCatalog.options), 'legacy catalog name is dropped');
  const epgList = normalizeList({
    id: 'e', url: 'http://example.com/e.m3u',
    options: { epgUrl: 'https://github.com/o/r/blob/main/guide.xml' },
  });
  ok(epgList.options.epgUrl === 'https://raw.githubusercontent.com/o/r/main/guide.xml', 'list EPG URL is normalized (GitHub blob -> raw)');
  ok(normalizeList({ id: 'f', url: 'http://example.com/f.m3u', options: { epgUrl: 'ftp://example.com/guide.xml' } }).options.epgUrl === '', 'non-http list EPG is discarded');

  // ---- stale-while-revalidate ----
  let body = '#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="News",One\nhttp://example.com/one.m3u8\n';
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cache = require(path.join(REPO, 'src', 'cache.js'));

  const first = await cache.getTree({ id: 'swr', url: `http://127.0.0.1:${port}/list.m3u`, ttlMinutes: 360, maxDepth: 2 });
  ok(first && first.tree && first.tree.stats.stations === 1, 'first read downloads the list');
  const firstAt = first.fetchedAt;
  ok(hits === 1, 'first read performs one request');

  body = '#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="News",One\nhttp://example.com/one.m3u8\n#EXTINF:-1 tvg-id="two" group-title="News",Two\nhttp://example.com/two.m3u8\n';
  const stale = await cache.getTree({ id: 'swr', url: `http://127.0.0.1:${port}/list.m3u`, ttlMinutes: 0, maxDepth: 2, staleWhileRevalidate: true });
  ok(stale.fetchedAt === firstAt && stale.tree.stats.stations === 1, 'stale read returns the cached copy immediately');
  let fresh = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const got = await cache.getTree({ id: 'swr', url: `http://127.0.0.1:${port}/list.m3u`, ttlMinutes: 360, maxDepth: 2 });
    if (got.fetchedAt !== firstAt) { fresh = got; break; }
  }
  ok(!!fresh && fresh.tree.stats.stations === 2, 'background refresh replaces the cached copy');
  ok(hits >= 2, 'background refresh performs a second request');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nALL REFRESH TESTS PASSED (${pass})`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('FAIL refresh test crashed:', err);
  process.exit(1);
});
