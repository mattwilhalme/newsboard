import * as cheerio from 'cheerio';

export const MAX_FEED_BYTES = 2_000_000;
export const FEED_TIMEOUT_MS = 20_000;
const TRACKING = /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|oc|output)$/i;

export function normalizeArticleUrl(raw) {
  const url = new URL(String(raw || '').trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Unsupported article URL');
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  return url.toString();
}

const clean = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const date = value => { const ms = Date.parse(clean(value)); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const text = ($, node, selectors) => { for (const selector of selectors) { const value = $(node).find(selector).first().text(); if (clean(value)) return clean(value); } return null; };

export function parseFeed(xml, { feedId = 'unknown', publisherId = 'unknown' } = {}) {
  if (typeof xml !== 'string' || !xml.trim() || xml.length > MAX_FEED_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid or unsafe feed XML');
  let $;
  try { $ = cheerio.load(xml, { xmlMode: true }); } catch { throw new Error('Invalid feed XML'); }
  const atom = $('feed').first().length === 1;
  const nodes = atom ? $('feed > entry').toArray() : $('rss > channel > item, rdf\\:RDF > item').toArray();
  if (!nodes.length) throw new Error('Feed contains no entries');
  const seen = new Set(), items = [];
  for (const node of nodes) {
    try {
      const title = text($, node, ['title']);
      const rawUrl = atom
        ? ($(node).find('link[rel="alternate"]').first().attr('href') || $(node).find('link').first().attr('href'))
        : (text($, node, ['link']) || text($, node, ['guid']));
      const canonicalUrl = normalizeArticleUrl(rawUrl);
      if (!title || title.length < 5 || title.length > 500 || seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      items.push({
        publisher_id: publisherId, feed_id: feedId, canonical_url: canonicalUrl,
        original_url: String(rawUrl).trim(), headline: title,
        description: text($, node, atom ? ['summary', 'content'] : ['description', 'content\\:encoded']),
        published_at: date(text($, node, atom ? ['published', 'updated'] : ['pubDate', 'dc\\:date'])),
        modified_at: atom ? date(text($, node, ['updated'])) : null,
        external_id: text($, node, atom ? ['id'] : ['guid']),
      });
    } catch { /* malformed entries are isolated */ }
  }
  if (!items.length) throw new Error('Feed contains no usable entries');
  return { type: atom ? 'atom' : 'rss', items };
}

export async function fetchFeed(feed, state = {}, { fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/atom+xml,application/rss+xml,application/xml,text/xml' };
  if (state.etag) headers['if-none-match'] = state.etag;
  if (state.last_modified) headers['if-modified-since'] = state.last_modified;
  const response = await fetchImpl(feed.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (response.status === 304) return { status: 304, notModified: true, etag: state.etag || null, lastModified: state.last_modified || null, items: [] };
  if (!response.ok) { const error = new Error(`Feed HTTP ${response.status}`); error.httpStatus = response.status; throw error; }
  if (Number(response.headers.get('content-length')) > MAX_FEED_BYTES) throw new Error('Feed exceeds 2 MB budget');
  const xml = await response.text();
  if (xml.length > MAX_FEED_BYTES) throw new Error('Feed exceeds 2 MB budget');
  return { status: response.status, ...parseFeed(xml, { feedId: feed.id, publisherId: feed.publisherId }), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
}
