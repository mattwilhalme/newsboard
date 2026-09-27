import assert from 'node:assert/strict';
import test from 'node:test';

const calls = [];
const payload = { cacheLike: { sources: { abc1: { updatedAt: '2026-09-27T12:00:00Z', health: { crawlStatus: 'failed', collectionMethod: 'browser', latestError: 'blocked' } } } }, run: { status: 'partial' } };
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url).includes('supabase.json')) return new Response(JSON.stringify({ url: 'https://mock.supabase.test', anonKey: 'anon' }), { status: 200 });
  return new Response(JSON.stringify(payload), { status: 200 });
};
await import('../docs/js/data/supabase.js');

test('frontend data boundary caches RPCs and preserves operational metadata', async () => {
  const first = await globalThis.NewsboardData.getCurrentObservations();
  const second = await globalThis.NewsboardData.getCurrentObservations();
  assert.equal(first, second);
  assert.equal(calls.filter(({ url }) => url.includes('/newsboard_snapshot')).length, 1);
  assert.equal(first.cacheLike.sources.abc1.health.collectionMethod, 'browser');
  assert.equal(first.cacheLike.sources.abc1.health.latestError, 'blocked');
  assert.equal(first.run.status, 'partial');
  globalThis.NewsboardData.invalidateCurrentObservations();
  await globalThis.NewsboardData.getCurrentObservations();
  assert.equal(calls.filter(({ url }) => url.includes('/newsboard_snapshot')).length, 2);
});
