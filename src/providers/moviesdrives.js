'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { normalizeSearchText, slugify, withTimeout } = require('../utils');
const { loadExtractor } = require('../extractors');

async function searchMoviesDrives(query) {
  try {
    const { data } = await axios.get(`${CONFIG.MOVIESDRIVES_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=10`, {
      headers: { ...HEADERS, Accept: 'application/json', Referer: CONFIG.MOVIESDRIVES_URL + '/' },
      httpsAgent: agent,
      timeout: 8000,
    });
    if (Array.isArray(data) && data.length) {
      const results = data.map(p => ({
        title: (p.title?.rendered || p.slug || '').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim(),
        url: p.link || '',
      })).filter(r => r.title && r.url);
      if (results.length) return results.slice(0, 20);
    }
  } catch (_) {}

  try {
    const { data: wpData } = await axios.get(`${CONFIG.MOVIESDRIVES_URL}/wp-json/wp/v2/posts?per_page=50`, {
      headers: { ...HEADERS, Accept: 'application/json', Referer: CONFIG.MOVIESDRIVES_URL + '/' },
      httpsAgent: agent,
      timeout: 8000,
    });
    if (Array.isArray(wpData) && wpData.length) {
      const queryTokens = normalizeSearchText(query).split(' ').filter(t => t.length > 2);
      const matches = wpData
        .map(p => ({
          title: (p.title?.rendered || p.slug || '').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim(),
          url: p.link || '',
        }))
        .filter(r => {
          if (!r.title || !r.url) return false;
          const haystack = normalizeSearchText(r.title + ' ' + r.url);
          return queryTokens.every(t => haystack.includes(t));
        });
      if (matches.length) return matches.slice(0, 20);
    }
  } catch (_) {}

  try {
    const slug = slugify(query);
    const year = (query.match(/\b(\d{4})\b/) || [])[1] || '';
    const variants = [
      `${slug}/`,
      year ? `${slug}-${year}/` : null,
      `${slug}-hindi/`,
      `${slug}-full-movie/`,
      `${slug}-web-dl/`,
    ].filter(Boolean);

    for (const v of variants) {
      try {
        const url = `${CONFIG.MOVIESDRIVES_URL}/${v}`;
        const r = await axios.get(url, { headers: { ...HEADERS, Referer: CONFIG.MOVIESDRIVES_URL + '/' }, httpsAgent: agent, timeout: 6000 });
        if (r.status === 200) {
          const $$ = cheerio.load(r.data);
          const h1 = $$('h1').text().trim().replace(/\s+/g, ' ').substring(0, 200) || query;
          return [{ title: h1, url }];
        }
      } catch (_) {}
    }
  } catch (_) {}

  return [];
}

async function getMoviesDrivesLinks(mediaUrl) {
  try {
    const { data } = await axios.get(mediaUrl, { headers: { ...HEADERS, Referer: CONFIG.MOVIESDRIVES_URL + '/' }, httpsAgent: agent, timeout: 15000 });
    const $ = cheerio.load(data);
    const linkPairs = [];
    const h5s = $('h5').toArray();

    for (let i = 0; i < h5s.length - 1; i++) {
      const heading = $(h5s[i]).text().trim().replace(/\s+/g, ' ');
      if (!heading || heading.length < 10) continue;
      const linkEl = $(h5s[i + 1]).find('a[href^="http"]').first();
      const href = (linkEl.length ? linkEl.attr('href') : '') || $(h5s[i + 1]).find('a[href]').first().attr('href') || '';
      if (href && href.startsWith('http') && !href.includes('moviesdrives.my') && !href.includes('facebook') && !href.includes('twitter') && !href.includes('pinterest') && !href.includes('imdb')) {
        const linkText = $(h5s[i + 1]).text().trim().replace(/\s+/g, ' ');
        const context = heading + ' ' + linkText;
        let quality = 0;
        const qm = context.match(/(\d{3,4})\s*p/i);
        if (qm) quality = parseInt(qm[1]);
        const sizeMatch = context.match(/\[?([\d.]+\s*(?:GB|MB|KB))\]?/i);
        linkPairs.push({ url: href, quality, size: sizeMatch ? sizeMatch[1] : '', heading });
      }
    }

    if (!linkPairs.length) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('http') && !href.includes('moviesdrives.my') && !href.includes('facebook') && !href.includes('twitter') && !href.includes('pinterest') && !href.includes('imdb')) {
          if (href.includes('hubcloud') || href.includes('hubdrive') || href.includes('pixeldrain') || href.includes('streamtape') || href.includes('hdstream4u') || href.includes('drivehub') || href.includes('linkshub')) {
            const parentText = $(el).closest('h5, p, div').text().trim().replace(/\s+/g, ' ');
            let quality = 0;
            const qm = parentText.match(/(\d{3,4})\s*p/i);
            if (qm) quality = parseInt(qm[1]);
            const sizeMatch = parentText.match(/\[?([\d.]+\s*(?:GB|MB|KB))\]?/i);
            linkPairs.push({ url: href, quality, size: sizeMatch ? sizeMatch[1] : '', heading: parentText });
          }
        }
      });
    }

    // Layout fallback: MoviesDrives changes markup often. Do not depend only on
    // h5/h5 pairs; collect every plausible external hoster URL from anchors and
    // inline scripts, then infer quality/size from nearby text.
    const addPair = (href, context = '') => {
      if (!href || !href.startsWith('http')) return;
      if (href.includes('moviesdrives.my') || href.includes('facebook') || href.includes('twitter') || href.includes('pinterest') || href.includes('imdb') || href.includes('.zip')) return;
      if (!/(hubcloud|hubloud|gdflix|mdrive\.lol|archive\/\d+|hubdrive|hubcdn|pixeldrain|streamtape|hdstream4u|drivehub|linkshub|workers\.dev|googleusercontent|googlevideo|\.mp4|\.mkv|\.m3u8|\.webm)/i.test(href)) return;
      let quality = 0;
      if (/\b4K\b|\b2160\b|2160p/i.test(context)) quality = 2160;
      else {
        const qm = context.match(/(\d{3,4})\s*p/i);
        if (qm) quality = parseInt(qm[1]);
      }
      const sizeMatch = context.match(/\[?([\d.]+\s*(?:GB|MB|KB))\]?/i);
      linkPairs.push({ url: href, quality, size: sizeMatch ? sizeMatch[1] : '', heading: context.substring(0, 240) });
    };

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const context = $(el).closest('h5, p, div, li, section, article').text().trim().replace(/\s+/g, ' ');
      addPair(href, context || $(el).text().trim().replace(/\s+/g, ' '));
    });

    const inlineUrls = (String(data).match(/https?:\\?\/\\?\/[^\s"'<>)]+/g) || [])
      .map(u => u.replace(/\\\//g, '/').replace(/[),.;]+$/g, ''));
    inlineUrls.forEach(href => {
      const idx = String(data).indexOf(href);
      const context = idx >= 0 ? String(data).slice(Math.max(0, idx - 500), idx + 500).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '';
      addPair(href, context);
    });

    const seen = new Set();
    const uniquePairs = linkPairs.filter(p => { if (seen.has(p.url)) return false; seen.add(p.url); return true; });

    const priority = (url) => {
      if (/pixeldrain|\.mp4|\.mkv|\.m3u8|\.webm|workers\.dev|googleusercontent|googlevideo/i.test(url)) return 0;
      if (/streamtape|drivehub|hubdrive|linkshub|mdrive\.lol|gdflix|hubloud/i.test(url)) return 1;
      if (/hubcloud|hubcdn/i.test(url)) return 9;
      return 4;
    };
    uniquePairs.sort((a, b) => priority(a.url) - priority(b.url));

    const resolveOne = async (pair) => {
      try {
        const isSlowHubcloud = /(hubcloud|hubloud|hubcdn|mdrive\.lol|gdflix)/i.test(pair.url);
        const resolved = await withTimeout(loadExtractor(pair.url, mediaUrl), isSlowHubcloud ? 7000 : 8000, []);
        if (resolved && resolved.length) {
          return resolved.map(link => ({
            ...link,
            quality: link.quality && !['Unknown', 'M3U8', 'Stream'].includes(String(link.quality)) ? link.quality : pair.quality,
            size: link.size || pair.size,
            labelSource: pair.heading,
          }));
        }
        if (/\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(pair.url)) {
          return [{ source: 'MoviesDrives', quality: pair.quality || 0, url: pair.url, size: pair.size, labelSource: pair.heading }];
        }
        return [];
      } catch (_) { return []; }
    };

    const allStreamLinks = [];
    const fastPairs = uniquePairs.filter(p => priority(p.url) < 9).slice(0, 10);
    const fastResults = await Promise.allSettled(fastPairs.map(resolveOne));
    fastResults.forEach(r => { if (r.status === 'fulfilled') allStreamLinks.push(...r.value); });

    if (!allStreamLinks.length) {
      const hubResults = await Promise.allSettled(uniquePairs.filter(p => priority(p.url) >= 9).slice(0, 2).map(resolveOne));
      hubResults.forEach(r => { if (r.status === 'fulfilled') allStreamLinks.push(...r.value); });
    }

    console.log(`[moviesdrives] ${uniquePairs.length} candidate links, ${allStreamLinks.length} resolved streams from ${mediaUrl.substring(0, 80)}`);
    const seenUrls = new Set();
    return allStreamLinks.filter(l => { if (!l.url || seenUrls.has(l.url)) return false; seenUrls.add(l.url); return true; });
  } catch (e) { return []; }
}

module.exports = { searchMoviesDrives, getMoviesDrivesLinks };
