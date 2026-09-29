import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createFrontendFixture, installFrontendRoutes } from './support/frontend-fixture.mjs';

const now = new Date().toISOString();
const fixture = createFrontendFixture(now);
const { snapshot } = fixture;

test('major views preserve deterministic content, controls and ordering', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await installFrontendRoutes(page, fixture);
  try {
    await page.goto('https://board.test/newsboard/');
    await page.waitForFunction(() => document.querySelector('#btn-reload')?.disabled === false);
    assert.equal(await page.locator('#cards-grid .card').count(), 12);
    assert.equal(await page.locator('#cards-grid [data-source-id="abc1"] [data-role="headline-link"]').getAttribute('href'), snapshot.cacheLike.sources.abc1.item.url);
    await assert.doesNotReject(() => page.locator('#cards-grid [data-source-id="cbs1"]').getByText('CBS retained last-good headline').waitFor());
    await assert.doesNotReject(() => page.locator('#cards-grid [data-source-id="cbs1"]').getByText(/showing last successful observation/i).waitFor());
    const storyBadge = page.locator('#cards-grid [data-source-id="abc1"] .storyIntelBadge');
    await storyBadge.click();
    await page.getByText('Publisher journey',{exact:true}).waitFor();
    assert.match(await page.locator('#story-history-content').innerText(),/First detected by Newsboard[\s\S]*Time to peak coverage[\s\S]*Publisher journey[\s\S]*Observed timeline/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#drawer-story-history').getAttribute('aria-hidden'), 'true');
    assert.equal(await storyBadge.evaluate((node) => document.activeElement === node), true);
    await storyBadge.click();
    await page.getByText('Publisher journey',{exact:true}).waitFor();
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

    await page.locator('#tab-stories').click();
    assert.equal(await page.locator('#view-stories').isVisible(), true);
    assert.equal(await page.locator('#story-radar-list .storyRadarCard').count(), 2);
    assert.match(await page.locator('#story-radar-list').innerText(), /ABC deterministic headline[\s\S]*ABC News[\s\S]*CBS News[\s\S]*Status Spreading[\s\S]*Active 3[\s\S]*No. 1 1[\s\S]*Secondary shared story/);
    await page.locator('#story-radar-min-publishers').selectOption('3');
    assert.equal(await page.locator('#story-radar-list .storyRadarCard').count(), 1);
    await page.locator('#story-radar-active').check();
    assert.match(await page.locator('#story-radar-summary').innerText(), /1 story/);
    await page.locator('#story-radar-publisher').selectOption('abc1');
    await page.locator('#story-radar-number-one').check();
    assert.equal(await page.locator('#story-radar-list .storyRadarCard').count(), 1);

    await page.locator('#tab-playxplay').click();
    assert.match(await page.locator('#story-processing-health').innerText(),/healthy[\s\S]*1m lag/);
    assert.equal(await page.locator('#recent-stories .storyRadarCard').count(), 2);
    assert.match(await page.locator('#recent-stories').innerText(),/3 publishers[\s\S]*ABC deterministic headline/);
    assert.equal(await page.locator('#recent-stories .latestMetaRow').count(), 2);
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
