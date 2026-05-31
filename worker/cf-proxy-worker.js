/**
 * Cloudflare Worker — fetch proxy for the httpstream Stremio addon.
 *
 * Requests from a Cloudflare Worker originate from Cloudflare's own edge
 * network, which Cloudflare-protected target sites generally do not block.
 * This lets a datacenter-hosted addon (e.g. Koyeb free) reach sites that
 * block its IP directly.
 *
 * Contract (matches src/cf-proxy.js and src/cloudflare-bypass.js tryCFWorker):
 *   GET/POST  {WORKER_URL}?target=<url-encoded target URL>
 *   - Any query param prefixed with `header_` is forwarded as a request
 *     header to the target. The client replaces '-' with '_' in header
 *     names (e.g. header_Referer, header_Accept_Language), so the worker
 *     converts '_' back to '-' when rebuilding header names.
 *   - For POST, the request body and Content-Type are forwarded.
 *   - The upstream status code is passed through.
 *   - Permissive CORS headers are added so any client can read the response.
 *
 * Deploy with `wrangler deploy` or paste into the Cloudflare dashboard editor.
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('target');

    if (!target) {
      return new Response('Missing ?target= parameter', {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (_) {
      return new Response('Invalid target URL', {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    // Build outbound headers: realistic browser defaults + forwarded header_* params
    const outHeaders = new Headers({
      'User-Agent': DEFAULT_UA,
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': targetUrl.origin + '/',
    });

    for (const [key, value] of url.searchParams.entries()) {
      if (!key.startsWith('header_') || !value) continue;
      // Client sends keys with '_' instead of '-'; restore the header name.
      const headerName = key.slice('header_'.length).replace(/_/g, '-');
      if (headerName) outHeaders.set(headerName, value);
    }

    const init = {
      method: request.method,
      headers: outHeaders,
      redirect: 'follow',
    };

    if (request.method === 'POST') {
      init.body = await request.text();
      if (!outHeaders.has('Content-Type')) {
        outHeaders.set(
          'Content-Type',
          request.headers.get('Content-Type') || 'application/x-www-form-urlencoded'
        );
      }
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), init);
    } catch (e) {
      return new Response('Upstream fetch failed: ' + (e && e.message), {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    const body = await upstream.text();
    const respHeaders = new Headers(CORS_HEADERS);
    const ct = upstream.headers.get('Content-Type');
    if (ct) respHeaders.set('Content-Type', ct);
    respHeaders.set('X-Proxy-Status', upstream.ok ? 'ok' : 'error');

    return new Response(body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
