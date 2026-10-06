import assert from 'node:assert/strict';
import test from 'node:test';
import { launchTestBrowser } from './support/browser.mjs';
import { createFrontendFixture, installFrontendRoutes } from './support/frontend-fixture.mjs';

test('AP discovery is clearly labeled, unranked, and separate from archived AP homepage data', { timeout: 45_000 }, async () => {
  const fixture = createFrontendFixture();
  const items = Array.from({ length: 25 }, (_, i) => ({ title: `AP discovery example headline ${i}`, url: `https://news.google.com/rss/articles/example${i}`, publishedAt: new Date(Date.parse(fixture.earlier) - i * 60_000).toISOString(), coverageScope: 'discovery', via: 'Google News', publisher: 'Associated Press' }));
  const invalid = { ...items[0], title: 'Unsafe external link must not render', url: 'https://example.com/unsafe' };
  fixture.snapshot.cacheLike.sources.apgoogle1 = { ok: true, sourceName: 'AP via Google News', kind: 'discovery', updatedAt: fixture.now, item: items[0], items: [...items, invalid], error: 'Crawl Failed: simulated feed outage', health: { crawlStatus: 'failed', latestError: 'simulated feed outage', method: 'http' } };
  fixture.snapshot.cacheLike.sources.ap1 = { ok: true, sourceName: 'Associated Press', updatedAt: fixture.now, item: { title: 'Historical AP homepage lead', url: 'https://apnews.com/article/history' } };
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10_000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await installFrontendRoutes(page, fixture);
    await page.goto('https://board.test/newsboard/');
    await page.waitForFunction(() => document.querySelector('#btn-reload')?.disabled === false);
    const card = page.locator('#cards-grid [data-source-id="apgoogle1"]');
    assert.equal(await page.locator('#cards-grid .card').count(), 12);
    assert.equal(await page.locator('#cards-grid [data-source-id="ap1"]').count(), 0);
    assert.equal(await card.locator('.srcName').innerText(), 'Associated Press');
    assert.equal(await card.locator('.srcVia').innerText(), 'via Google News');
    assert.match(await card.locator('.srcVia').getAttribute('title'), /not AP homepage rankings/);
    assert.match(await card.innerText(), /Published/);
    assert.doesNotMatch(await card.innerText(), /Crawl Failed|crawl pending|feed outage/i);
    assert.match(await page.locator('#cards-grid [data-source-id="cbs1"]').innerText(), /Crawl Failed/);
    assert.equal(await card.locator('.storyIntelBadge,.changeDot').count(), 0);
    // Keep timestamp phrases whole without introducing card/header overflow.
    for (const width of [320, 390, 768, 901, 1200]) {
      await page.setViewportSize({ width, height: 900 });
      const stamps = await page.locator('#cards-grid .cardStamp').evaluateAll(nodes => nodes.filter(n => n.textContent.trim()).map(n => {
        const range = document.createRange(); range.selectNodeContents(n);
        const rect = n.getBoundingClientRect(); const card = n.closest('.card').getBoundingClientRect();
        return { text: n.textContent, nowrap: getComputedStyle(n).whiteSpace, lines: range.getClientRects().length, inside: rect.left >= card.left && rect.right <= card.right };
      }));
      assert.ok(stamps.length > 0);
      for (const stamp of stamps) { assert.equal(stamp.nowrap, 'nowrap'); assert.equal(stamp.lines, 1, `${width}px: ${stamp.text}`); assert.equal(stamp.inside, true, `${width}px: timestamp overflow`); }
      assert.equal(await card.locator('.srcName').evaluate(n => n.scrollWidth <= n.clientWidth), true, `${width}px: AP publisher name clipped`);
    }
    await card.getByRole('button', { name: 'View discoveries' }).click();
    assert.match(await page.locator('#source-data').innerText(), /unranked, not AP homepage lead or Top 10/);
    assert.equal(await page.locator('#source-data .discoveryItem').count(), 20);
    assert.equal(await page.locator('#source-data .latestTitle a').first().innerText(), items[0].title);
    assert.match(await page.locator('#source-data .srcTime').first().innerText(), /Published/);
    assert.equal(await page.locator('#source-data ul').count(), 0);
    assert.equal(await page.locator('#source-data ol').count(), 0);
    const showAll = page.locator('#source-data').getByRole('button', { name: 'Show all', exact: true });
    await showAll.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#source-data .discoveryItem').count(), 25);
    const showFewer = page.locator('#source-data').getByRole('button', { name: 'Show fewer', exact: true });
    assert.equal(await showFewer.getAttribute('aria-expanded'), 'true');
    assert.doesNotMatch(await page.locator('#source-data').innerText(), /Unsafe external/);
    const discoveryStyle = await page.locator('#source-data .latestTitle').first().evaluate(n => { const s = getComputedStyle(n); return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, s.color]; });
    await showFewer.click(); assert.equal(await page.locator('#source-data .discoveryItem').count(), 20);
    assert.equal(await page.locator('#source-data').getByRole('button', { name: 'Show all', exact: true }).getAttribute('aria-expanded'), 'false');
    for (const width of [320, 390, 1200]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.locator('#drawer-source-data').evaluate(n => n.scrollWidth <= n.clientWidth), true, `${width}px: discovery drawer overflow`);
    }
    assert.equal(await page.locator('#details-tab-changes').isVisible(), false);
    await page.locator('#btn-source-data-close').click({ force: true });
    await page.locator('#cards-grid [data-source-id="abc1"]').getByRole('button', { name: 'Details', exact: true }).click();
    assert.equal(await page.locator('#details-tab-changes').isVisible(), true);
    await page.locator('#btn-source-data-close').click({ force: true });
    await page.locator('#tab-playxplay').click();
    const historyStyle = await page.locator('#playxplay-history .latestTitle').first().evaluate(n => { const s = getComputedStyle(n); return [s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, s.color]; });
    assert.deepEqual(discoveryStyle, historyStyle, 'Discovery typography must match History exactly');
    await page.locator('#tab-data').click();
    assert.match(await page.locator('[data-health-source="apgoogle1"]').innerText(), /Degraded[\s\S]*failed[\s\S]*Not applicable \(unranked\)[\s\S]*Discovery only/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
