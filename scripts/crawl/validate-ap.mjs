// Read-only comparison of ordinary mobile browser engines. No database client.
import fs from 'node:fs';
import { webkit, devices } from 'playwright';
import { scrapeAPHero } from '../../server.js';
import { loadAPHomepage } from '../../lib/apHomepage.js';
import { MOBILE_ADAPTERS, extractMobileHero } from '../../lib/mobileHero.js';
import { collectBrowserTop10 } from '../../lib/top10Browser.js';

const flag = process.argv.indexOf('--browser');
const engine = flag < 0 ? 'chrome' : process.argv[flag + 1];
if (!['chrome', 'webkit'].includes(engine)) throw new Error('Choose --browser chrome or webkit');
process.env.NEWSBOARD_MOBILE_SCREENSHOTS = '1';
const runId = `ap-access-${engine}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
let browser, context, page, result;
try {
  if (engine === 'chrome') {
    result = await scrapeAPHero();
  } else {
    browser = await webkit.launch({ headless: true });
    const profile = { ...devices['iPhone 13'], deviceScaleFactor: 1 };
    context = await browser.newContext(profile);
    page = await context.newPage();
    const { ok, error, ...accessMeta } = await loadAPHomepage(page);
    let hero = { ok: false, error };
    if (ok) {
      await page.waitForTimeout(1500);
      hero = await page.evaluate(extractMobileHero, MOBILE_ADAPTERS.ap1);
      if (hero.ok) {
        await page.waitForTimeout(500);
        const confirmed = await page.evaluate(extractMobileHero, MOBILE_ADAPTERS.ap1);
        if (!confirmed.ok || confirmed.title !== hero.title || confirmed.url !== hero.url) throw new Error('Mobile editorial lead changed while rendering');
        hero = confirmed;
      }
    }
    const item = hero.ok ? { title: hero.title, url: hero.url, imgUrl: hero.imgUrl } : null;
    const ranked = item ? await collectBrowserTop10(page, 'ap1', item) : null;
    result = {
      id: 'ap1', ok: Boolean(item), error: item ? null : hero.error, item,
      fetchedAt: new Date().toISOString(), runId,
      meta: { collection_method: 'browser', engine, device: 'iPhone 13', mobile: true, viewport: profile.viewport, ...accessMeta, page_url: page.url(), selector_used: hero.selector_used ?? null },
      top10: ranked?.items, top10_quality: ranked?.quality, top10_diagnostics: ranked?.diagnostics,
    };
    fs.writeFileSync(`archive/${runId}.html`, await page.content());
    await page.screenshot({ path: `archive/${runId}.png`, timeout: 10000 }).catch(() => {});
  }
} catch (error) {
  result = { id: 'ap1', ok: false, error: error.message, meta: { engine } };
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
fs.writeFileSync(`archive/${runId}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, error: result.error, meta: result.meta, item: result.item, top10_quality: result.top10_quality, top10_items: result.top10?.length, runId }));
// Production may retain a validated lead when ranked coverage is partial, but
// an exact-homepage provider trial must prove all ten ranks and CP agreement.
if (!result.ok || result.top10_quality !== 'complete' || result.top10?.length !== 10) process.exitCode = 1;
