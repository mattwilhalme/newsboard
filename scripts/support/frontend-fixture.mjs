import fs from 'node:fs';

export const frontendAssets = new Map([
  ['/newsboard/', ['text/html', fs.readFileSync('docs/index.html', 'utf8')]],
  ['/newsboard/js/format.js', ['text/javascript', fs.readFileSync('docs/js/format.js', 'utf8')]],
  ['/newsboard/js/health.js', ['text/javascript', fs.readFileSync('docs/js/health.js', 'utf8')]],
  ['/newsboard/js/data/supabase.js', ['text/javascript', fs.readFileSync('docs/js/data/supabase.js', 'utf8')]],
  ['/newsboard/js/ui/drawers.js', ['text/javascript', fs.readFileSync('docs/js/ui/drawers.js', 'utf8')]],
  ['/newsboard/js/ui/intelligence-drawers.js', ['text/javascript', fs.readFileSync('docs/js/ui/intelligence-drawers.js', 'utf8')]],
  ['/newsboard/js/views/story-radar.js', ['text/javascript', fs.readFileSync('docs/js/views/story-radar.js', 'utf8')]],
  ['/newsboard/js/views/overview-cards.js', ['text/javascript', fs.readFileSync('docs/js/views/overview-cards.js', 'utf8')]],
  ['/newsboard/js/views/history-data.js', ['text/javascript', fs.readFileSync('docs/js/views/history-data.js', 'utf8')]],
  ['/newsboard/js/views/cluster-engine.js', ['text/javascript', fs.readFileSync('docs/js/views/cluster-engine.js', 'utf8')]],
  ['/newsboard/js/views/cluster-assignment.js', ['text/javascript', fs.readFileSync('docs/js/views/cluster-assignment.js', 'utf8')]],
  ['/newsboard/js/views/labs.js', ['text/javascript', fs.readFileSync('docs/js/views/labs.js', 'utf8')]],
]);

export function createFrontendFixture(now = new Date().toISOString()) {
  const earlier = new Date(Date.parse(now) - 60_000).toISOString();
  const storyId = '00000000-0000-0000-0000-000000000099';
  const snapshot = {
    cacheLike: { generatedAt: now, sources: {
      abc1: { ok: true, sourceName: 'ABC News', updatedAt: now, firstSeenAt: earlier, item: { title: 'ABC deterministic headline', url: 'https://abcnews.com/US/example/story?id=1' }, health: { crawlStatus: 'success', method: 'http' } },
      cbs1: { ok: true, sourceName: 'CBS News', updatedAt: earlier, firstSeenAt: earlier, item: { title: 'CBS retained last-good headline', url: 'https://www.cbsnews.com/news/example' }, health: { crawlStatus: 'failed', latestError: 'upstream blocked', method: 'browser' } },
    } },
    history: { generatedAt: now, sources: {
      abc1: { entries: [{ title: 'ABC previous story', url: 'https://abcnews.com/US/previous/story?id=2', firstSeenAt: new Date(Date.parse(now) - 120_000).toISOString(), lastSeenAt: new Date(Date.parse(now) - 120_000).toISOString() }, { title: 'ABC original headline', url: 'https://abcnews.com/US/example/story?id=1', firstSeenAt: earlier, lastSeenAt: earlier }, { title: 'ABC deterministic headline', url: 'https://abcnews.com/US/example/story?id=1', firstSeenAt: now, lastSeenAt: now }] },
      cbs1: { entries: [{ title: 'CBS retained last-good headline', url: 'https://www.cbsnews.com/news/example', firstSeenAt: earlier, lastSeenAt: earlier }] },
    } },
  };
  const top10 = { latest: { ok: true, observedAt: now, items: [{ rank: 1, title: 'ABC ranked story', url: 'https://abcnews.com/US/ranked/story?id=3' }] }, runs: [{ ok: true, observedAt: now, items: [{ rank: 1, title: 'ABC ranked story', url: 'https://abcnews.com/US/ranked/story?id=3' }] }] };
  const storyHistory = { story: { id: storyId, canonical_label: 'ABC deterministic headline', first_detected_at: earlier, first_source_id: 'abc1' }, publisher_count: 2, current_number_ones: 1, metrics: { publishers_detected: 2, time_to_peak_seconds: 60, time_to_number_one_seconds: 60, rank_changes: 2, headline_changes: 1 }, members: [{ source_id: 'abc1', publisher: 'ABC News', first_seen_at: earlier, first_rank: 4, peak_rank: 1, observed_duration_seconds: 60 }, { source_id: 'cbs1', publisher: 'CBS News', first_seen_at: now, first_rank: 6, peak_rank: 3, observed_duration_seconds: 30 }], events: [{ event_type: 'FIRST_DETECTED', observed_at: earlier, publisher: 'ABC News', rank: 4, headline: 'ABC deterministic headline', metadata: {} }, { event_type: 'PUBLISHER_PICKUP', observed_at: now, publisher: 'CBS News', rank: 6, headline: 'CBS retained last-good headline', metadata: {} }] };
  const recentStories = [
    { story_id: storyId, canonical_label: 'ABC deterministic headline', first_detected_at: earlier, second_publisher_at: now, first_source_id: 'abc1', last_seen_at: now, publishers_detected: 3, recent_publishers: 3, publisher_ids: ['abc1','cbs1','nbc1'], active_source_ids: ['abc1','cbs1','nbc1'], publishers_reaching_number_one: 1, rank_changes: 2, headline_changes: 1 },
    { story_id: '00000000-0000-0000-0000-000000000100', canonical_label: 'Secondary shared story', first_detected_at: earlier, second_publisher_at: now, first_source_id: 'cbs1', last_seen_at: earlier, publishers_detected: 2, recent_publishers: 0, publisher_ids: ['cbs1','fox1'], active_source_ids: [], publishers_reaching_number_one: 0, rank_changes: 0, headline_changes: 0 },
  ];
  return { earlier, now, recentStories, snapshot, storyHistory, storyId, top10 };
}

export async function installFrontendRoutes(page, fixture, { coverage } = {}) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (frontendAssets.has(url.pathname)) {
      const [contentType, body] = frontendAssets.get(url.pathname);
      return route.fulfill({ contentType, body });
    }
    if (url.pathname.endsWith('/supabase.json')) return route.fulfill({ json: { url: 'https://mock.supabase.test', anonKey: 'test-key' } });
    if (url.pathname.endsWith('/newsboard_snapshot')) return route.fulfill({ json: fixture.snapshot });
    if (url.pathname.endsWith('/newsboard_collection_health')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/newsboard_timeline')) return route.fulfill({ json: { events: [{ ts: fixture.now, source_id: 'abc1', kind: 'new_url', title: 'ABC deterministic headline', url: fixture.snapshot.cacheLike.sources.abc1.item.url }] } });
    if (url.pathname.endsWith('/newsboard_top10')) return route.fulfill({ json: fixture.top10 });
    if (url.pathname.endsWith('/newsboard_story_badges')) return route.fulfill({ json: [{ story_id: fixture.storyId, source_id: 'abc1', url: fixture.snapshot.cacheLike.sources.abc1.item.url, title: fixture.snapshot.cacheLike.sources.abc1.item.title, first_source_id: 'abc1', publisher_count: 2, first_detected_at: fixture.earlier }] });
    if (url.pathname.endsWith('/newsboard_story_history')) return route.fulfill({ json: fixture.storyHistory });
    if (url.pathname.endsWith('/newsboard_recent_stories')) return route.fulfill({ json: fixture.recentStories });
    if (url.pathname.endsWith('/newsboard_story_operational_health')) return route.fulfill({ json: { status: 'healthy', lag_seconds: 60, unprocessed_batches: 0 } });
    if (url.pathname === '/api/gdelt/coverage' && coverage) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(coverage) });
    return route.abort();
  });
}
