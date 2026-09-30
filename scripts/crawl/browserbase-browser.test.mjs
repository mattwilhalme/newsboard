import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { scrapeAPHero } from '../../server.js';

const homepage = '<title>AP News</title><meta name="viewport" content="width=device-width,initial-scale=1"><main><div class="PageListStandardE"><div class="PageListStandardE-leadPromo-info">' +
  Array.from({ length: 10 }, (_, i) => `<h2 class="PagePromo-title"><a href="https://apnews.com/article/story-${i}">AP editorial homepage story number ${i}</a></h2>`).join('') + '</div></div></main>';

async function fixture(t, body, status, verify) {
  const originalEnv = { ...process.env };
  const context = await chromium.launchPersistentContext('', { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'chrome', headless: true });
  const browser = context.browser();
  const page = context.pages()[0];
  const requests = [];
  await page.route('https://apnews.com/**', route => route.fulfill({ status, contentType: 'text/html', body }));
  Object.assign(process.env, { BROWSERBASE_API_KEY: 'fixture-key', NEWSBOARD_AP_BROWSER_PROVIDER: 'browserbase' });
  t.mock.method(chromium, 'connectOverCDP', async () => browser);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json(String(url).endsWith('/sessions') ? { id: 'fixture-session', connectUrl: 'wss://connect.browserbase.com' } : {}, { status: 200 });
  });
  try { await verify(await scrapeAPHero(), requests); }
  finally { process.env = originalEnv; await browser.close().catch(() => {}); }
}

test('the real AP collector works through the Browserbase default context with ten ranked stories', async t => {
  await fixture(t, homepage, 200, (result, requests) => {
    assert.equal(result.ok, true);
    assert.equal(result.item.url, 'https://apnews.com/article/story-0');
    assert.equal(result.top10_quality, 'complete');
    assert.equal(result.top10.length, 10);
    assert.equal(result.top10_diagnostics.centerpiece_agreement, true);
    assert.equal(result.meta.browser_provider, 'browserbase');
    assert.equal(result.meta.browserbase_session_id, 'fixture-session');
    assert.equal(result.meta.http_status, 200);
    assert.deepEqual(requests.at(-1).body, { status: 'REQUEST_RELEASE' });
  });
});

test('Browserbase does not make denied AP markup a valid homepage capture', async t => {
  await fixture(t, homepage, 403, result => {
    assert.equal(result.ok, false);
    assert.equal(result.item, null);
    assert.equal(result.top10, undefined);
    assert.equal(result.meta.access_blocked, true);
    assert.equal(result.meta.browser_provider, 'browserbase');
  });
});
