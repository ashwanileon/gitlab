'use strict';

/**
 * Multi-method Cloudflare bypass module.
 *
 * Strategy: try multiple bypass methods in order of speed,
 * returning the first successful result.
 *
 * Methods (in order):
 *   1. CF Worker proxy (fastest, if CF_WORKER_URL configured)
 *   2. System curl with Chrome fingerprint (medium, bypasses basic CF)
 *   3. curl-impersonate binary (slow, if available in PATH)
 *
 * IMPORTANT: Axios (direct) is NOT included as a method here because
 * Cloudflare blocks Node.js http2/https requests from datacenter IPs.
 * Use system curl or CF Worker proxy instead.
 */

const axios = require('axios');
const { execFile } = require('child_process');
const cache = require('./cache');
const { agent } = require('./config');

// ── Configuration ──────────────────────────────────────────────────

const CF_WORKER_URL = process.env.CF_WORKER_URL || '';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const CURL_TIMEOUT = 25000; // 25s for system curl
const WORKER_TIMEOUT = 15000; // 15s for CF Worker proxy
const TOTAL_BYPASS_BUDGET = 55000; // 55s max total

// Chrome 131 headers
const CHROME_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'DNT': '1',
};

// ── Method 1: CF Worker Proxy (fastest, if deployed) ──────────────────────

async function tryCFWorker(url, options = {}) {
  if (!CF_WORKER_URL) return null;

  try {
    const cacheKey = `cfworker:${url}`;
    return await cache.getOrSet(cacheKey, async () => {
      const workerUrl = `${CF_WORKER_URL}?target=${encodeURIComponent(url)}`;
      const response = await axios.get(workerUrl, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        httpsAgent: agent,
        timeout: options.timeout || WORKER_TIMEOUT,
        responseType: 'text',
        decompress: true,
        maxRedirects: 0,
      });

      const body = typeof response.data === 'string' ? response.data : String(response.data || '');

      // Check if the proxy returned a Cloudflare challenge
      if (body && body.length > 200 && !isCloudflareChallenge(body) && response.status < 400) {
        console.log(`[bypass] ✓ CF Worker succeeded for ${url.substring(0, 60)} (${response.status})`);
        return body;
      }

      if (response.headers['x-proxy-status'] === 'challenge') {
        console.log(`[bypass] CF Worker hit challenge for ${url.substring(0, 60)}`);
      }
      return null;
    }, CACHE_TTL);
  } catch (e) {
    const status = e.response?.status;
    if (status !== 403 && status !== 502) {
      console.log(`[bypass] CF Worker error: ${status || e.message.substring(0, 60)}`);
    }
    return null;
  }
}

// ── Method 2: System Curl (effective against basic Cloudflare) ──────────────

async function trySystemCurl(url, options = {}) {
  const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';

  return new Promise(resolve => {
    const timeout = options.timeout || CURL_TIMEOUT;
    const args = [
      '-s', '-L',           // silent, follow redirects
      '-m', String(Math.ceil(timeout / 1000)), // max time in seconds
      '--http1.1',           // Use HTTP/1.1 (not HTTP/2 — CF treats H2 differently)
      '--compressed',
      '-A', CHROME_HEADERS['User-Agent'],
      '-H', `Accept: ${CHROME_HEADERS['Accept']}`,
      '-H', `Accept-Language: ${CHROME_HEADERS['Accept-Language']}`,
      '-H', `Sec-Ch-Ua: ${CHROME_HEADERS['Sec-Ch-Ua']}`,
      '-H', `Sec-Ch-Ua-Mobile: ${CHROME_HEADERS['Sec-Ch-Ua-Mobile']}`,
      '-H', `Sec-Ch-Ua-Platform: ${CHROME_HEADERS['Sec-Ch-Ua-Platform']}`,
      '-H', `Upgrade-Insecure-Requests: ${CHROME_HEADERS['Upgrade-Insecure-Requests']}`,
      '-H', `DNT: ${CHROME_HEADERS['DNT']}`,
      '-H', `Referer: ${new URL(url).origin}/`,
      '-H', 'Cache-Control: no-cache',
      '-H', 'Pragma: no-cache',
      url,
    ];

    const child = execFile(curlBin, args, {
      timeout: timeout + 3000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      // curl exits with code 0 even on HTTP errors — check stdout content
      if (stdout && stdout.length > 200 && !isCloudflareChallenge(stdout) && !isBlockedPage(stdout, 0)) {
        console.log(`[bypass] ✓ curl succeeded for ${url.substring(0, 60)} (${stdout.length} bytes)`);
        resolve(stdout);
      } else if (stdout && stdout.length > 200) {
        // Content is a challenge/block page — log and return null
        resolve(null);
      } else {
        resolve(null);
      }
    });

    setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, timeout + 5000);
  });
}

// ── Method 3: curl-impersonate (if installed) ───────────────────────────

async function tryCurlImpersonate(url, options = {}) {
  const binName = process.platform === 'win32' ? 'curl_impersonate.exe' : 'curl_impersonate';

  return new Promise(resolve => {
    const timeout = options.timeout || CURL_TIMEOUT;

    // Check if binary exists
    execFile(binName, ['--version'], { timeout: 3000 }, (err) => {
      if (err) { resolve(null); return; }

      const args = [
        '-s', '-L',
        '--http1.1',
        '--compressed',
        '--connect-timeout', '15',
        '--max-time', String(Math.ceil(timeout / 1000)),
        '--ciphers', 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
        '--tls13-ciphers', 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
        '--curves', 'X25519:P-256:P-384',
        '--sig-hash', 'sha256',
        '-H', `User-Agent: ${CHROME_HEADERS['User-Agent']}`,
        '-H', `Accept: ${CHROME_HEADERS['Accept']}`,
        '-H', `Accept-Language: ${CHROME_HEADERS['Accept-Language']}`,
        '-H', `Sec-Ch-Ua: ${CHROME_HEADERS['Sec-Ch-Ua']}`,
        '-H', `Sec-Ch-Ua-Mobile: ${CHROME_HEADERS['Sec-Ch-Ua-Mobile']}`,
        '-H', `Sec-Ch-Ua-Platform: ${CHROME_HEADERS['Sec-Ch-Ua-Platform']}`,
        '-H', `Referer: ${new URL(url).origin}/`,
        url,
      ];

      const child = execFile(binName, args, {
        timeout: timeout + 3000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (stdout && stdout.length > 200 && !isCloudflareChallenge(stdout)) {
          console.log(`[bypass] ✓ curl-impersonate succeeded for ${url.substring(0, 60)}`);
          resolve(stdout);
        } else {
          resolve(null);
        }
      });

      setTimeout(() => {
        try { child.kill(); } catch (_) {}
      }, timeout + 5000);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────

function isCloudflareChallenge(body) {
  if (!body || typeof body !== 'string') return false;
  const indicators = [
    'Just a moment...', 'cf-challenge', 'cf-mitigated',
    'challenges.cloudflare.com', '__cf_chl_opt',
    '/cdn-cgi/challenge-platform', 'Checking your browser',
    'cf-browser-verification', 'Attention Required',
    'Checking your browser before accessing',
  ];
  return indicators.some(i => body.includes(i));
}

function isBlockedPage(body, status) {
  if (status === 403) return true;
  if (body && body.length < 500 && (body.includes('Access Denied') || body.includes('Blocked') || body.includes('403 Forbidden'))) return true;
  return false;
}

// ── Unified Bypass Function ─────────────────────────────────────

/**
 * Fetch a URL from a Cloudflare-protected site, trying multiple bypass methods.
 *
 * Methods tried in order (fastest → slowest):
 *   1. CF Worker proxy (if CF_WORKER_URL configured)
 *   2. System curl with Chrome fingerprint (effective against basic CF)
 *   3. curl-impersonate binary (if available in PATH)
 *
 * Returns the response body string, or null if all methods fail.
 */
async function fetchUrlWithBypass(url, options = {}) {
  const startTime = Date.now();
  const budget = options.budget || TOTAL_BYPASS_BUDGET;
  const remaining = () => budget - (Date.now() - startTime);

  console.log(`[bypass] Fetching ${url.substring(0, 60)}...`);

  // Method 1: CF Worker proxy (fast, if deployed)
  let result = await tryCFWorker(url, options);
  if (result) return result;

  if (remaining() <= 0) {
    console.log(`[bypass] Budget exhausted for ${url.substring(0, 60)}`);
    return null;
  }

  // Method 2: System curl (medium speed, effective bypass)
  result = await trySystemCurl(url, { ...options, timeout: Math.min(remaining(), CURL_TIMEOUT) });
  if (result) return result;

  if (remaining() <= 0) {
    console.log(`[bypass] Budget exhausted for ${url.substring(0, 60)}`);
    return null;
  }

  // Method 3: curl-impersonate (if installed)
  result = await tryCurlImpersonate(url, options);
  if (result) return result;

  console.warn(`[bypass] ✗ All methods failed for ${url.substring(0, 60)} (${Date.now() - startTime}ms)`);
  return null;
}

/**
 * Convenience wrapper: fetch JSON from a Cloudflare-protected API endpoint.
 */
async function fetchJsonWithBypass(url, options = {}) {
  const body = await fetchUrlWithBypass(url, {
    ...options,
    headers: { ...(options.headers || {}), Accept: 'application/json,text/plain,*/*' },
  });
  if (!body) return null;
  try { return JSON.parse(body); } catch (_) { return null; }
}

module.exports = {
  fetchUrlWithBypass,
  fetchJsonWithBypass,
  trySystemCurl,
  tryCurlImpersonate,
  tryCFWorker,
  isCloudflareChallenge,
};
