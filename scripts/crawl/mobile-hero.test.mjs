import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MOBILE_CONTEXT, MOBILE_ADAPTERS, extractMobileHero } from '../../lib/mobileHero.js';
let browser, context, page;
before(async () => {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'chrome' });
  context = await browser.newContext(MOBILE_CONTEXT);
  page = await context.newPage();
});
after(async () => { await browser?.close(); });
async function select(id, html) {
  await page.setContent(`<base href="${MOBILE_ADAPTERS[id].url}"><meta name="viewport" content="width=device-width,initial-scale=1">${html}`);
  // Fixtures use absolute URLs because setContent retains about:blank location.
  return page.evaluate(extractMobileHero, MOBILE_ADAPTERS[id]);
}
test('mobile profile uses touch and a 390px CSS viewport', async () => {
  await select('ap1', '<main></main>');
  assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, touch: navigator.maxTouchPoints > 0 })), { width: 390, touch: true });
});
test('AP ignores trending and hidden desktop leads', async () => {
  const a = '<a href="https://apnews.com/article/lead">The visible primary AP editorial story</a>';
  const result = await select('ap1', `<main><div class="PageListTrending"><h2>Trending distraction</h2></div><div class="PageListStandardE" style="display:none"><h2 class="PagePromo-title">${a.replace('/lead','/hidden')}</h2></div><div class="PageListStandardE"><div class="PageListStandardE-leadPromo-info"><h2 class="PagePromo-title">${a}</h2></div></div></main>`);
  assert.equal(result.url, 'https://apnews.com/article/lead');
});
test('USA Today uses mobile hero rather than a higher live ticker', async () => {
  const result = await select('usat1', '<main><a href="https://www.usatoday.com/live-story/ticker">Breaking ticker that is not the lead</a><a class="gnt_m_hm" data-t-l=":hero|o|c|hero" href="https://www.usatoday.com/story/lead">The primary USA Today mobile story</a></main>');
  assert.equal(result.url, 'https://www.usatoday.com/story/lead');
});
test('NBC fallback stays inside the first editorial package', async () => {
  const result = await select('nbc1', '<div data-testid="breaking-content"><a href="https://www.nbcnews.com/news/ticker-rcna12">Latest ticker is not the primary story</a></div><section class="pkg storyline"><h2><a href="https://www.nbcnews.com/news/lead-rcna13">NBC primary fallback headline story</a></h2><a href="https://www.nbcnews.com/video/watch">Watch live</a></section>');
  assert.equal(result.url, 'https://www.nbcnews.com/news/lead-rcna13');
  assert.equal(result.selector_tier, 'fallback');
});
test('Yahoo excludes offscreen slides and the personalized feed', async () => {
  const result = await select('yahoo1', '<div id="top-stories"><article aria-roledescription="slide" aria-label="Slide 2 of 8" style="position:absolute;left:370px;width:350px"><a data-ylk="cpos:2;elm:hdln;" href="https://www.yahoo.com/news/second.html">Higher but offscreen secondary slide</a></article><article aria-roledescription="slide" aria-label="Slide 1 of 8"><h3><a data-ylk="cpos:1;elm:hdln;" href="https://www.yahoo.com/news/lead.html">The first editorial Yahoo news slide</a></h3></article></div><h2><a href="https://www.yahoo.com/news/recommended.html">Stories for you recommendation</a></h2>');
  assert.equal(result.url, 'https://www.yahoo.com/news/lead.html');
});
test('Guardian matches visible news headline to overlay link, not promotion', async () => {
  const result = await select('guardian1', '<header><h3>Promotional headline above masthead</h3></header><main><div id="container-news"><ul><li><a aria-label="Guardian primary editorial story" href="https://www.theguardian.com/world/2026/sep/20/lead"></a><h3 class="card-headline"><span class="headline-text">Guardian primary editorial story</span></h3></li></ul></div></main>');
  assert.equal(result.url, 'https://www.theguardian.com/world/2026/sep/20/lead');
});
test('uninterpretable first module fails rather than choosing a lower package', async () => {
  const result = await select('nbc1', '<section class="pkg storyline">Uninterpretable primary module</section><section class="pkg storyline"><h2 class="storyline__headline"><a href="https://www.nbcnews.com/news/secondary-rcna14">A plausible but secondary story</a></h2></section>');
  assert.equal(result.ok, false);
});
test('foreign and utility URLs cannot be persisted as editorial leads', async () => {
  const result = await select('usat1', '<main><a class="gnt_m_hm" data-t-l="hero" href="https://example.com/story/ad">Plausible promotional headline</a></main>');
  assert.equal(result.ok, false);
});
