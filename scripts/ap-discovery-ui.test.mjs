import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createFrontendFixture, installFrontendRoutes } from './support/frontend-fixture.mjs';

test('AP discovery is clearly labeled, unranked, and separate from archived AP homepage data', { timeout: 45_000 }, async () => {
  const fixture = createFrontendFixture();
  const items = [0,1].map(i => ({ title: `AP discovery example headline ${i}`, url: `https://news.google.com/rss/articles/example${i}`, publishedAt: fixture.earlier, coverageScope: 'discovery', via: 'Google News', publisher: 'Associated Press' }));
  fixture.snapshot.cacheLike.sources.apgoogle1 = { ok: true, sourceName: 'AP via Google News', kind: 'discovery', updatedAt: fixture.now, item: items[0], items, health: { crawlStatus: 'success', method: 'http' } };
  fixture.snapshot.cacheLike.sources.ap1 = { ok: true, sourceName: 'Associated Press', updatedAt: fixture.now, item: { title: 'Historical AP homepage lead', url: 'https://apnews.com/article/history' } };
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await installFrontendRoutes(page, fixture);
    await page.goto('https://board.test/newsboard/');
    await page.waitForFunction(() => document.querySelector('#btn-reload')?.disabled === false);
    const card = page.locator('#cards-grid [data-source-id="apgoogle1"]');
    assert.equal(await page.locator('#cards-grid .card').count(), 12);
    assert.equal(await page.locator('#cards-grid [data-source-id="ap1"]').count(), 0);
    assert.match(await card.innerText(), /AP via Google News[\s\S]*Not AP homepage rankings[\s\S]*Published/);
    assert.equal(await card.locator('.storyIntelBadge,.changeDot').count(), 0);
    await card.getByRole('button', { name: 'View discoveries' }).click();
    assert.match(await page.locator('#source-data').innerText(), /unranked, not AP homepage lead or Top 10/);
    assert.equal(await page.locator('#source-data ul li').count(), 2);
    assert.equal(await page.locator('#source-data ol').count(), 0);
    assert.equal(await page.locator('#details-tab-changes').isVisible(), false);
    await page.locator('#btn-source-data-close').click();
    await page.locator('#cards-grid [data-source-id="abc1"]').getByRole('button', { name: 'Details', exact: true }).click();
    assert.equal(await page.locator('#details-tab-changes').isVisible(), true);
    await page.locator('#btn-source-data-close').click();
    await page.locator('#tab-data').click();
    assert.match(await page.locator('[data-health-source="apgoogle1"]').innerText(), /Not applicable \(unranked\)[\s\S]*Discovery only/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
