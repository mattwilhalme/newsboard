import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { chromium } from 'playwright';

const assets = new Map([
  ['/newsboard/', ['text/html', fs.readFileSync('docs/index.html', 'utf8')]],
  ['/newsboard/js/format.js', ['text/javascript', fs.readFileSync('docs/js/format.js', 'utf8')]],
  ['/newsboard/js/health.js', ['text/javascript', fs.readFileSync('docs/js/health.js', 'utf8')]],
  ['/newsboard/js/data/supabase.js', ['text/javascript', fs.readFileSync('docs/js/data/supabase.js', 'utf8')]],
]);
const now = new Date().toISOString();
const earlier = new Date(Date.now() - 60_000).toISOString();
const snapshot = {
  cacheLike: { generatedAt: now, sources: {
    abc1: { ok: true, sourceName: 'ABC News', updatedAt: now, firstSeenAt: earlier, item: { title: 'ABC deterministic headline', url: 'https://abcnews.com/US/example/story?id=1' }, health: { crawlStatus: 'success', method: 'http' } },
    cbs1: { ok: true, sourceName: 'CBS News', updatedAt: earlier, firstSeenAt: earlier, item: { title: 'CBS retained last-good headline', url: 'https://www.cbsnews.com/news/example' }, health: { crawlStatus: 'failed', latestError: 'upstream blocked', method: 'browser' } },
  } },
  history: { generatedAt: now, sources: {
    abc1: { entries: [{ title: 'ABC previous story', url: 'https://abcnews.com/US/previous/story?id=2', firstSeenAt: new Date(Date.now() - 120_000).toISOString(), lastSeenAt: new Date(Date.now() - 120_000).toISOString() }, { title: 'ABC original headline', url: 'https://abcnews.com/US/example/story?id=1', firstSeenAt: earlier, lastSeenAt: earlier }, { title: 'ABC deterministic headline', url: 'https://abcnews.com/US/example/story?id=1', firstSeenAt: now, lastSeenAt: now }] },
    cbs1: { entries: [{ title: 'CBS retained last-good headline', url: 'https://www.cbsnews.com/news/example', firstSeenAt: earlier, lastSeenAt: earlier }] },
  } },
};
const top10 = { latest: { ok: true, observedAt: now, items: [{ rank: 1, title: 'ABC ranked story', url: 'https://abcnews.com/US/ranked/story?id=3' }] }, runs: [{ ok: true, observedAt: now, items: [{ rank: 1, title: 'ABC ranked story', url: 'https://abcnews.com/US/ranked/story?id=3' }] }] };
const storyId='00000000-0000-0000-0000-000000000099';
const storyHistory={story:{id:storyId,canonical_label:'ABC deterministic headline',first_detected_at:earlier,first_source_id:'abc1'},publisher_count:2,current_number_ones:1,metrics:{publishers_detected:2,time_to_peak_seconds:60,time_to_number_one_seconds:60,rank_changes:2,headline_changes:1},members:[{source_id:'abc1',publisher:'ABC News',first_seen_at:earlier,first_rank:4,peak_rank:1,observed_duration_seconds:60},{source_id:'cbs1',publisher:'CBS News',first_seen_at:now,first_rank:6,peak_rank:3,observed_duration_seconds:30}],events:[{event_type:'FIRST_DETECTED',observed_at:earlier,publisher:'ABC News',rank:4,headline:'ABC deterministic headline',metadata:{}},{event_type:'PUBLISHER_PICKUP',observed_at:now,publisher:'CBS News',rank:6,headline:'CBS retained last-good headline',metadata:{}}]};

test('major views preserve deterministic content, controls and ordering', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (assets.has(url.pathname)) { const [contentType, body] = assets.get(url.pathname); return route.fulfill({ contentType, body }); }
    if (url.pathname.endsWith('/supabase.json')) return route.fulfill({ json: { url: 'https://mock.supabase.test', anonKey: 'test-key' } });
    if (url.pathname.endsWith('/newsboard_snapshot')) return route.fulfill({ json: snapshot });
    if (url.pathname.endsWith('/newsboard_collection_health')) return route.fulfill({ json: {} });
    if (url.pathname.endsWith('/newsboard_timeline')) return route.fulfill({ json: { events: [{ ts: now, source_id: 'abc1', kind: 'new_url', title: 'ABC deterministic headline', url: snapshot.cacheLike.sources.abc1.item.url }] } });
    if (url.pathname.endsWith('/newsboard_top10')) return route.fulfill({ json: top10 });
    if (url.pathname.endsWith('/newsboard_story_badges')) return route.fulfill({ json: [{story_id:storyId,source_id:'abc1',url:snapshot.cacheLike.sources.abc1.item.url,title:snapshot.cacheLike.sources.abc1.item.title,first_source_id:'abc1',publisher_count:2,first_detected_at:earlier}] });
    if (url.pathname.endsWith('/newsboard_story_history')) return route.fulfill({ json: storyHistory });
    return route.abort();
  });
  try {
    await page.goto('https://board.test/newsboard/');
    await page.waitForFunction(() => document.querySelector('#btn-reload')?.disabled === false);
    assert.equal(await page.locator('#cards-grid .card').count(), 12);
    assert.equal(await page.locator('#cards-grid [data-source-id="abc1"] [data-role="headline-link"]').getAttribute('href'), snapshot.cacheLike.sources.abc1.item.url);
    await assert.doesNotReject(() => page.locator('#cards-grid [data-source-id="cbs1"]').getByText('CBS retained last-good headline').waitFor());
    await assert.doesNotReject(() => page.locator('#cards-grid [data-source-id="cbs1"]').getByText(/showing last successful observation/i).waitFor());
    await page.locator('#cards-grid [data-source-id="abc1"] .storyIntelBadge').click();
    await page.getByText('Publisher journey',{exact:true}).waitFor();
    assert.match(await page.locator('#story-history-content').innerText(),/First detected by Newsboard[\s\S]*Time to peak coverage[\s\S]*Publisher journey[\s\S]*Observed timeline/);
    await page.locator('#btn-story-history-close').click();

    await page.locator('#tab-data').click();
    assert.equal(await page.locator('#view-data').isVisible(), true);
    assert.equal(await page.locator('#collection-health tbody tr').count(), 12);
    assert.match(await page.locator('[data-health-source="abc1"]').innerText(), /ABC News[\s\S]*Healthy[\s\S]*success/);
    assert.match(await page.locator('[data-health-source="cbs1"]').innerText(), /CBS News[\s\S]*Degraded[\s\S]*failed/);
    assert.equal(await page.locator('#cards-grid .card').count(), 12);
    assert.match(await page.locator('#data-page').innerText(), /ABC News[\s\S]*CBS News/);
    await page.locator('#data-window-page').selectOption('6');
    assert.equal(await page.locator('#data-window-page').inputValue(), '6');

    await page.locator('#tab-playxplay').click();
    const historyText = await page.locator('#playxplay-history').innerText();
    assert.ok(historyText.indexOf('ABC deterministic headline') < historyText.indexOf('CBS retained last-good headline'));
    await page.locator('#playxplay-history').getByRole('button', { name: 'Show all' }).click();
    assert.equal(await page.locator('#playxplay-history .hItem').count(), 4);
    assert.equal(new Set(await page.locator('#playxplay-history .hItem a').evaluateAll((links) => links.map((link) => link.href))).size, 3);
    assert.match(await page.locator('#data-page').innerText(), /URL changes[\s\S]*Headline Changes/);

    await page.locator('#tab-labs').click();
    assert.equal(await page.locator('#view-labs').isVisible(), true);
    assert.match(await page.locator('#view-labs').innerText(), /Story Clusters[\s\S]*ABC ranked story/);
    await page.locator('#cluster-strictness').selectOption('strict');
    assert.equal(await page.locator('#cluster-strictness').inputValue(), 'strict');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
