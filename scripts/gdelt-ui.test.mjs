import { launchTestBrowser } from './support/browser.mjs';
import { createFrontendFixture, installFrontendRoutes } from './support/frontend-fixture.mjs';

const fixture = createFrontendFixture('2026-09-19T11:30:53.548Z');
const coverage = {
  query: '"Donald Trump" oligarch wedding sourcelang:english',
  raw_result_count: 3,
  newsboard_story: { title: 'ABC deterministic headline', url: fixture.snapshot.cacheLike.sources.abc1.item.url, source: 'ABC News', observed_at: fixture.now },
  results: [
    { title: 'Trump Jr. repaid oligarch for wedding party', url: 'https://example.com/a', domain: 'example.com', gdelt_seen_at: '2026-09-19T10:41:00Z', match_score: 0.81, tracked_by_newsboard: false, is_newsboard_article: false },
    { title: 'Trump says son repaid Russian oligarch', url: fixture.snapshot.cacheLike.sources.abc1.item.url, domain: 'abcnews.com', gdelt_seen_at: '2026-09-19T11:02:00Z', match_score: 0.92, tracked_by_newsboard: true, is_newsboard_article: true },
  ],
  earliest_match: { title: 'Trump Jr. repaid oligarch for wedding party', url: 'https://example.com/a', domain: 'example.com', gdelt_seen_at: '2026-09-19T10:41:00Z' },
};

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await installFrontendRoutes(page, fixture, { coverage });
  await page.goto('https://board.test/newsboard/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#btn-reload')?.disabled === false);
  const coverageButton = page.locator('[data-source-id="abc1"] button:visible', { hasText: 'Trace coverage' }).first();
  if (await coverageButton.isDisabled()) throw new Error('Fixture coverage button unexpectedly disabled');
  await coverageButton.click();
  await page.waitForSelector('#drawer-gdelt.open .gdeltResult');
  const drawer = page.locator('#drawer-gdelt');
  const text = await drawer.innerText();
  const links = await drawer.locator('.gdeltResult a').count();
  if (!text.includes('Newsboard detected') || !text.includes('Earliest GDELT match:') || !text.includes('Newsboard tracks') || !text.includes('This article') || links !== 2 || pageErrors.length) {
    throw new Error(JSON.stringify({ text, links, pageErrors }, null, 2));
  }
  console.log(JSON.stringify({ ok: true, links, pageErrors, hasTrackedBadge: text.includes('Newsboard tracks'), hasSelfBadge: text.includes('This article'), hasEarliest: text.includes('Earliest GDELT match:') }, null, 2));
} finally {
  await browser.close();
}
