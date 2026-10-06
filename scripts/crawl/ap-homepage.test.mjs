import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchTestBrowser } from '../support/browser.mjs';
import { loadAPHomepage } from '../../lib/apHomepage.js';
import { MOBILE_CONTEXT, MOBILE_ADAPTERS, extractMobileHero } from '../../lib/mobileHero.js';

let browser;
before(async () => { browser = await launchTestBrowser(); });
after(async () => { await browser?.close(); });
const homepage = '<title>AP News</title><meta name="viewport" content="width=device-width,initial-scale=1"><main><div class="PageListStandardE"><div class="PageListStandardE-leadPromo-info"><h2 class="PagePromo-title"><a href="https://apnews.com/article/lead">A validated AP editorial lead story</a></h2></div></div></main>';
const interstitial = '<title>Just a moment...</title><p>Checking your browser</p>';

async function fixture(respond, check) {
  const context = await browser.newContext(MOBILE_CONTEXT);
  const page = await context.newPage();
  await page.route('https://apnews.com/**', route => respond(route));
  try { await check(page); } finally { await context.close(); }
}

test('AP accepts an ordinary homepage and detaches its document listener', async () => {
  await fixture(route => route.fulfill({ status: 200, contentType: 'text/html', body: homepage }), async page => {
    const count = page.listenerCount('response');
    const result = await loadAPHomepage(page);
    assert.equal(result.ok, true);
    assert.equal(result.initial_http_status, 200);
    assert.equal(result.http_status, 200);
    assert.equal(result.waited_for_interstitial, false);
    assert.equal(page.listenerCount('response'), count);
    assert.equal((await page.evaluate(extractMobileHero, MOBILE_ADAPTERS.ap1)).url, 'https://apnews.com/article/lead');
  });
});

test('AP waits for ordinary page navigation after an initial managed 403', async () => {
  await fixture(route => {
    const cleared = new URL(route.request().url()).searchParams.has('ready');
    return route.fulfill({ status: cleared ? 200 : 403, contentType: 'text/html', body: cleared ? homepage : interstitial + '<script>setTimeout(() => location.assign("/?ready=1"), 100)</script>' });
  }, async page => {
    const result = await loadAPHomepage(page, { interstitialTimeout: 3000 });
    assert.equal(result.ok, true);
    assert.equal(result.initial_http_status, 403);
    assert.equal(result.http_status, 200);
    assert.equal(result.waited_for_interstitial, true);
    assert.deepEqual(result.document_responses.map(r => r.status), [403, 200]);
    assert.equal((await page.evaluate(extractMobileHero, MOBILE_ADAPTERS.ap1)).ok, true);
  });
});

test('AP preserves a persistent interstitial as blocked with one navigation', async () => {
  let requests = 0;
  await fixture(route => { requests++; return route.fulfill({ status: 403, contentType: 'text/html', body: interstitial }); }, async page => {
    const result = await loadAPHomepage(page, { interstitialTimeout: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.access_blocked, true);
    assert.equal(result.http_status, 403);
    assert.equal(requests, 1);
    assert.match(result.error, /interstitial did not clear/);
  });
});

test('a 200 interstitial remains blocked and a 200 markup failure remains a crawl failure', async () => {
  for (const [body, blocked] of [[interstitial, true], ['<title>AP News</title><main>No editorial module</main>', false]]) {
    await fixture(route => route.fulfill({ status: 200, contentType: 'text/html', body }), async page => {
      const result = await loadAPHomepage(page, { interstitialTimeout: 100, renderTimeout: 100 });
      assert.equal(result.ok, false);
      assert.equal(result.access_blocked, blocked);
      assert.equal(result.http_status, 200);
    });
  }
});

test('AP rejects a denied response even if it contains plausible editorial markup', async () => {
  await fixture(route => route.fulfill({ status: 403, contentType: 'text/html', body: interstitial + homepage }), async page => {
    const result = await loadAPHomepage(page);
    assert.equal(result.ok, false);
    assert.equal(result.access_blocked, true);
    assert.equal(result.http_status, 403);
  });
});

test('AP does not wait or retry a rate limit or definitive denial', async () => {
  for (const status of [403, 429, 500]) {
    await fixture(route => route.fulfill({ status, contentType: 'text/html', body: '<title>Unavailable</title>' }), async page => {
      const result = await loadAPHomepage(page);
      assert.equal(result.ok, false);
      assert.equal(result.http_status, status);
      assert.equal(result.access_blocked, status !== 500);
      assert.equal(result.waited_for_interstitial, false);
    });
  }
});
