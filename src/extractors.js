'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, agent } = require('./config');
const { atob, btoa, rot13, cleanTitle, withTimeout } = require('./utils');

// NOTE: HubCloud / hubcdn and the HDHub4u/4KHDHub sources were removed because
// they sit behind interactive Cloudflare challenges that cannot be solved from
// a datacenter host without a headless browser. Those sources are hosted
// separately. This module only resolves hosts that are directly reachable
// (pixeldrain, direct media files, streamtape, drivehub, linkshub, hubdrive,
// mdrive, unblockedgames, extralink).

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
        href.includes('pixeldrain') ||
        href.includes('hdstream4u') ||
        href.includes('streamtape') ||
        /\.(mp4|mkv|m3u8)(?:$|[?#])/i.test(href) ||
        /download|server/i.test(text)
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
        href.includes('drivehub.') || href.includes('hubdrive.') ||
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
async function unblockedGamesExtractor(url) {
  try {
    const sid = url.match(/[?&]sid=([^&]+)/)?.[1];
    if (sid) {
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
        if (redirectResp.status >= 300 && redirectResp.status < 400) {
          const loc = redirectResp.headers?.location;
          if (loc) {
            const resolvedUrl = loc.startsWith('http') ? loc : new URL(loc, 'https://cloud.unblockedgames.world').toString();
            return [{ source: 'UnblockedGames', quality: 'Unknown', url: resolvedUrl }];
          }
        }
      } catch (redirectErr) {
        const loc = redirectErr.response?.headers?.location;
        if (loc) {
          const resolvedUrl = loc.startsWith('http') ? loc : new URL(loc, 'https://cloud.unblockedgames.world').toString();
          return [{ source: 'UnblockedGames', quality: 'Unknown', url: resolvedUrl }];
        }
      }

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
          const m = postResp.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|m3u8)(?:[?#][^\s"'<>]*)?)/i);
          if (m) return [{ source: 'UnblockedGames', quality: 'Unknown', url: m[1] }];
          const iframe = postResp.match(/<iframe[^>]+src=["']([^"']+)["']/i);
          if (iframe) return [{ source: 'UnblockedGames', quality: 'Unknown', url: iframe[1] }];
        }
      } catch (_) {}
    }
    return [];
  } catch (e) {
    return [];
  }
}

async function mdriveLolExtractor(url, referer) {
  try {
    // Try both mdrive.lol and mdrive.ink in parallel (whichever responds first
    // with valid content). These pages are directly reachable.
    const altUrl = url.replace('mdrive.lol', 'mdrive.ink');
    const domainUrls = altUrl !== url ? [url, altUrl] : [url];

    const fetchResults = await Promise.allSettled(
      domainUrls.map(du =>
        axios.get(du, { headers: { ...HEADERS, Referer: referer }, httpsAgent: agent, timeout: 10000 })
          .then(r => ({ url: du, data: r.data }))
      )
    );

    let bestData = null;
    for (const r of fetchResults) {
      if (r.status === 'fulfilled' && r.value?.data && r.value.data.length > 500) {
        bestData = r.value.data;
        break;
      }
    }
    if (!bestData) return [];

    const $ = cheerio.load(bestData);
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.startsWith('http')) return;
      let host;
      try { host = new URL(href).hostname; } catch (_) { return; }
      if (host.includes('mdrive.lol') || host.includes('mdrive.ink') || host.includes('facebook') || host.includes('twitter') || host.includes('youtube') || host.includes('t.me') || host.includes('wordpress')) return;
      if (
        host.includes('drivehub') || host.includes('linkshub') || host.includes('hubdrive') ||
        host.includes('pixeldrain') || host.includes('streamtape') || host.includes('hdstream4u') ||
        /\.(mp4|mkv|m3u8)(?:$|\?)/i.test(href)
      ) {
        candidates.push(href);
      }
    });

    // Also scan the raw page for direct playable URLs in scripts.
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

    const ordered = [...new Set(candidates)];
    const results = await Promise.allSettled(
      ordered.slice(0, 8).map(href => withTimeout(loadExtractor(href, url), 8000, []))
    );
    const out = [];
    results.forEach(r => { if (r.status === 'fulfilled' && r.value.length) out.push(...r.value); });

    const seen = new Set();
    return out.filter(s => { if (!s?.url || seen.has(s.url)) return false; seen.add(s.url); return true; });
  } catch (e) { return []; }
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
    // HubCloud / hubcdn require challenge solving from a datacenter IP and are
    // intentionally not resolved here. Dropping them keeps the addon fast.
    if (host.includes('hubcloud') || host.includes('hubcdn')) return [];
    if (host.includes('mdrive.lol') || host.includes('mdrive.ink'))  return mdriveLolExtractor(url, referer);
    if (host.includes('hubdrive'))   return hubDriveExtractor(url, referer);
    if (host.includes('drivehub'))   return driveHubExtractor(url, referer);
    if (host.includes('linkshub'))   return linkshubExtractor(url, referer);
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
