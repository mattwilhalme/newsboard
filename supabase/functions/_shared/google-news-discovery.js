import * as cheerio from 'cheerio';

export const AP_DISCOVERY_ID = 'apgoogle1';
export const AP_DISCOVERY_NAME = 'AP via Google News';
export const AP_DISCOVERY_URL = 'https://news.google.com/rss/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen';
export const AP_DISCOVERY_HOME = 'https://news.google.com/search?q=site%3Aapnews.com%20when%3A1d&hl=en-US&gl=US&ceid=US%3Aen';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const maxAge = 48 * 60 * 60 * 1000;

// Feed publication dates and our observation time are deliberately separate.
// Google search ordering is NOT an AP homepage/lead/Top 10 observation.
export function parseAPDiscovery(xml, { now = Date.now() } = {}) {
  if (!Number.isFinite(now) || typeof xml !== 'string' || xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid discovery feed');
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($('rss > channel').length !== 1) throw new Error('Expected Google News RSS');
  const seen = new Set();
  const items = [];
  $('rss > channel > item').each((_, el) => {
    const node = $(el);
    const title = clean(node.children('title').text()).replace(/\s+-\s+AP News$/i, '');
    const url = clean(node.children('link').text());
    const source = node.children('source');
    const publishedMs = Date.parse(source.length ? node.children('pubDate').text() : '');
    let link, publisher;
    try { link = new URL(url); publisher = new URL(source.attr('url')); } catch { return; }
    if (publisher.protocol !== 'https:' || publisher.hostname !== 'apnews.com' || !/^AP News$/i.test(clean(source.text()))) return;
    if (link.protocol !== 'https:' || link.hostname !== 'news.google.com' || !/^\/(rss\/)?articles\/[^/]+$/.test(link.pathname) || link.username || link.password) return;
    if (title.length < 12 || title.length > 350 || !Number.isFinite(publishedMs) || publishedMs > now + 300_000 || now - publishedMs > maxAge) return;
    // Deduplicate by redirect article ID, ignoring tracking/query variations.
    const key = link.pathname.replace(/^\/rss/, '');
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ title, url, publishedAt: new Date(publishedMs).toISOString(), publisher: 'Associated Press', via: 'Google News', coverageScope: 'discovery', contentType: 'news' });
  });
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.url.localeCompare(b.url));
  if (!items.length) throw new Error('No fresh, valid AP discoveries in Google News RSS');
  return items.slice(0, 100);
}

export async function collectAPDiscovery({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const start = now();
  const response = await fetchImpl(AP_DISCOVERY_URL, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/rss+xml,application/xml,text/xml' } });
  if (!response.ok) throw Object.assign(new Error(`Google News RSS HTTP ${response.status}`), { httpStatus: response.status });
  if (Number(response.headers?.get('content-length')) > 2_000_000) throw new Error('Discovery feed exceeds 2 MB budget');
  const xml = await response.text();
  const observedMs = now();
  const items = parseAPDiscovery(xml, { now: observedMs });
  return { source_id: AP_DISCOVERY_ID, observed_at: new Date(observedMs).toISOString(), coverage_scope: 'discovery', feed_url: AP_DISCOVERY_URL, item: items[0], items, http_status: response.status, duration_ms: Math.max(0, observedMs - start) };
}
