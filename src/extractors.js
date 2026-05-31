'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, agent } = require('./config');
const { atob, btoa, rot13, cleanTitle, withTimeout } = require('./utils');

async function getRedirectLinks(url) {
  try {
    const { data: doc } = await axios.get(url, { headers: HEADERS, httpsAgent: agent, timeout: 10000 });
    if (doc.trim() === 'Invalid Link !!') return null;
    const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
    let combined = '', m;
    while ((m = regex.exec(doc)) !== null) combined += (m[1] || m[2]);
    if (!combined) return null;
    const json = JSON.parse(atob(rot13(atob(atob(combined)))));
    const encodedUrl = atob(json.o || '').trim();
    if (encodedUrl) return encodedUrl;
    const data2 = btoa(json.data || '').trim();
    const wp    = (json.blog_url || '').trim();
    if (wp && data2) {
      const { data: resp } = await axios.get(`${wp}?re=${data2}`, { headers: HEADERS, httpsAgent: agent, timeout: 8000 });
      const $ = cheerio.load(resp);
      return $('body').text().trim();
    }
    return null;
  } catch (_) { return null; }
}

async function pixelDrainExtractor(link) {
  try {
    const m = link.match(/(?:file|u)\/([A-Za-z0-9]+)/);
    const id = m ? m[1] : link.split('/').pop();
    let quality = 'Unknown', name = '', size = 0;
    try {
      const { data } = await axios.get(`https://pixeldrain.com/api/file/${id}/info`, { httpsAgent: agent, timeout: 6000 });
      if (data.name) { name = data.name; size = data.size||0; const qm = data.name.match(/(\d{3,4})p/); if (qm) quality = qm[0]; }
    } catch (_) {}
    return [{ source:'Pixeldrain', quality, url:`https://pixeldrain.com/api/file/${id}?download`, name, size }];
  } catch (_) { return [{ source:'Pixeldrain', quality:'Unknown', url:link }]; }
}

async function hubCdnExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const m = data.match(/[?&]r=([A-Za-z0-9+/=]+)/) || data.match(/var\s+reurl\s*=\s*["'][^"']*[?&]r=([A-Za-z0-9+/=]+)["']/);
    if (m) {
      const d = atob(m[1]);
      const link = d.includes('link=') ? d.substring(d.lastIndexOf('link=')+5) : d;
      return [{ source:'HubCdn', quality:'M3U8', url: decodeURIComponent(link) }];
    }
    return [];
  } catch (_) { return []; }
}

async function hubDriveExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const $ = cheerio.load(data);
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (!href) return;
      if (
        href.includes('hubcloud') ||
        href.includes('hubcdn') ||
        href.includes('pixeldrain') ||
        href.includes('hdstream4u') ||
        href.includes('streamtape') ||
        /download|server|hubcloud/i.test(text)
      ) {
        candidates.push(href.startsWith('http') ? href : new URL(href, url).toString());
      }
    });
    for (const href of candidates) {
      const links = await loadExtractor(href, url);
      if (links.length) return links;
    }
    return [];
  } catch (_) { return []; }
}

async function hbLinksExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const $ = cheerio.load(data);
    const links = $('h3 a, div.entry-content p a').map((_,el) => $(el).attr('href')).get();
    const results = [];
    for (const l of links) { const ex = await loadExtractor(l, url); results.push(...ex); }
    return results;
  } catch (_) { return []; }
}

async function streamTapeExtractor(link) {
  try {
    const u = new URL(link); u.hostname = 'streamtape.com';
    const { data } = await axios.get(u.toString(), { headers:HEADERS, httpsAgent:agent, timeout:8000 });
    const m = data.match(/'(\/\/streamtape\.com\/get_video[^']+)'/);
    if (m) return [{ source:'StreamTape', quality:'Stream', url:'https:'+m[1] }];
    return [];
  } catch (_) { return []; }
}

async function driveHubExtractor(url, referer) {
  try {
    const id = new URL(url).pathname.match(/\/file\/([^/]+)/)?.[1];
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const $ = cheerio.load(data);
    const title = $('title').text().replace(/^Drivehub\s*\|\s*/i, '').trim();
    const playHref = $('a[href*="play.php?id="]').first().attr('href') || (id ? `/play.php?id=${id}` : '');
    if (!playHref) return [];
    const playUrl = new URL(playHref, url).toString();
    const { data: playData } = await axios.get(playUrl, { headers:{...HEADERS,Referer:url}, httpsAgent:agent, timeout:8000 });
    const $$ = cheerio.load(playData);
    const src = $$('source[src], video[src]').first().attr('src');
    if (!src) return [];
    const qm = title.match(/(\d{3,4})p/i);
    const sm = title.match(/-\s*([\d.]+\s*(?:GB|MB|KB))\s*$/i);
    return [{
      source: `DriveHub${title ? ` [${cleanTitle(title)}]` : ''}${sm ? ` [${sm[1]}]` : ''}`,
      quality: qm ? parseInt(qm[1]) : 'Unknown',
      url: src,
      size: sm ? sm[1] : 0,
    }];
  } catch (e) { return []; }
}

async function linkshubExtractor(url, referer) {
  try {
    const { data } = await axios.get(url, { headers:{...HEADERS,Referer:referer}, httpsAgent:agent, timeout:8000 });
    const $ = cheerio.load(data);
    const title = $('title').text().trim();
    const qm = title.match(/(\d{3,4})p/i);
    const sm = title.match(/-\s*([\d.]+\s*(?:GB|MB|KB))\s*$/i);
    const targets = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (
        href.includes('drivehub.') || href.includes('hubdrive.') || href.includes('hubcloud.') ||
        href.includes('pixeldrain') || href.includes('streamtape') || /\.(mp4|mkv|m3u8)(?:$|\?)/i.test(href)
      ) {
        targets.push(href);
      }
    });
    const out = [];
    for (const target of [...new Set(targets)].slice(0, 3)) {
      const links = await loadExtractor(target, url);
      links.forEach(link => {
        out.push({
          ...link,
          quality: link.quality && !['Unknown', 'Stream'].includes(String(link.quality)) ? link.quality : (qm ? parseInt(qm[1]) : link.quality),
          size: link.size || (sm ? sm[1] : 0),
          labelSource: `${title}${sm ? ` [${sm[1]}]` : ''}`,
        });
      });
    }
    return out;
  } catch (e) { return []; }
}

// Cache of working hubcloud domains (avoid retrying all TLDs on every request)
let workingHubCloudDomain = null;

// Nav headers for hubcloud requests
// Note: 'br' (Brotli) is excluded from Accept-Encoding because it triggers Cloudflare challenge on hubcloud.foo
function hubCloudNavHeaders(ref) {
  return { ...HEADERS, 'Accept-Encoding': 'gzip, deflate', Referer: ref, 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
}

// Detect if an HTML string is a Cloudflare or anti-bot challenge page
function isChallengePage(body) {
  if (!body || typeof body !== 'string') return false;
  const indicators = [
    'Just a moment', 'cf-challenge', '__cf_chl_opt',
    '/cdn-cgi/challenge-platform', 'cf-browser-verification',
    'Checking your browser', 'Attention Required',
    'Click for continue', 'Antibot solution',
  ];
  return indicators.some(i => body.includes(i));
}

// A real hubcloud drive page contains a card-body with download buttons and is
// several KB. Some live-but-broken TLDs (e.g. hubcloud.ink) return a ~1KB stub
// with no buttons. Treat those as failures so the resolver keeps trying.
function isUsableHubCloudPage(html) {
  if (!html || typeof html !== 'string') return false;
  if (html.length < 1500) return false;
  if (isChallengePage(html)) return false;
  // Must look like an actual drive page (download card / buttons / known hosts).
  return /card-body|card-header|Download File|FSL Server|S3 Server|10Gbps|pixeldra|hubcloud\.php/i.test(html);
}

// Fast hubcloud fetch: try direct axios first, then CF Worker proxy fallback
async function fetchHubCloudPageFast(pageUrl, ref) {
  const navHeaders = hubCloudNavHeaders(ref);

  // Try direct axios (fast — works from residential/VPS IPs)
  try {
    const resp = await axios.get(pageUrl, { headers: navHeaders, httpsAgent: agent, timeout: 8000 });
    if (resp.data && isUsableHubCloudPage(resp.data)) {
      return { html: resp.data, headers: navHeaders };
    }
  } catch (_) {}

  // Fallback: try CF Worker proxy (bypasses Cloudflare from CF's own network)
  try {
    const { fetchViaCfProxy } = require('./cf-proxy');
    const proxyHtml = await fetchViaCfProxy(pageUrl, { headers: navHeaders });
    if (proxyHtml && isUsableHubCloudPage(proxyHtml)) {
      return { html: proxyHtml, headers: navHeaders };
    }
  } catch (_) {}

  // Last resort: try system curl with Chrome fingerprint (bypasses basic CF)
  try {
    const { trySystemCurl } = require('./cloudflare-bypass');
    const curlHtml = await trySystemCurl(pageUrl, { timeout: 15000 });
    if (curlHtml && isUsableHubCloudPage(curlHtml)) {
      return { html: curlHtml, headers: navHeaders };
    }
  } catch (_) {}

  return null;
}

// Resolve a hubcloud URL by trying all domain TLD variants
// Phase 1: Try ALL TLDs in parallel with FAST methods only (direct + CF proxy)
// Phase 2: If all fail, try ONE TLD with FlareSolverr (serial, single attempt)
async function resolveHubCloudUrl(url, referer) {
  let hostname, path;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    path = parsed.pathname + parsed.search + parsed.hash;
  } catch (_) {
    return { html: null };
  }

  // If we already found a working hubcloud domain, try it first
  if (workingHubCloudDomain && hostname.includes('hubcloud')) {
    const cachedUrl = `https://${workingHubCloudDomain}${path}`;
    const result = await fetchHubCloudPageFast(cachedUrl, referer);
    if (result) return { html: result.html, finalUrl: cachedUrl };
    // If cached domain fails, reset and try all TLDs
    workingHubCloudDomain = null;
  }

  // Build a list of URLs to try: the original + all domain variants
  const candidates = [url];

  if (hostname.includes('hubcloud')) {
    const baseParts = hostname.split('.');
    const hubIdx = baseParts.findIndex(p => p === 'hubcloud');
    if (hubIdx !== -1 && hubIdx < baseParts.length - 1) {
      const { CONFIG } = require('./config');
      // Only the first two variants (the live domain is promoted to the front
      // from domains.json). Trying all 8 dead TLDs per link just wastes time.
      for (const domain of CONFIG.HUB_CLOUD_DOMAINS.slice(0, 2)) {
        const candidate = `https://${domain}${path}`;
        if (candidate !== url) candidates.push(candidate);
      }
    }
  }

  // Phase 1: Try ALL candidates in parallel with FAST methods only (direct + CF proxy)
  // These fail fast (2-3s) for Cloudflare-blocked sites — no FS flooding
  const fastResults = await Promise.allSettled(
    candidates.map(candidate =>
      fetchHubCloudPageFast(candidate, referer).then(pageData =>
        pageData ? { html: pageData.html, finalUrl: candidate } : null
      )
    )
  );

  for (const r of fastResults) {
    if (r.status === 'fulfilled' && r.value) {
      // Cache the working domain for future requests
      try { workingHubCloudDomain = new URL(r.value.finalUrl).hostname; } catch (_) {}
      return r.value;
    }
  }

  return { html: null };
}

async function hubCloudExtractor(url, referer) {
  try {
    // Resolve hubcloud URL with domain fallbacks
    const { html, finalUrl } = await resolveHubCloudUrl(url, referer);
    if (!html) {
      console.warn(`[hubcloud] All hubcloud domain variants failed for: ${url.substring(0, 80)}`);
      return [];
    }

    let curHtml = html;
    let curFinalUrl = finalUrl;
    let curReferer = referer;

    // Handle redirect pages (hubcloud.php pattern)
    // Only follow the redirect if the target URL is still on a hubcloud domain
    // Skip external redirect URLs (like gamerxyt.com) that appear as var url='...'
    if (!finalUrl.includes('hubcloud.php')) {
      const m = curHtml.match(/var url = '([^']*)'/);
      if (m && m[1]) {
        try {
          const matchedHost = new URL(m[1]).hostname;
          if (matchedHost.includes('hubcloud')) {
            curFinalUrl = m[1];
            const nextPage = await fetchHubCloudPageFast(curFinalUrl, finalUrl);
            if (nextPage) {
              curHtml = nextPage.html;
              curReferer = finalUrl;
            }
          }
        } catch (_) {}
      }
    }

    const $ = cheerio.load(curHtml);
    const size   = $('i#size').text().trim();
    const header = $('div.card-header').text().trim();
    const qm     = (header||'').match(/(\d{3,4})[pP]/);
    const quality= qm ? parseInt(qm[1]) : 2160;
    const details= cleanTitle(header);
    const label  = `${details?`[${details}]`:''}${size?`[${size}]`:''}`;
    const bytes  = (() => {
      const m = size.match(/([\d.]+)\s*(GB|MB|KB)/i);
      if (!m) return 0;
      return parseFloat(m[1]) * (m[2].toUpperCase()==='GB'?1073741824:m[2].toUpperCase()==='MB'?1048576:1024);
    })();
    const links = [];
    for (const el of $('div.card-body h2 a.btn').get()) {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (!href) continue;
      if (text.includes('Download File')) links.push({ source:`HubCloud ${label}`, quality, url:href, size:bytes });
      else if (text.includes('FSL Server')) links.push({ source:`HubCloud FSL ${label}`, quality, url:href, size:bytes });
      else if (text.includes('S3 Server')) links.push({ source:`HubCloud S3 ${label}`, quality, url:href, size:bytes });
      else if (text.includes('BuzzServer')) {
        try {
          const br = await axios.get(`${href}/download`, { headers:{...HEADERS,Referer:href}, maxRedirects:0, validateStatus:s=>s<400, httpsAgent:agent, timeout:8000 });
          const dl = br.headers['hx-redirect'];
          if (dl) links.push({ source:`HubCloud BuzzServer ${label}`, quality, url:new URL(href).origin+dl, size:bytes });
        } catch (e) {
          const dl = e.response?.headers?.['hx-redirect'];
          if (dl) links.push({ source:`HubCloud BuzzServer ${label}`, quality, url:new URL(href).origin+dl, size:bytes });
        }
      } else if (href.includes('pixeldra')) {
        links.push({ source:`Pixeldrain ${label}`, quality, url:href, size:bytes });
      } else if (text.includes('10Gbps')) {
        let c = href, fl = null;
        for (let i=0; i<5; i++) {
          try {
            const r = await axios.get(c, { maxRedirects:0, validateStatus:null, httpsAgent:agent, timeout:6000 });
            const loc = r.headers.location;
            if (!loc) break;
            if (loc.includes('link=')) { fl = loc.substring(loc.indexOf('link=')+5); break; }
            c = new URL(loc,c).toString();
          } catch (e) {
            const loc = e.response?.headers?.location;
            if (!loc) break;
            if (loc.includes('link=')) { fl = loc.substring(loc.indexOf('link=')+5); break; }
            c = new URL(loc,c).toString();
          }
        }
        if (fl) links.push({ source:`HubCloud 10Gbps ${label}`, quality, url:fl, size:bytes });
      } else {
        // For unknown button patterns (e.g. 'Generate Direct Download Link' → gamerxyt.com),
        // try to follow the redirect chain to find a playable video URL
        // The gamerxyt pages are JavaScript redirectors; we extract all candidate
        // video/download URLs from the HTML response (workers.dev, pixeldrain, etc.)
        const buttonReferer = finalUrl;
        try {
          const btnResp = await axios.get(href, {
            headers: { ...HEADERS, Referer: buttonReferer },
            httpsAgent: agent,
            timeout: 15000,
            maxRedirects: 5,
          });
          const btnFinalUrl = btnResp.request?.res?.responseUrl || href;
          let found = false;

          // 1. If final URL is a direct video (mp4/mkv/m3u8) — use it directly
          if (/\.(mp4|mkv|m3u8|webm)(?:$|[?#])/i.test(btnFinalUrl)) {
            links.push({ source: `HubCloud ${label}`, quality, url: btnFinalUrl, size: bytes });
            found = true;
          }

          // 2. Parse response body for all playable URLs
          if (!found && typeof btnResp.data === 'string' && btnResp.data.length < 100000) {
            const allUrls = btnResp.data.match(/https?:\/\/[^\s"'<>)]+/g) || [];
            // Deduplicate and filter for playable domains/extensions
            const candidates = [...new Set(allUrls)].filter(url => {
              try {
                const host = new URL(url).hostname;
                // Skip known non-video domains
                if (
                  host.includes('fontawesome') || host.includes('cdnjs') || host.includes('googleapis') ||
                  host.includes('unpkg') || host.includes('jquery') || host.includes('cloudflareinsights') ||
                  host.includes('adsboosters') || host.includes('bonuscaf') || host.includes('tinyurl') ||
                  host.includes('hubcloud') || host.includes('gamerxyt') || host.includes('hubcloud.cx') ||
                  host.includes('google.com') || url.endsWith('.css') || url.endsWith('.js') ||
                  url.endsWith('.svg') || url.endsWith('.woff2') || url.endsWith('.png') ||
                  url.endsWith('.jpg') || url.endsWith('.gif') || url.endsWith('.ico')
                ) return false;
                // Must be a playable URL type: workers.dev, pixeldrain, googleusercontent, or direct video
                return (
                  host.includes('workers.dev') ||
                  host.includes('pixeldrain') ||
                  (host.includes('googleusercontent') && url.length > 60) ||
                  /\.(mp4|mkv|m3u8|webm)(?:$|[?#])/i.test(url) ||
                  host.includes('googlevideo')
                );
              } catch (_) { return false; }
            });

            if (candidates.length > 0) {
              // Try Pixeldrain URLs first (most reliable), then workers.dev, then others
              const priority = c => c.includes('pixeldrain') ? 0 : c.includes('workers.dev') ? 1 : 2;
              candidates.sort((a, b) => priority(a) - priority(b));

              for (const candidate of candidates.slice(0, 4)) {
                try {
                  const ex = await loadExtractor(candidate, buttonReferer);
                  if (ex && ex.length > 0) {
                    // Preserve the quality/label from the hubcloud page
                    ex.forEach(s => {
                      if (!s.source || s.source === s.host || s.source === (new URL(s.url).hostname)) {
                        s.source = `HubCloud ${label}`;
                      }
                    });
                    links.push(...ex);
                    found = true;
                    break;
                  }
                } catch (_) {}
              }
            }
          }

          // 3. Fallback: try loadExtractor on original button href
          if (!found) {
            const ex = await loadExtractor(href, buttonReferer);
            links.push(...ex);
          }
        } catch (_) {
          const ex = await loadExtractor(href, buttonReferer);
          links.push(...ex);
        }
      }
    }
    return links;
  } catch (e) { return []; }
}

async function extralinkInkExtractor(url, referer) {
  try {
    const pageUrl = url.endsWith('/') ? url : url + '/';
    const { data } = await axios.get(pageUrl, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent, timeout: 15000 });
    const extractLink = (key) => {
      const pattern = new RegExp(`\\"${key}\\"\s*:\s*\\"([^\\"]+)\\"`);
      const m = data.match(pattern);
      if (m && m[1] && !m[1].includes('null') && m[1].length > 5) return m[1].replace(/\\\//g, '/');
      return null;
    };
    const linkValue = extractLink('pixeldrainLink');
    if (linkValue) return await pixelDrainExtractor(linkValue);
    const filepressValue = extractLink('filepressLink');
    if (filepressValue) return [{ source: 'FilePress', quality: 'Unknown', url: filepressValue }];
    const vikingValue = extractLink('vikingLink');
    if (vikingValue) return [{ source: 'VikingFile', quality: 'Unknown', url: vikingValue }];
    const streamhgValue = extractLink('streamhgLink');
    if (streamhgValue) return [{ source: 'StreamHG', quality: 'Unknown', url: streamhgValue }];
    const vidhideValue = extractLink('vidhideLink');
    if (vidhideValue) return [{ source: 'VidHide', quality: 'Unknown', url: vidhideValue }];
    return [{ source: 'ExtraLink', quality: 'Unknown', url: pageUrl }];
  } catch (_) { return []; }
}

// Extract playable URLs from cloud.unblockedgames.world proxy links
// The page serves an auto-submitting form that POSTs the sid to get the real video URL
async function unblockedGamesExtractor(url) {
  try {
    const sid = url.match(/[?&]sid=([^&]+)/)?.[1];
    if (sid) {
      // POST the sid, but DON'T follow redirects — catch the redirect URL
      try {
        const redirectResp = await axios.post('https://cloud.unblockedgames.world/',
          `sid=${sid}`,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': HEADERS['User-Agent'],
              'Referer': 'https://cloud.unblockedgames.world/',
            },
            httpsAgent: agent,
            timeout: 15000,
            maxRedirects: 0,
          }
        );
        // With maxRedirects:0, a redirect returns status 3xx without following
        // Check both the response status and headers for redirect location
        if (redirectResp.status >= 300 && redirectResp.status < 400) {
          const loc = redirectResp.headers?.location;
          if (loc) {
            const resolvedUrl = loc.startsWith('http') ? loc : new URL(loc, 'https://cloud.unblockedgames.world').toString();
            return [{ source: 'UnblockedGames', quality: 'Unknown', url: resolvedUrl }];
          }
        }
      } catch (redirectErr) {
        // Fallback: catch any errors and check for Location header
        const loc = redirectErr.response?.headers?.location;
        if (loc) {
          const resolvedUrl = loc.startsWith('http') ? loc : new URL(loc, 'https://cloud.unblockedgames.world').toString();
          return [{ source: 'UnblockedGames', quality: 'Unknown', url: resolvedUrl }];
        }
      }

      // If no redirect, try with redirect following to check response body
      try {
        const { data: postResp } = await axios.post('https://cloud.unblockedgames.world/',
          `sid=${sid}`,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': HEADERS['User-Agent'],
              'Referer': 'https://cloud.unblockedgames.world/',
            },
            httpsAgent: agent,
            timeout: 15000,
            maxRedirects: 5,
            responseType: 'text',
          }
        );
        if (typeof postResp === 'string') {
          // Only match URLs with actual video file extensions
          const m = postResp.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|m3u8)(?:[?#][^\s"'<>]*)?)/i);
          if (m) return [{ source: 'UnblockedGames', quality: 'Unknown', url: m[1] }];
        }
        const m = (typeof postResp === 'string') ? postResp.match(/<iframe[^>]+src=["']([^"']+)["']/i) : null;
        if (m) return [{ source: 'UnblockedGames', quality: 'Unknown', url: m[1] }];
      } catch (_) {}

      // Last resort: try via CF Proxy (bypasses Cloudflare on the proxy domain itself)
      try {
        const { fetchViaCfProxy } = require('./cf-proxy');
        const proxyResult = await fetchViaCfProxy('https://cloud.unblockedgames.world/', {
          method: 'POST',
          body: `sid=${sid}`,
          contentType: 'application/x-www-form-urlencoded',
        });
        if (proxyResult && typeof proxyResult === 'string') {
          // Only match URLs with actual video file extensions
          const m = proxyResult.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|m3u8)(?:[?#][^\s"'<>]*)?)/i);
          if (m) return [{ source: 'UnblockedGames', quality: 'Unknown', url: m[1] }];
          const iframeMatch = proxyResult.match(/<iframe[^>]+src=["']([^"']+)["']/i);
          if (iframeMatch) return [{ source: 'UnblockedGames', quality: 'Unknown', url: iframeMatch[1] }];
        }
      } catch (_) {}
    }
    // Could not resolve a real video URL — do NOT leak the page URL to Stremio.
    return [];
  } catch (e) {
    return [];
  }
}

async function hubSearchRecoverExtractor(url, referer) {
  try {
    const parsedUrl = new URL(url);
    const origin = parsedUrl.origin;
    const path = parsedUrl.pathname;
    
    // Fetch the search-recover page to get FROM_AC_TOKEN from JavaScript
    const { data: pageHtml } = await axios.get(url, {
      headers: { ...HEADERS, Referer: referer, 'Accept-Encoding': 'gzip, deflate' },
      httpsAgent: agent,
      timeout: 12000,
    });
    
    // Extract FROM_AC_TOKEN from the JavaScript embedded in the page
    const tokenMatch = pageHtml.match(/FROM_AC_TOKEN\s*=\s*['"]([^'"]+)['"]/);
    const fromAcToken = tokenMatch ? tokenMatch[1] : parsedUrl.searchParams.get('from_ac');
    if (!fromAcToken) return [];
    
    // Decode the search query from base64 (q parameter)
    const qB64 = parsedUrl.searchParams.get('q');
    if (!qB64) return [];
    const searchQuery = Buffer.from(qB64, 'base64').toString();
    
    // Call the JSON API endpoint
    const apiUrl = `${origin}${path}?api=search&q=${encodeURIComponent(searchQuery)}&page=1&from_ac=${fromAcToken}`;
    const apiResp = await axios.get(apiUrl, {
      headers: { ...HEADERS, Accept: 'application/json', Referer: url, 'Accept-Encoding': 'gzip, deflate' },
      httpsAgent: agent,
      timeout: 15000,
    });
    
    const apiData = apiResp.data;
    if (apiData && apiData.hits && Array.isArray(apiData.hits) && apiData.hits.length > 0) {
      const results = [];
      for (const hit of apiData.hits) {
        if (hit.url) {
          const driveUrl = hit.url.startsWith('http') ? hit.url : `${origin}${hit.url.startsWith('/') ? '' : '/'}${hit.url}`;
          try {
            const links = await hubCloudExtractor(driveUrl, url);
            results.push(...links);
          } catch (_) {}
        }
      }
      if (results.length > 0) return results;
    }
    
    return [];
  } catch (e) {
    return [];
  }
}

async function mdriveLolExtractor(url, referer) {
  try {
    // Try both mdrive.lol and mdrive.ink in parallel (whichever responds fastest with valid content)
    // Sequential fallback fails when .lol returns a parked/redirect page instead of throwing an error
    const altUrl = url.replace('mdrive.lol', 'mdrive.ink');
    const domainUrls = altUrl !== url ? [url, altUrl] : [url];

    const fetchResults = await Promise.allSettled(
      domainUrls.map(du =>
        axios.get(du, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent, timeout: 10000 })
          .then(r => ({ url: du, data: r.data }))
      )
    );

    // Pick the first response that has valid content (length > 500 and contains hubcloud links)
    let bestData = null;
    for (const r of fetchResults) {
      if (r.status !== 'fulfilled' || !r.value?.data || r.value.data.length < 500) continue;
      const $$ = cheerio.load(r.value.data);
      let hasHubcloud = false;
      const $$2 = cheerio.load(r.value.data);
      $$2('a[href]').each((_, el) => {
        const href = $$2(el).attr('href') || '';
        if (
          href.includes('hubcloud') || href.includes('hubdrive') || href.includes('drivehub') ||
          href.includes('linkshub') || href.includes('hubcdn') || href.includes('pixeldrain') ||
          href.includes('streamtape') || href.includes('hdstream4u') ||
          /\.(mp4|mkv|m3u8)(?:$|\?)/i.test(href)
        ) {
          hasHubcloud = true;
        }
      });
      if (hasHubcloud) {
        bestData = r.value.data;
        console.log(`[mdrive] Using ${r.value.url} (${r.value.data.length} chars, has playable links)`);
        break;
      }
    }

    // If no domain had hubcloud links, use the first successful response
    if (!bestData) {
      for (const r of fetchResults) {
        if (r.status === 'fulfilled' && r.value?.data && r.value.data.length > 500) {
          bestData = r.value.data;
          console.log(`[mdrive] Using ${r.value.url} (${r.value.data.length} chars, no hubcloud links found)`);
          break;
        }
      }
    }

    if (!bestData) {
      console.warn(`[mdrive] All domains failed for: ${url.substring(0, 80)}`);
      return [];
    }

    const $ = cheerio.load(bestData);
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.startsWith('http')) return;
      const host = new URL(href).hostname;
      if (host.includes('mdrive.lol') || host.includes('mdrive.ink') || host.includes('facebook') || host.includes('twitter') || host.includes('youtube') || host.includes('t.me') || host.includes('wordpress')) return;
      if (
        host.includes('hubcloud') || host.includes('hubdrive') || host.includes('drivehub') ||
        host.includes('linkshub') || host.includes('hubcdn') || host.includes('pixeldrain') ||
        host.includes('streamtape') || host.includes('hdstream4u') ||
        /\.(mp4|mkv|m3u8)(?:$|\?)/i.test(href)
      ) {
        candidates.push(href);
      }
    });
    if (!candidates.length) {
      console.log(`[mdrive] No candidates found on page for: ${url.substring(0, 80)}`);
      return [];
    }

    // Also scan the raw page for direct playable URLs. Some mdrive archive
    // pages expose pixeldrain / worker / video URLs in scripts instead of <a>
    // tags, while the visible anchors point to HubCloud pages that are blocked
    // from Koyeb. Returning these first lets Stremio get streams before the
    // global deadline expires.
    const inlineUrls = (bestData.match(/https?:\/\/[^\s"'<>)]+/g) || [])
      .map(u => u.replace(/\\\//g, '/').replace(/[),.;]+$/g, ''))
      .filter(href => {
        try {
          const host = new URL(href).hostname.toLowerCase();
          return (
            host.includes('pixeldrain') ||
            host.includes('workers.dev') ||
            host.includes('googleusercontent') ||
            host.includes('googlevideo') ||
            host.includes('streamtape') ||
            /\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(href)
          );
        } catch (_) { return false; }
      });
    candidates.push(...inlineUrls);

    // Resolve reachable hosts first: pixeldrain and direct video files work from
    // datacenter IPs, whereas hubcloud often does not. HubCloud is kept as a
    // last resort with a short timeout so it cannot consume the whole Stremio
    // request window.
    const priority = (h) => {
      if (h.includes('pixeldrain') || /\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(h)) return 0;
      if (h.includes('workers.dev') || h.includes('googleusercontent') || h.includes('googlevideo')) return 1;
      if (h.includes('streamtape') || h.includes('drivehub') || h.includes('hubdrive')) return 2;
      if (h.includes('hubcloud') || h.includes('hubcdn')) return 9;
      return 4;
    };
    const ordered = [...new Set(candidates)].sort((a, b) => priority(a) - priority(b));

    const out = [];
    const directFirst = ordered.filter(href => priority(href) < 9).slice(0, 6);
    const hubcloudFallback = ordered.filter(href => priority(href) >= 9).slice(0, 2);

    const directResults = await Promise.allSettled(
      directFirst.map(href => withTimeout(loadExtractor(href, url), 7000, []))
    );
    directResults.forEach(r => { if (r.status === 'fulfilled' && r.value.length) out.push(...r.value); });

    if (!out.length && hubcloudFallback.length) {
      const hubResults = await Promise.allSettled(
        hubcloudFallback.map(href => withTimeout(loadExtractor(href, url), 5000, []))
      );
      hubResults.forEach(r => { if (r.status === 'fulfilled' && r.value.length) out.push(...r.value); });
    }

    const seen = new Set();
    const unique = out.filter(s => {
      if (!s?.url || seen.has(s.url)) return false;
      seen.add(s.url);
      return true;
    });
    console.log(`[mdrive] ${unique.length} streams from ${url.substring(0, 60)}`);
    return unique;
  } catch (e) { console.error(`[mdrive] Error: ${e.message}`); return []; }
}

function isDirectPlayableUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;
  if (url.includes('.zip') || url.includes('search-recover.php')) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      /\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(url) ||
      (host.includes('pixeldrain') && /\/api\/file\//.test(url)) ||
      host.includes('workers.dev') ||
      host.includes('googleusercontent') ||
      host.includes('googlevideo') ||
      (host.includes('streamtape') && /get_video/.test(url))
    );
  } catch (_) { return false; }
}

async function loadExtractor(url, referer) {
  if (!url) return [];
  try {
    const host = new URL(url).hostname;
    if (url.includes('?id=') || host.includes('techyboy4u') || host.includes('gadgetsweb')) {
      const r = await getRedirectLinks(url);
      if (!r) return [];
      return loadExtractor(r, url);
    }
    if (url.includes('search-recover.php')) return hubSearchRecoverExtractor(url, referer);
    if (host.includes('hubcloud'))        return hubCloudExtractor(url, referer);
    if (host.includes('mdrive.lol') || host.includes('mdrive.ink'))  return mdriveLolExtractor(url, referer);
    if (host.includes('hubdrive'))   return hubDriveExtractor(url, referer);
    if (host.includes('drivehub'))   return driveHubExtractor(url, referer);
    if (host.includes('linkshub'))   return linkshubExtractor(url, referer);
    if (host.includes('hubcdn'))     return hubCdnExtractor(url, referer);
    if (host.includes('hblinks'))    return hbLinksExtractor(url, referer);
    if (host.includes('pixeldrain')) return pixelDrainExtractor(url);
    if (host.includes('streamtape')) return streamTapeExtractor(url);
    if (host.includes('unblockedgames') || host.includes('cloud.unblockedgames')) return unblockedGamesExtractor(url);
    if (host.includes('hdstream4u')) return [];
    if (host.includes('gdflix'))     return [];
    if (host.includes('linkrit'))    return [];
    if (host.includes('extralink'))  return extralinkInkExtractor(url, referer);
    if (isDirectPlayableUrl(url)) return [{ source: host.replace(/^www\./,''), quality:'Unknown', url }];
    return [];
  } catch (_) { return []; }
}

module.exports = { loadExtractor, getRedirectLinks };
