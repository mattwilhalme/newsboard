import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateLiveDrift, LIVE_DRIFT_CONTRACTS } from '../../lib/crawlerDrift.js';
import { PUBLISHER_IDS } from '../../lib/publisherRegistry.js';

const item = { title: 'A sufficiently descriptive editorial headline', url: 'https://example.com/news/story' };
const ranked = Array.from({ length: 10 }, (_, index) => ({ ...item, rank: index + 1, url: `${item.url}-${index}` }));

test('every active publisher has a live drift contract', () => {
  assert.deepEqual(Object.keys(LIVE_DRIFT_CONTRACTS), [...PUBLISHER_IDS]);
});

test('complete ranking contracts require ten items and centerpiece agreement', () => {
  const good = evaluateLiveDrift('cbs1', { item, top10: ranked, top10_quality: 'complete', top10_diagnostics: { centerpiece_agreement: true }, http_status: 200 });
  assert.equal(good.ok, true);
  const partial = evaluateLiveDrift('cbs1', { item, top10: ranked.slice(0, 9), top10_quality: 'partial', top10_diagnostics: { centerpiece_agreement: true } });
  assert.equal(partial.ok, false);
  assert.match(partial.issues.join(' '), /expected complete Top 10/);
});

test('partial-capable contracts still reject empty, warning, and mismatched ranking', () => {
  assert.equal(evaluateLiveDrift('guardian1', { item, top10: ranked.slice(0, 8), top10_quality: 'partial', top10_diagnostics: { centerpiece_agreement: true } }).ok, true);
  for (const quality of ['failed', 'warning']) {
    assert.equal(evaluateLiveDrift('guardian1', { item, top10: [], top10_quality: quality, top10_diagnostics: { centerpiece_agreement: false } }).ok, false);
  }
});

test('collector errors, invalid centerpiece, and empty discovery fail closed', () => {
  assert.equal(evaluateLiveDrift('fox1', null, new Error('DOM changed')).ok, false);
  assert.equal(evaluateLiveDrift('fox1', { item: { title: 'short', url: 'not a URL' } }).ok, false);
  assert.equal(evaluateLiveDrift('apgoogle1', { items: [] }).ok, false);
  assert.equal(evaluateLiveDrift('apgoogle1', { items: [item], http_status: 200 }).ok, true);
});

