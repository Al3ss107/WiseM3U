#!/usr/bin/env node
'use strict';

/**
 * URL normalization and HTML-page detection.
 *
 * GitHub file pages are HTML: if pasted as M3U, the old parser imported the
 * HTML tags as channels. This suite locks the raw-link conversion and the
 * explicit error for preview/tree pages.
 */
const http = require('http');
const path = require('path');
const { normalizeSourceUrl, decodeHtmlAmp } = require(path.resolve(__dirname, '..', 'src', 'urls'));
const { buildTree } = require(path.resolve(__dirname, '..', 'src', 'wiseplay'));
const { normalizeList } = require(path.resolve(__dirname, '..', 'src', 'config'));

let pass = 0, fail = 0;
const ok = (condition, message) => {
  if (condition) { pass++; console.log('PASS ' + message); }
  else { fail++; console.log('FAIL ' + message); }
};

(async () => {
  ok(
    normalizeSourceUrl('https://github.com/owner/repo/blob/main/list.m3u') ===
      'https://raw.githubusercontent.com/owner/repo/main/list.m3u',
    'GitHub blob link becomes the raw file URL'
  );
  ok(
    normalizeSourceUrl('https://github.com/owner/repo/tree/main') === 'https://github.com/owner/repo/tree/main',
    'GitHub tree links are left alone (and rejected as HTML later)'
  );
  ok(
    normalizeSourceUrl('http://example.com/get.php?username=u&amp;password=p') ===
      'http://example.com/get.php?username=u&password=p',
    'HTML-escaped ampersands are decoded'
  );
  ok(
    normalizeList({ url: 'https://github.com/owner/repo/blob/main/list.m3u' }).url ===
      'https://raw.githubusercontent.com/owner/repo/main/list.m3u',
    'configuration normalizes GitHub links before saving'
  );
  ok(decodeHtmlAmp('a&#38;b') === 'a&b', 'numeric ampersand entity is decoded');

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!DOCTYPE html><html lang="en"><head><title>repo</title></head><body>files</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let error = null;
  try {
    // the extension would once have forced the M3U parser and imported HTML tags
    await buildTree(`http://127.0.0.1:${port}/list.m3u`);
  } catch (err) {
    error = err;
  }
  ok(!!error, 'HTML page is rejected');
  ok(error && /HTML WEB PAGE/i.test(error.message), 'error explains that the page is HTML');
  ok(error && error.fatal === true, 'HTML error is marked fatal (no pointless retry)');
  server.close();

  let folderError = null;
  try {
    await buildTree('https://github.com/owner/repo/tree/main');
  } catch (err) {
    folderError = err;
  }
  ok(folderError && /FOLDER page/i.test(folderError.message), 'GitHub folder page is rejected before any download');

  console.log('');
  console.log(fail === 0 ? `ALL URL TESTS PASSED (${pass})` : `${fail} URL TESTS FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
