'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');

async function searchMWSDb(query) {
  try {
    const apiUrl = `${CONFIG.MWSDB_URL}/api/movies/search?query=${encodeURIComponent(query)}&page=1`;
    const { data, status } = await axios.get(apiUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'application/json',
        'Referer': CONFIG.MWSDB_URL + '/',
      },
      httpsAgent: agent,
      timeout: 8000,
    });

    if (status === 200 && data && data.results && data.results.length) {
      const results = data.results
        .map(item => ({
          title: item.title || item.name || item.original_title || item.original_name || '',
          url: '',
          source: 'mwsdb',
          tmdb_id: item.id,
          media_type: item.media_type || 'movie',
          year: (item.release_date || item.first_air_date || '').substring(0, 4),
        }))
        .filter(r => r.title && r.title.length > 0 && r.title.length < 300);

      if (results.length) return results.slice(0, 20);
    }
  } catch (_) {}

  try {
    const urls = [
      `${CONFIG.MWSDB_URL}/search?q=${encodeURIComponent(query)}`,
      `${CONFIG.MWSDB_URL}/?s=${encodeURIComponent(query)}`,
    ];
    for (const url of urls) {
      try {
        const { data, status } = await axios.get(url, {
          headers: {
            'User-Agent': HEADERS['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml,*/*',
            'Referer': CONFIG.MWSDB_URL + '/',
          },
          httpsAgent: agent,
          timeout: 6000,
        });
        if (status !== 200 || !data) continue;
        const $ = cheerio.load(data);
        const results = [];
        $('a[href]').each((_, el) => {
          const e    = $(el);
          const href = e.attr('href') || '';
          const txt  = e.text().trim()
                    || e.find('h2,h3,h4,p,.title,.name').first().text().trim()
                    || e.find('img').attr('alt') || '';
          if (
            href &&
            txt.length > 3 &&
            (href.includes('/movie/') || href.includes('/show/') ||
             href.includes('/series/') || href.includes('/title/') ||
             href.includes('/film/'))
          ) {
            const full = href.startsWith('http') ? href : `${CONFIG.MWSDB_URL}${href}`;
            results.push({ title: txt, url: full, source: 'mwsdb' });
          }
        });
        if (results.length) {
          const seen = new Set();
          return results.filter(r => { if(seen.has(r.url))return false; seen.add(r.url); return true; });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return [];
}

async function getMWSDbStreams(mediaUrl, episode) {
  return [];
}

module.exports = { searchMWSDb, getMWSDbStreams };
