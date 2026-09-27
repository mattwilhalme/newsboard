import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('docs');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(`${root}${path.sep}`)) return res.writeHead(403).end();
  try {
    const data = fs.readFileSync(file);
    res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/gdelt/coverage?**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      query: '"Donald Trump" oligarch wedding sourcelang:english',
      raw_result_count: 3,
      newsboard_story: { title: 'Trump says Donald Trump Jr. repaid Russian oligarch for wedding party', url: 'https://abcnews.com/story', source: 'ABC News', observed_at: '2026-09-19T11:30:53.548Z' },
      results: [
        { title: 'Trump Jr. repaid oligarch for wedding party', url: 'https://example.com/a', domain: 'example.com', gdelt_seen_at: '2026-09-19T10:41:00Z', match_score: 0.81, tracked_by_newsboard: false, is_newsboard_article: false },
        { title: 'Trump says son repaid Russian oligarch', url: 'https://abcnews.com/story', domain: 'abcnews.com', gdelt_seen_at: '2026-09-19T11:02:00Z', match_score: 0.92, tracked_by_newsboard: true, is_newsboard_article: true },
      ],
      earliest_match: { title: 'Trump Jr. repaid oligarch for wedding party', url: 'https://example.com/a', domain: 'example.com', gdelt_seen_at: '2026-09-19T10:41:00Z' },
    }),
  }));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card .headline a', { timeout: 45000 });
  const coverageButton = page.locator('button:visible', { hasText: 'Trace coverage' }).first();
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
  await new Promise(resolve => server.close(resolve));
}
