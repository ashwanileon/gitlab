'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { normalizeSearchText, slugify } = require('../utils');
const { fetchUrlWithBypass } = require('../cloudflare-bypass');

async function searchHDHub4u(query) {
  try {
    const searchUrls = [
      `${CONFIG.MAIN_URL}/?s=${encodeURIComponent(query)}`,
      `${CONFIG.MAIN_URL}/?q=${encodeURIComponent(query)}`,
    ];

    let body = null;
    for (const url of searchUrls) {
      const result = await fetchUrlWithBypass(url);
      if (result) { body = result; break; }
    }
    if (!body) return [];

    const results = [];
    const $ = cheerio.load(body);

    $('article, .post, .post-item, .item, [class*="movie"], [class*="series"], a.movie-card').each((_, el) => {
      const e = $(el);
      const titleLink = e.find('h2 a, h3 a, h4 a, .entry-title a, .title a, .name a, .movie-title a, .movie-card a').first();
      const title = titleLink.text().trim() || e.find('h2, h3, h4, .movie-title, .card-title').first().text().trim();
      const href = titleLink.attr('href') || e.find('a[href]').first().attr('href') || (e.is('a') ? e.attr('href') : '');

      if (title && title.length < 300 && href && href.length > 5) {
        results.push({
          title: title.replace(/\s+/g, ' '),
          url: href.startsWith('http') ? href : `${CONFIG.MAIN_URL}${href}`
        });
      }
    });

    $('a[href*="/"]').each((_, el) => {
      const e = $(el);
      const href = e.attr('href') || '';
      const text = e.text().trim();
      const full = href.startsWith('http') ? href : `${CONFIG.MAIN_URL}${href}`;
      const queryTokens = normalizeSearchText(query).split(' ').filter(t => t.length > 2);
      const haystack = normalizeSearchText(`${text} ${href}`);

      if (
        (href.includes(CONFIG.MAIN_URL) || href.startsWith('/')) &&
        (/\/(20\d{2}|20\d{2}-)/.test(href) || /^\/[a-z0-9-]{8,}/.test(href)) &&
        queryTokens.every(t => haystack.includes(t)) &&
        !href.includes('?s=') && !href.includes('?q=') &&
        !href.includes('comment') &&
        !text.match(/^(next|prev|page|post)\s*\d/i) &&
        full.startsWith(CONFIG.MAIN_URL)
      ) {
        results.push({ title: (text || full.split('/').filter(Boolean).pop()).replace(/\s+/g, ' '), url: full });
      }
    });

    const seen = new Set();
    return results.filter(r => {
      if (!r.url || !r.title || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 20);
  } catch (e) {
    return [];
  }
}

async function findDirectPage(title, year) {
  const base = CONFIG.MAIN_URL.replace(/\/$/, '');
  const t = slugify(title);
  // Probe only the two most likely slugs. The bypass circuit breaker will
  // short-circuit further attempts when the origin is blocked, so we avoid
  // spending 20s+ spraying many slug variants on a dead origin.
  const slugs = [];
  if (year) slugs.push(`${t}-${year}/`);
  slugs.push(`${t}/`);

  for (const s of slugs) {
    const url = `${base}/${s}`;
    try {
      const body = await fetchUrlWithBypass(url, { timeout: 8000 });
      if (body && (body.includes('hubcdn') || body.includes('hubdrive') || body.includes('hubcloud') || body.includes('gadgetsweb') || body.includes('pixeldrain'))) {
        console.log(`[hdhub4u-direct] Found direct URL: ${url.substring(0, 80)}`);
        return url;
      }
    } catch (_) {}
  }
  return null;
}

module.exports = { searchHDHub4u, findDirectPage };
