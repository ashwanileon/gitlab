'use strict';

const axios = require('axios');
const https = require('https');
const cache = require('./cache');

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const CONFIG = {
  MAIN_URL: 'https://new1.hdhub4u.limo',
  BACKUP_URL: 'https://hdhub4u.glass',
  FOURTH_K_URL: 'https://4khdhub.link',
  EXTRAFLIX_URL: 'https://e3.extraflix.mobi',
  MWSDB_URL: 'https://mwsdb.vercel.app',
  MOVIESDRIVES_URL: 'https://new2.moviesdrives.my',
  UHDMOVIES_URL: 'https://uhdmovies.rodeo',
  DOMAINS_URL: 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json',
  CINEMETA: 'https://v3-cinemeta.strem.io',
  TMDB_API: 'https://api.themoviedb.org/3',
  TMDB_KEY: process.env.TMDB_KEY || '',
  CF_WORKER_URL: process.env.CF_WORKER_URL || '',
  IS_VERCEL: !!process.env.VERCEL,
  IS_KOYEB: !!process.env.KOYEB_APP_NAME,
  IS_SERVERLESS: !!(process.env.VERCEL || process.env.KOYEB_APP_NAME),
  // Common hubcloud domain variants to try — TLDs change frequently
  HUB_CLOUD_DOMAINS: [
    'hubcloud.dad',
    'hubcloud.foo',
    'hubcloud.bar',
    'hubcloud.ink',
    'hubcloud.to',
    'hubcloud.one',
    'hubcloud.site',
    'hubcloud.cyou',
  ],
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': `${CONFIG.MAIN_URL}/`,
};

async function fetchDomain() {
  return cache.getOrSet('domain', async () => {
    try {
      const { data } = await axios.get(CONFIG.DOMAINS_URL, { httpsAgent: agent, timeout: 5000 });
      const domain =
        data['HDHub4u'] || data['HDHUB4u'] || data['hdhub4u'] ||
        data['HDHub4U'] || data['HDHUB4U'] || data['hdhub4U'] ||
        data['hdhub4u.limo'] || null;
      if (domain) {
        const d = domain.endsWith('/') ? domain.slice(0,-1) : domain;
        CONFIG.MAIN_URL = d;
        HEADERS.Referer = CONFIG.MAIN_URL + '/';
        console.log('[domain] resolved:', CONFIG.MAIN_URL);
      }
    } catch (e) {
      console.error('[domain] fetch failed:', e.message, '— using hardcoded fallback');
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
