'use strict';

const cheerio = require('cheerio');
const { CONFIG } = require('../config');
const { fetchUrlWithBypass } = require('../cloudflare-bypass');
const { normalizeSearchText } = require('../utils');

async function search4KHDHub4u(query) {
  try {
    const searchUrls = [
      `${CONFIG.FOURTH_K_URL}/?s=${encodeURIComponent(query)}`,
      `${CONFIG.FOURTH_K_URL}/?q=${encodeURIComponent(query)}`,
    ];

    let body = null;
    for (const url of searchUrls) {
      body = await fetchUrlWithBypass(url, { timeout: 30000 });
      if (body) break;
    }
    if (!body) return [];

    const $ = cheerio.load(body);
    const results = [];

    $('a.movie-card').each((_, el) => {
      const e = $(el);
      const href = e.attr('href') || '';
      const title = e.find('.movie-card-title').first().text().trim() ||
                    e.find('h3').first().text().trim() ||
                    e.find('img').first().attr('alt') || '';
      if (title && title.length < 300 && href && href.length > 5) {
        results.push({
          title: title.replace(/\s+/g, ' '),
          url: href.startsWith('http') ? href : `${CONFIG.FOURTH_K_URL}${href}`,
          source: '4khdhub',
        });
      }
    });

    if (!results.length) {
      $('.card-grid a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const title = $(el).find('.movie-card-title, h3, img[alt]').first().text().trim() ||
                      $(el).find('img').first().attr('alt') || '';
        if (title && title.length < 300 && href) {
          results.push({
            title: title.replace(/\s+/g, ' '),
            url: href.startsWith('http') ? href : `${CONFIG.FOURTH_K_URL}${href}`,
            source: '4khdhub',
          });
        }
      });
    }

    if (!results.length) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        const full = href.startsWith('http') ? href : `${CONFIG.FOURTH_K_URL}${href}`;
        const queryTokens = normalizeSearchText(query).split(' ').filter(t => t.length > 2);
        const haystack = normalizeSearchText(`${text} ${href}`);
        if (
          (href.startsWith('/')) &&
          (/\/(20\d{2}|20\d{2}-)/.test(href) || /^\/[a-z0-9-]{8,}/.test(href)) &&
          queryTokens.every(t => haystack.includes(t)) &&
          !href.includes('?s=') && !href.includes('?q=') &&
          !href.includes('comment') && !href.includes('page/') &&
          full.startsWith(CONFIG.FOURTH_K_URL)
        ) {
          results.push({
            title: text || full.split('/').filter(Boolean).pop(),
            url: full,
            source: '4khdhub',
          });
        }
      });
    }

    const seen = new Set();
    return results.filter(r => {
      if (!r.url || !r.title || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 20);
  } catch (e) { return []; }
}

module.exports = { search4KHDHub4u };
