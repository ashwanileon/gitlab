'use strict';

const axios = require('axios');
const https = require('https');
const cache = require('./cache');

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const CONFIG = {
  MAIN_URL: 'https://new1.hdhub4u.limo',
  EXTRAFLIX_URL: 'https://e3.extraflix.mobi',
  MOVIESDRIVES_URL: 'https://new2.moviesdrives.my',
  UHDMOVIES_URL: 'https://uhdmovies.rodeo',
  DOMAINS_URL: 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json',
  CINEMETA: 'https://v3-cinemeta.strem.io',
  TMDB_API: 'https://api.themoviedb.org/3',
  TMDB_KEY: process.env.TMDB_KEY || '',
  IS_VERCEL: !!process.env.VERCEL,
  IS_KOYEB: !!process.env.KOYEB_APP_NAME,
  IS_SERVERLESS: !!(process.env.VERCEL || process.env.KOYEB_APP_NAME),
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${CONFIG.MAIN_URL}/`,
};

// Strip a trailing slash from a resolved domain value.
function trimSlash(u) {
  return typeof u === 'string' && u.endsWith('/') ? u.slice(0, -1) : u;
}

// Pick the first matching key from the domains.json payload (keys vary in case).
function pickDomain(data, keys) {
  for (const k of keys) {
    if (data[k] && typeof data[k] === 'string' && data[k].startsWith('http')) {
      return trimSlash(data[k]);
    }
  }
  return null;
}

async function fetchDomain() {
  return cache.getOrSet('domain', async () => {
    try {
      const { data } = await axios.get(CONFIG.DOMAINS_URL, { httpsAgent: agent, timeout: 5000 });

      const main = pickDomain(data, [
        'HDHub4u', 'HDHUB4u', 'hdhub4u', 'HDHub4U', 'HDHUB4U', 'hdhub4U', 'hdhub4u.limo',
      ]);
      if (main) {
        CONFIG.MAIN_URL = main;
        HEADERS.Referer = CONFIG.MAIN_URL + '/';
      }

      const md = pickDomain(data, ['moviesdrive', 'moviesdrives', 'MoviesDrive']);
      if (md) CONFIG.MOVIESDRIVES_URL = md;

      const uhd = pickDomain(data, ['UHDMovies', 'uhdmovies', 'UHDMOVIES']);
      if (uhd) CONFIG.UHDMOVIES_URL = uhd;

      console.log('[domain] resolved | md:', CONFIG.MOVIESDRIVES_URL, '| uhd:', CONFIG.UHDMOVIES_URL);
    } catch (e) {
      console.error('[domain] fetch failed:', e.message, '— using hardcoded fallbacks');
    }
    return CONFIG.MAIN_URL;
  }, 900000); // 15 minutes
}

async function getMeta(imdbId, type) {
  return cache.getOrSet(`meta_${imdbId}_${type}`, async () => {
    try {
      const { data } = await axios.get(`${CONFIG.CINEMETA}/meta/${type}/${imdbId}.json`, { timeout: 6000 });
      const m = data && data.meta;
      if (m) return { title: m.name || m.title, year: String(m.year || '').slice(0,4) };
    } catch (_) {}
    if (CONFIG.TMDB_KEY) {
      try {
        const { data } = await axios.get(`${CONFIG.TMDB_API}/find/${imdbId}`, {
          params: { api_key: CONFIG.TMDB_KEY, external_source: 'imdb_id' }, timeout: 6000,
        });
        const r = (type === 'series' ? data.tv_results : data.movie_results) || [];
        if (r[0]) return { title: r[0].title || r[0].name, year: (r[0].release_date || r[0].first_air_date || '').slice(0,4) };
      } catch (_) {}
    }
    return null;
  });
}

module.exports = {
  CONFIG,
  HEADERS,
  agent,
  fetchDomain,
  getMeta
};
