import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AP_DISCOVERY_ID, AP_DISCOVERY_URL, collectAPDiscovery, parseAPDiscovery } from '../../supabase/functions/_shared/google-news-discovery.js';
import { collectPublisher, publishers } from '../../supabase/functions/newsboard-crawl/collectors.js';
const xml = await readFile(new URL('../../test/fixtures/publishers/apgoogle1/discovery.xml', import.meta.url), 'utf8');
const now = Date.parse('2026-09-30T17:00:00Z');

test('AP discovery validates provenance, deduplicates and sorts latest published first', () => {
  const items = parseAPDiscovery(xml, { now });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Latest AP example & development');
  assert.equal(items[0].publishedAt, '2026-09-30T16:00:00.000Z');
  for (const item of items) {
    assert.equal(item.coverageScope, 'discovery'); assert.equal(item.via, 'Google News');
    assert.equal(item.publisher, 'Associated Press');
    assert.equal('rank' in item, false); assert.equal('slot_key' in item, false);
    assert.equal(new URL(item.url).hostname, 'news.google.com');
  }
});
test('empty, stale, HTML, unsafe and non-AP feeds fail closed', () => {
  for (const content of ['', '<html>Just a moment...</html>', '<rss><channel></channel></rss>', '<!DOCTYPE rss><rss><channel/></rss>', xml.replaceAll('https://news.google.com', 'https://evil.example'), xml.replaceAll('https://apnews.com', 'https://apnews.com.evil.example')]) {
    assert.throws(() => parseAPDiscovery(content, { now }));
  }
  assert.throws(() => parseAPDiscovery(xml, { now: now + 72 * 3600_000 }), /No fresh/);
  assert.throws(() => parseAPDiscovery(xml, { now: now - 24 * 3600_000 }), /No fresh/);
});
test('cloud collector preserves observation time and does not produce a hero/Top 10', async () => {
  let requested;
  const output = await collectAPDiscovery({ now: () => now, fetchImpl: async url => { requested = url; return new Response(xml); } });
  assert.equal(requested, AP_DISCOVERY_URL); assert.equal(output.source_id, AP_DISCOVERY_ID);
  assert.equal(output.observed_at, '2026-09-30T17:00:00.000Z');
  assert.deepEqual(output.item, output.items[0]);
  assert.equal('top10' in output, false); assert.equal(output.coverage_scope, 'discovery');
  await assert.rejects(collectAPDiscovery({ fetchImpl: async () => new Response('blocked', { status: 429 }) }), /HTTP 429/);
  await assert.rejects(collectAPDiscovery({ fetchImpl: async () => new Response(xml, { headers: { 'content-length': '3000000' } }) }), /2 MB/);
});
test('production Edge registry routes discovery directly to RSS, with no AP homepage request', async () => {
  const original = globalThis.fetch;
  try {
    let requested;
    const fresh = xml.replaceAll('Wed, 30 Sep 2026 15:00:00 GMT', new Date(Date.now()-3600_000).toUTCString()).replaceAll('Wed, 30 Sep 2026 16:00:00 GMT', new Date(Date.now()-1800_000).toUTCString());
    globalThis.fetch = async url => { requested = url; return new Response(fresh); };
    const output = await collectPublisher(publishers.find(p => p.id === AP_DISCOVERY_ID));
    assert.equal(requested, AP_DISCOVERY_URL); assert.equal(output.items.length, 2);
    assert.equal(publishers.some(p => p.id === 'ap1'), false);
  } finally { globalThis.fetch = original; }
});
