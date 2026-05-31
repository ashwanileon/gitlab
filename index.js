'use strict';

const express = require('express');
const axios = require('axios');
const { CONFIG, fetchDomain, getMeta, agent, HEADERS } = require('./src/config');
const { buildStreams, withTimeout, streamLabel, bestMatch } = require('./src/utils');
const {
  searchExtraFlix, searchUHDRodeo, getUHDRodeoLinks,
  searchMoviesDrives, getMoviesDrivesLinks, getDownloadLinks,
} = require('./src/providers');

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// All retained sources (ExtraFlix, MoviesDrives, UHDRodeo) resolve through
// directly-reachable hosts, so extraction is fast. Keep the deadline under
// Stremio's ~20-30s abandon window.
const TOTAL_BUDGET = 20000;

app.get('/manifest.json', (_, res) => res.json({
  id: 'community.httpstreams.stremio',
  version: '3.0.0',
  name: 'http streams',
  description: 'Multi-source streams from ExtraFlix, MoviesDrives & UHDRodeo',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { adult: false, p2p: false },
}));

app.get('/stream/:type/:id.json', async (req, res) => {
  const [imdbId, season, episode] = req.params.id.split(':');
  const { type } = req.params;
  const sn = season ? parseInt(season) : null;
  const en = episode ? parseInt(episode) : null;
  const allStreams = [];

  let responded = false;
  let meta;
  const safeRespond = (payload) => {
    if (!responded) {
      responded = true;
      clearTimeout(deadlineTimer);
      res.json(payload);
    }
  };

  const deadlineTimer = setTimeout(() => {
    console.warn(`[stream] deadline reached, sending ${allStreams.length} partial streams`);
    safeRespond({ streams: buildStreams(allStreams, meta) });
  }, TOTAL_BUDGET);

  try {
    meta = (await Promise.all([
      withTimeout(fetchDomain(), 3000),
      withTimeout(getMeta(imdbId, type), 5000),
    ]))[1];

    if (!meta) { return safeRespond({ streams: [] }); }

    const [extraResults, uhdSearchRes, mdSearchRes] = await Promise.allSettled([
      withTimeout(searchExtraFlix(meta.title), 10000, []),
      withTimeout(searchUHDRodeo(meta.title), 10000, []),
      withTimeout(searchMoviesDrives(meta.title), 8000, []),
    ]).then(r => r.map(p => p.status === 'fulfilled' ? p.value : []));

    const extractionPromises = [];

    // ── ExtraFlix
    extractionPromises.push((async () => {
      let extraList = extraResults.length ? extraResults : (meta.year ? await withTimeout(searchExtraFlix(`${meta.title} ${meta.year}`), 8000, []) : []);
      if (extraList.length) {
        const match = bestMatch(meta.title, extraList, sn, type);
        if (match) {
          try {
            const { finalLinks, isMovie } = await withTimeout(getDownloadLinks(match.url), 15000, { finalLinks:[], isMovie:true });
            let filtered = finalLinks;
            if (!isMovie && en !== null) filtered = finalLinks.filter(l => l.episode === en);
            filtered.slice(0, 20).forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const label = streamLabel('ExtraFlix', q, l);
              allStreams.push({ name: label.name, title: label.title, url: l.url });
            });
          } catch (e) { console.error('[extraResult]', e.message); }
        }
      }
    })());

    // ── UHDRodeo
    extractionPromises.push((async () => {
      let uhdResults = uhdSearchRes;
      if (!uhdResults.length && meta.year) uhdResults = await withTimeout(searchUHDRodeo(`${meta.title} ${meta.year}`), 5000, []);
      if (uhdResults.length) {
        const uhdMatch = bestMatch(meta.title, uhdResults, sn, type);
        if (uhdMatch) {
          try {
            const uhdLinks = await withTimeout(getUHDRodeoLinks(uhdMatch.url), 15000, []);
            uhdLinks.slice(0, 12).forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const label = streamLabel('UHDRodeo', q, l);
              allStreams.push({ name: label.name, title: label.title, url: l.url });
            });
          } catch (e) { console.error('[uhdResult]', e.message); }
        }
      }
    })());

    // ── MoviesDrives
    extractionPromises.push((async () => {
      let mdResults = mdSearchRes;
      if (!mdResults.length && meta.year) mdResults = await withTimeout(searchMoviesDrives(`${meta.title} ${meta.year}`), 6000, []);
      if (mdResults.length) {
        const mdMatch = bestMatch(meta.title, mdResults, sn, type);
        if (mdMatch) {
          try {
            const mdLinks = await withTimeout(getMoviesDrivesLinks(mdMatch.url), 15000, []);
            mdLinks.slice(0, 12).forEach(l => {
              const q = typeof l.quality === 'number' ? l.quality : parseInt(l.quality) || 0;
              const label = streamLabel('MoviesDrives', q, l);
              allStreams.push({ name: label.name, title: label.title, url: l.url });
            });
          } catch (e) { console.error('[mdResult]', e.message); }
        }
      }
    })());

    await Promise.allSettled(extractionPromises);
    safeRespond({ streams: buildStreams(allStreams, meta) });
  } catch (e) {
    console.error('[stream]', e.message);
    safeRespond({ streams: buildStreams(allStreams, meta) });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: Date.now() }));

app.get('/livetest', async (req, res) => {
  const out = { steps: {}, fixes: [], version: '3.0.0' };
  try {
    try {
      const domain = await fetchDomain();
      out.steps.domain_used = domain;
      out.fixes.push(`✅ Domain resolved`);
    } catch (e) { out.steps.domain_error = e.message; }

    try {
      const extraResults = await searchExtraFlix('Superman');
      out.steps.extraflix_results = extraResults.length;
      out.fixes.push(`${extraResults.length ? '✅' : '❌'} ExtraFlix search: ${extraResults.length} results`);
    } catch (e) { out.steps.extraflix_error = e.message; }

    try {
      const uhdResults = await searchUHDRodeo('Superman');
      out.steps.uhdrodeo_results = uhdResults.length;
      out.fixes.push(`${uhdResults.length ? '✅' : '❌'} UHDRodeo search: ${uhdResults.length} results`);
    } catch (e) { out.steps.uhdrodeo_error = e.message; }

    try {
      const mdResults = await searchMoviesDrives('Superman');
      out.steps.moviesdrives_results = mdResults.length;
      if (mdResults.length) {
        const mdMatch = bestMatch('Superman', mdResults, null, 'movie');
        out.steps.moviesdrives_match = mdMatch ? { title: mdMatch.title, url: mdMatch.url } : null;
        if (mdMatch) {
          const mdLinks = await withTimeout(getMoviesDrivesLinks(mdMatch.url), 20000, []);
          out.steps.moviesdrives_streams = mdLinks.length;
          out.steps.moviesdrives_stream_sample = mdLinks.slice(0, 3).map(l => ({ source: l.source, quality: l.quality, url: String(l.url || '').substring(0, 120) }));
        }
      }
      out.fixes.push(`${mdResults.length ? '✅' : '❌'} MoviesDrives search: ${mdResults.length} results${out.steps.moviesdrives_streams !== undefined ? `, streams: ${out.steps.moviesdrives_streams}` : ''}`);
    } catch (e) { out.steps.moviesdrives_error = e.message; }
  } catch (e) {
    out.error = e.message;
  }
  res.json(out);
});

app.get('/debug-search', async (req, res) => {
  const { url, source } = req.query;
  if (!url) return res.json({ error: 'Provide ?url= to fetch' });
  try {
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': source ? new URL(source).origin + '/' : url,
    };
    const { data, status, headers: respHeaders } = await axios.get(url, {
      headers: browserHeaders,
      httpsAgent: agent,
      timeout: 15000,
      responseType: 'text',
    });
    const snippet = typeof data === 'string' ? data.substring(0, 10000) : String(data).substring(0, 10000);
    res.json({
      status,
      content_type: respHeaders['content-type'],
      length: typeof data === 'string' ? data.length : 'non-string',
      snippet,
    });
  } catch (e) {
    res.json({ error: e.message, status: e.response?.status });
  }
});

app.get('/', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  res.send(`<!DOCTYPE html><html><head><meta charset=UTF-8><meta name=viewport content="width=device-width,initial-scale=1"><title>http streams</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:#111827;border:1px solid #1f2937;border-radius:20px;padding:40px;max-width:580px;width:100%;text-align:center}h1{font-size:2rem;background:linear-gradient(135deg,#f97316,#dc2626);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:6px}.sub{color:#6b7280;font-size:.85rem;margin:10px 0 20px}.btn{display:inline-block;margin:6px 4px;padding:11px 22px;border-radius:9px;font-weight:700;font-size:.88rem;text-decoration:none}.bp{background:linear-gradient(135deg,#f97316,#dc2626);color:#fff}.bs{background:#1f2937;color:#d1d5db;border:1px solid #374151}.url{margin-top:16px;background:#0f172a;border:1px solid #1e3a5f;border-radius:8px;padding:10px;font-size:.72rem;color:#64748b;word-break:break-all}.dbg{margin-top:16px;padding:14px;background:#0f172a;border-radius:10px;text-align:left}.dbg h3{color:#f97316;margin-bottom:8px;font-size:.78rem;text-transform:uppercase}.dbg a{color:#7dd3fc;font-size:.78rem;word-break:break-all;display:block;margin:5px 0;text-decoration:none}.badge{display:inline-block;background:#1e3a5f;color:#7dd3fc;border-radius:4px;font-size:.7rem;padding:2px 6px;margin:2px}</style>
</head><body><div class=card>
<h1>🎬 http streams</h1>
<p class=sub>Multi-source Stremio Addon · ExtraFlix · MoviesDrives · UHDRodeo</p>
<div><span class=badge>v3.0.0</span><span class=badge>ExtraFlix</span><span class=badge>MoviesDrives</span><span class=badge>UHDRodeo</span></div><br>
<a class="btn bp" href="stremio://${req.get('host')}/manifest.json">⚡ Install in Stremio</a>
<a class="btn bs" href="/manifest.json">Manifest</a>
<div class=url>${host}/manifest.json</div>
<div class=dbg><h3>🔬 Diagnostics</h3>
<a href="/livetest">🚨 /livetest — Source health check</a>
<a href="/stream/movie/tt5950044.json">/stream/movie/tt5950044.json (Superman)</a>
</div></div></body></html>`);
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Addon → http://localhost:${PORT}`));
}

module.exports = app;
