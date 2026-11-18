'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const { resolveViaPublicDns } = require('./wiseplay');

/**
 * Server-side request to EasyProxy. The URL field accepts an IP *or* a domain:
 *  - IP: direct connection;
 *  - domain: container DNS first; if unknown (private DNS not visible from
 *    Docker) it retries with public DNS, still presenting the domain in
 *    SNI/Host so the nginx vhost answers correctly.
 *
 * Stream rewriting is textual only: the client connects. The server-side fetch
 * happens only for the Test button.
 */
function easyProxyFetch(base, urlPath, { password = '', timeout = 8000 } = {}) {
  let url;
  try {
    url = new URL(base + urlPath);
  } catch (_) {
    return Promise.reject(new Error('invalid URL'));
  }
  if (password) url.searchParams.set('api_password', password);

  const isHttps = url.protocol === 'https:';
  const port = Number(url.port) || (isHttps ? 443 : 80);
  const hostname = url.hostname;

  const doRequest = (hostOverride) => new Promise((resolve, reject) => {
    const byIp = !!hostOverride && hostOverride !== hostname;
    const options = {
      host: hostOverride || hostname,
      port,
      path: url.pathname + (url.search || ''),
      method: 'GET',
      timeout,
      headers: {
        'user-agent': 'WiseM3U',
        // Connected by IP: nginx must still see the vhost domain in Host.
        ...(byIp ? { host: url.host } : {}),
      },
    };
    if (isHttps) options.servername = hostname; // correct SNI for the nginx vhost

    const req = (isHttps ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout} ms`)));
    req.on('error', reject);
    req.end();
  });

  if (net.isIP(hostname)) return doRequest(hostname);
  return doRequest(null).catch(async (err) => {
    if (err.code !== 'ENOTFOUND' && err.code !== 'EAI_AGAIN') throw err;
    let ip;
    try {
      ip = await resolveViaPublicDns(hostname);
    } catch (_) {
      throw new Error(
        `the domain "${hostname}" could not be resolved by the container DNS or by public DNS ` +
        `(1.1.1.1/8.8.8.8): if it is a home-only domain (AdGuard/local DNS), enter the ` +
        `IP directly in the URL field, e.g. http://192.168.10.10:7860`
      );
    }
    return doRequest(ip);
  });
}

module.exports = { easyProxyFetch };
