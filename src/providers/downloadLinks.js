'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { HEADERS, CONFIG, agent } = require('../config');
const { languageTags, withTimeout } = require('../utils');
const { loadExtractor } = require('../extractors');

// Used by ExtraFlix. Fetches the detail page, collects external hoster links,
// and resolves the directly-reachable ones (pixeldrain, streamtape, drivehub,
// linkshub, hubdrive, mdrive, direct media). HubCloud links resolve to nothing
// (handled in loadExtractor) and are dropped.
async function getDownloadLinks(mediaUrl) {
  HEADERS.Referer = new URL(mediaUrl).origin + '/';
  let data;
  try {
    const resp = await axios.get(mediaUrl, { headers:HEADERS, httpsAgent:agent, timeout:12000 });
    data = resp.data;
  } catch (e) {
    return { finalLinks: [], isMovie: true };
  }
  if (!data) return { finalLinks: [], isMovie: true };

  try {
    const $ = cheerio.load(data);

    const typeRaw = $('h1.page-title span, h1, [class*="title"]').first().text();
    const pageLanguageLabel = languageTags(typeRaw).join(', ');
    const isMovie = !typeRaw.toLowerCase().includes('season') &&
                   !typeRaw.toLowerCase().includes('tv series') &&
                   !typeRaw.toLowerCase().includes('web series');

    let allLinks = [];

    if (mediaUrl.includes('extraflix.')) {
      const pageLangs = languageTags(typeRaw).join(', ');
      $('.download-options-section a[href], .Untouched-download-links-section a[href], .entry-content a[href*="extralink"], .entry-content a[href*="pixeldrain"], .entry-content a[href*="streamtape"], .entry-content a[href*="drivehub"], .entry-content a[href*="hubdrive"], .entry-content a[href*="linkshub"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (!href || !href.startsWith('http')) return;
        if (href.includes('extraflix.mobi') || href.includes('facebook') || href.includes('twitter') || href.includes('t.me') || href.includes('.zip')) return;

        const parentEl = $(el).parent();
        const parentText = parentEl.text().trim().replace(/\s+/g, ' ');
        const prevSiblingText = parentEl.prev().text().trim().replace(/\s+/g, ' ');
        const grandparentEl = parentEl.parent();

        let sectionHeaderText = '';
        grandparentEl.find('h2, h3, h4, h5, h6, strong, .title, .label').each(function() {
          const t = $(this).text().trim();
          if (t && t.length < 100) sectionHeaderText += ' ' + t;
        });
        sectionHeaderText = sectionHeaderText.replace(/\s+/g, ' ').trim();

        const context = prevSiblingText || sectionHeaderText || parentText || text;

        let quality = 0;
        if (/\b4K\b|\b2160\b/i.test(context)) {
          quality = 2160;
        } else {
          const qualityMatch = context.match(/(\d{3,4})\s*p/i);
          if (qualityMatch) quality = parseInt(qualityMatch[1]);
        }

        const sizeMatch = context.match(/\[?([\d.]+\s*(?:GB|MB|KB))\]?/i);
        const size = sizeMatch ? sizeMatch[1] : '';

        allLinks.push({
          url: href, quality, size, text: context || text,
          source: `ExtraFlix${context ? ' [' + context.replace(/\s*[-\u2013]\s*/g, ' ') + ']' : ''}${pageLangs ? ' [' + pageLangs + ']' : ''}${size ? ' [' + size + ']' : ''}`,
          isMovie, episode: null,
        });
      });
    }

    if (!allLinks.length) $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();

      if (
        href && href.startsWith('http') && !href.includes('.zip') &&
        (
          href.includes('hubdrive') || href.includes('drivehub') || href.includes('linkshub') ||
          href.includes('pixeldrain') || href.includes('streamtape') || href.includes('hdstream4u') ||
          /\.(mp4|mkv|m3u8)/.test(href)
        )
      ) {
        const qualityMatch = text.match(/(\d{3,4})[pP]/);
        const quality = qualityMatch ? parseInt(qualityMatch[1]) : 0;
        const sizeMatch = text.match(/\[([0-9.]+\s*(?:GB|MB|KB))\]/i);
        const size = sizeMatch ? sizeMatch[1] : '';

        allLinks.push({
          url: href, quality, size, text,
          source: pageLanguageLabel ? `${text || 'Stream'} [${pageLanguageLabel}]${size ? ' [' + size + ']' : ''}` : undefined,
          isMovie, episode: null
        });
      }
    });

    const minQuality = 1080;
    allLinks = allLinks.filter(l => {
      const q = typeof l.quality==='number' ? l.quality : parseInt(l.quality)||0;
      return q === 0 || q >= minQuality;
    });

    const resolveLink = async (link) => {
      try {
        const resolved = await withTimeout(loadExtractor(link.url, mediaUrl), 12000, []);
        if (resolved && resolved.length) {
          return resolved.map(r => ({
            ...r,
            quality: r.quality && !['Unknown', 'M3U8', 'Stream'].includes(String(r.quality)) ? r.quality : link.quality,
            size: r.size || link.size,
            labelSource: link.source,
            episode: link.episode,
          }));
        }
        if (/\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(link.url)) {
          return [link];
        }
        return [];
      } catch (_) {
        if (/\.(mp4|mkv|m3u8|webm|avi|mov)(?:$|[?#])/i.test(link.url)) {
          return [link];
        }
        return [];
      }
    };

    const finalLinks = [];
    const results = await Promise.allSettled(allLinks.map(resolveLink));
    results.forEach(r => { if (r.status === 'fulfilled') finalLinks.push(...r.value); });

    const seen = new Set();
    return {
      finalLinks: finalLinks.filter(l => {
        if (!l.url || l.url.includes('.zip') || seen.has(l.url)) return false;
        seen.add(l.url); return true;
      }).slice(0, 50),
      isMovie,
    };
  } catch (e) { return { finalLinks: [], isMovie: true }; }
}

module.exports = { getDownloadLinks };
