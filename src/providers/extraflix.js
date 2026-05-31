'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { normalizeSearchText } = require('../utils');

async function searchExtraFlix(query) {
  try {
    const searchUrls = [
      `${CONFIG.EXTRAFLIX_URL}/?s=${encodeURIComponent(query)}`,
      `${CONFIG.EXTRAFLIX_URL}/?s=${encodeURIComponent(query.replace(/\s+\d{4}$/, ''))}`,
    ];

    let body = null;

    const chromeHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': CONFIG.EXTRAFLIX_URL + '/',
      'DNT': '1',
      'Upgrade-Insecure-Requests': '1',
    };

    for (const url of searchUrls) {
      try {
        const { data } = await axios.get(url, { headers: chromeHeaders, httpsAgent: agent, timeout: 8000 });
        if (data && typeof data === 'string' && data.length > 500 && !data.includes('cloudflare') && !data.includes('Just a moment')) {
          body = data;
          break;
        }
      } catch (_) {}
    }

    if (!body) return [];

    const $ = cheerio.load(body);
    const results = [];

    $('article').each((_, el) => {
      const e = $(el);
      const linkEl = e.find('h2 a, h3 a, .entry-title a, a[href*="extraflix"], a[href]').first();
      const href = linkEl.attr('href') || '';
      const title = (
        e.find('h2, h3, .entry-title').first().text().trim() ||
        linkEl.text().trim() ||
        e.find('.title, .name').first().text().trim()
      ).replace(/\s+/g, ' ');
      if (href && title && title.length < 300 && !title.match(/^(share|comment|reply)/i)) {
        results.push({
          title,
          url: href.startsWith('http') ? href : `${CONFIG.EXTRAFLIX_URL}${href}`,
          source: 'extraflix',
        });
      }
    });

    $('h2 a[href], h3 a[href], .entry-title a, a[href*="extraflix"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (href && text && text.length < 300 && !text.match(/^(share|comment|reply|next|prev)/i)) {
        const full = href.startsWith('http') ? href : `${CONFIG.EXTRAFLIX_URL}${href}`;
        if (!results.some(r => r.url === full)) {
          results.push({ title: text, url: full, source: 'extraflix' });
        }
      }
    });

    const seen = new Set();
    return results.filter(r => {
      if (!r.url || !r.title || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    }).slice(0, 20);
  } catch (e) { return []; }
}

module.exports = { searchExtraFlix };
