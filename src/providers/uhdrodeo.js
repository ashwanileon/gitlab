'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { loadExtractor } = require('../extractors');
const { withTimeout } = require('../utils');
const { fetchUrlWithBypass } = require('../cloudflare-bypass');

const EXCLUDED_DOMAINS = [
  'facebook', 'twitter', 'instagram', 'pinterest', 'linkedin',
  'wordpress', 'yoast', 'tumblr', 'reddit', 'youtube.com',
  'google.', 'blogger', 'tiktok', 'snapchat',
];

const CONTENT_SELECTORS = [
  '.entry-content', '.post-content', '#content', 'main',
  'article', '.post', '.the-content', '.single-content',
];

async function searchUHDRodeo(query) {
  try {
    const searchUrls = [
      `${CONFIG.UHDMOVIES_URL}/?s=${encodeURIComponent(query)}`,
      `${CONFIG.UHDMOVIES_URL}/?s=${encodeURIComponent(query.replace(/\s+\d{4}$/, ''))}`,
    ];

    let body = null;
    for (const searchUrl of searchUrls) {
      try {
        const { data } = await axios.get(searchUrl, {
          headers: { ...HEADERS, Referer: CONFIG.UHDMOVIES_URL + '/' },
          httpsAgent: agent,
          timeout: 5000,
        });
        if (data && typeof data === 'string' && data.length > 500 && !data.includes('Just a moment')) {
          body = data;
          break;
        }
      } catch (_) {}
    }

    if (!body) {
      for (const searchUrl of searchUrls) {
        const result = await fetchUrlWithBypass(searchUrl, { timeout: 25000 });
        if (result) {
          body = result;
          break;
        }
      }
    }

    if (!body) return [];

    const $ = cheerio.load(body);
    const results = [];

    $('article, .post, .type-post, .search-result').each((_, el) => {
      const e = $(el);
      const titleLink = e.find('h2 a, h3 a, .entry-title a, a.entry-image, a[href*="/download-"], a[href*="/movie-"]').first();
      const href = titleLink.attr('href') || e.find('a[href]').first().attr('href') || '';
      const title = titleLink.text().trim() || e.find('h2, h3, .entry-title').first().text().trim() || '';
      if (title && title.length < 300 && href && !href.includes('?s=') && href !== CONFIG.UHDMOVIES_URL) {
        results.push({
          title: title.replace(/\s+/g, ' ').substring(0, 200),
          url: href.startsWith('http') ? href : `${CONFIG.UHDMOVIES_URL}${href}`,
        });
      }
    });

    if (!results.length) {
      $('a[href*="/download-"], a[href*="/movie-"], a[href*="/superman"], a[href*="/movie"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim().replace(/\s+/g, ' ').substring(0, 150);
        if (href && text && !href.includes('?s=')) {
          results.push({
            title: text || href.split('/').filter(Boolean).pop() || query,
            url: href.startsWith('http') ? href : `${CONFIG.UHDMOVIES_URL}${href}`,
          });
        }
      });
    }

    if (results.length) {
      const seen = new Set();
      return results.filter(r => {
        if (!r.url || seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      }).slice(0, 15);
    }
  } catch (_) {}
  return [];
}

async function getUHDRodeoLinks(mediaUrl) {
  try {
    let pageHtml = null;
    try {
      const resp = await axios.get(mediaUrl, {
        headers: { ...HEADERS, Referer: CONFIG.UHDMOVIES_URL + '/' },
        httpsAgent: agent,
        timeout: 8000,
      });
      if (resp.data && typeof resp.data === 'string' && resp.data.length > 500) {
        pageHtml = resp.data;
      }
    } catch (_) {}

    if (!pageHtml) {
      const bypassResult = await fetchUrlWithBypass(mediaUrl, { timeout: 25000 });
      if (bypassResult) {
        pageHtml = bypassResult;
      }
    }

    if (!pageHtml) return [];

    const $ = cheerio.load(pageHtml);
    const links = [];

    let contentArea = null;
    for (const sel of CONTENT_SELECTORS) {
      const el = $(sel);
      if (el.length > 0) {
        contentArea = el;
        break;
      }
    }

    let pendingQuality = 0;

    if (contentArea) {
      contentArea.find('*').each((_, el) => {
        const tag = el.name;
        const txt = $(el).text().trim().replace(/\s+/g, ' ');

        if (['h2','h3','h4','h5','strong'].includes(tag)) {
          if (/\b4K\b|\b2160\b|2160p/i.test(txt)) pendingQuality = 2160;
          else if (/1080p/i.test(txt)) pendingQuality = 1080;
          else if (/720p/i.test(txt)) pendingQuality = 720;
          else if (/480p/i.test(txt)) pendingQuality = 480;
        }

        if (tag === 'a') {
          const href = $(el).attr('href') || '';
          if (isValidExternalLink(href, txt)) {
            let quality = pendingQuality;
            if (!quality) {
              if (/\b4K\b|\b2160\b|2160p/i.test(txt)) quality = 2160;
              else if (/1080p/i.test(txt)) quality = 1080;
              else if (/720p/i.test(txt)) quality = 720;
              else if (/480p/i.test(txt)) quality = 480;
            }

            const sizeMatch = txt.match(/([\d.]+)\s*(GB|MB|KB)/i);
            const contextLabel = (quality ? `${quality}p ` : '') + txt;

            links.push({ url: href, quality, size: sizeMatch ? sizeMatch[0] : '', heading: contextLabel });
          }
        }
      });
    }

    if (!links.length) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const txt = $(el).text().trim().replace(/\s+/g, ' ');

        if (isValidExternalLink(href, txt) && looksLikeDownload(href, txt)) {
          let quality = 0;
          if (/\b4K\b|\b2160\b|2160p/i.test(txt)) quality = 2160;
          else if (/1080p/i.test(txt)) quality = 1080;
          else if (/720p/i.test(txt)) quality = 720;
          else if (/480p/i.test(txt)) quality = 480;

          const sizeMatch = txt.match(/([\d.]+)\s*(GB|MB|KB)/i);
          links.push({ url: href, quality, size: sizeMatch ? sizeMatch[0] : '', heading: txt });
        }
      });
    }

    const seen = new Set();
    const uniqueLinks = links.filter(l => {
      if (!l.url || seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });

    const resolveResults = await Promise.allSettled(uniqueLinks.map(async (link) => {
      try {
        const resolved = await withTimeout(loadExtractor(link.url, mediaUrl), 15000, []);
        if (resolved && resolved.length) {
          return resolved.map(r => ({
            source: r.source || 'UHDRodeo',
            quality: r.quality && !['Unknown', 'M3U8', 'Stream'].includes(String(r.quality)) ? r.quality : (link.quality || 0),
            url: r.url,
            size: r.size || link.size || 0,
            labelSource: link.heading,
          }));
        }
      } catch (_) {}
      if (/\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(link.url)) {
        return [{
          source: 'UHDRodeo',
          quality: link.quality || 0,
          url: link.url,
          size: link.size || 0,
          labelSource: link.heading,
        }];
      }
      return [];
    }));

    const allResolved = [];
    resolveResults.forEach(r => { if (r.status === 'fulfilled') allResolved.push(...r.value); });

    return allResolved.filter(r => !isExcludedHost(r.url));
  } catch (e) { return []; }
}

function isValidExternalLink(href, text) {
  if (!href.startsWith('http')) return false;
  if (href.includes('uhdmovies.') || href.includes('uhdmovies.rodeo')) return false;
  if (isExcludedHost(href)) return false;
  if (!text || text.length < 3) return false;
  return true;
}

function isExcludedHost(href) {
  for (const domain of EXCLUDED_DOMAINS) {
    if (href.includes(domain)) return true;
  }
  return false;
}

function looksLikeDownload(href, text) {
  const hosterPatterns = [
    'cloud.', 'hubcloud', 'hubdrive', 'drivehub', 'linkshub',
    'hubcdn', 'pixeldrain', 'streamtape', 'hdstream4u', 'gdflix',
    'extralink', 'filepress', 'vikingfile', 'streamhg', 'vidhide',
    'mdrive.lol', 'modlist.', 'moviesmod',
  ];

  for (const pattern of hosterPatterns) {
    if (href.includes(pattern)) return true;
  }

  if (/\.(mp4|mkv|m3u8|webm|avi|mov)(\?|$)/i.test(href)) return true;
  if (/\/(download|file|redirect|stream|d\/|dl\/)/i.test(href)) return true;
  if (/\b(2160|2160p|4K|1080p|720p|download|server|watch|play)\b/i.test(text)) return true;
  if (/[\d.]+\s*(GB|MB|KB)/i.test(text)) return true;

  return false;
}

module.exports = { searchUHDRodeo, getUHDRodeoLinks };
