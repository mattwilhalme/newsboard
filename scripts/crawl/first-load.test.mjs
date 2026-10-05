import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const html = fs.readFileSync('docs/index.html', 'utf8');
const cssAssets = new Map([
 ['/newsboard/css/tokens.css', fs.readFileSync('docs/css/tokens.css', 'utf8')],
 ['/newsboard/css/layout.css', fs.readFileSync('docs/css/layout.css', 'utf8')],
 ['/newsboard/css/components.css', fs.readFileSync('docs/css/components.css', 'utf8')],
]);
const formatJs = fs.readFileSync('docs/js/format.js', 'utf8');
const healthJs = fs.readFileSync('docs/js/health.js', 'utf8');
const dataJs = fs.readFileSync('docs/js/data/supabase.js', 'utf8');
const drawersJs = fs.readFileSync('docs/js/ui/drawers.js', 'utf8');
const intelligenceDrawersJs = fs.readFileSync('docs/js/ui/intelligence-drawers.js', 'utf8');
const storyRadarJs = fs.readFileSync('docs/js/views/story-radar.js', 'utf8');
const overviewCardsJs = fs.readFileSync('docs/js/views/overview-cards.js', 'utf8');
const historyDataJs = fs.readFileSync('docs/js/views/history-data.js', 'utf8');
const clusterEngineJs = fs.readFileSync('docs/js/views/cluster-engine.js', 'utf8');
const clusterAssignmentJs = fs.readFileSync('docs/js/views/cluster-assignment.js', 'utf8');
const labsJs = fs.readFileSync('docs/js/views/labs.js', 'utf8');
const snapshot = (title, stamp = new Date().toISOString(), status = 'success') => ({cacheLike:{sources:{abc1:{ok:true,updatedAt:stamp,item:{title,url:'https://abcnews.go.com/test'},health:{crawlStatus:status}}}},history:{sources:{}}});
async function scenario(fn) {
 const browser = await chromium.launch({channel:'chrome'});
 const page = await browser.newPage();
 let requests=0, misses=0, payload=snapshot('Current live headline'), offline=false;
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*', async route => {
  const url=new URL(route.request().url());
  if(url.pathname==='/newsboard/') return route.fulfill({contentType:'text/html',body:html});
  if(cssAssets.has(url.pathname)) return route.fulfill({contentType:'text/css',body:cssAssets.get(url.pathname)});
  if(url.pathname.endsWith('/js/format.js')) return route.fulfill({contentType:'text/javascript',body:formatJs});
  if(url.pathname.endsWith('/js/health.js')) return route.fulfill({contentType:'text/javascript',body:healthJs});
  if(url.pathname.endsWith('/js/data/supabase.js')) return route.fulfill({contentType:'text/javascript',body:dataJs});
  if(url.pathname.endsWith('/js/ui/drawers.js')) return route.fulfill({contentType:'text/javascript',body:drawersJs});
  if(url.pathname.endsWith('/js/ui/intelligence-drawers.js')) return route.fulfill({contentType:'text/javascript',body:intelligenceDrawersJs});
  if(url.pathname.endsWith('/js/views/story-radar.js')) return route.fulfill({contentType:'text/javascript',body:storyRadarJs});
  if(url.pathname.endsWith('/js/views/overview-cards.js')) return route.fulfill({contentType:'text/javascript',body:overviewCardsJs});
  if(url.pathname.endsWith('/js/views/history-data.js')) return route.fulfill({contentType:'text/javascript',body:historyDataJs});
  if(url.pathname.endsWith('/js/views/cluster-engine.js')) return route.fulfill({contentType:'text/javascript',body:clusterEngineJs});
  if(url.pathname.endsWith('/js/views/cluster-assignment.js')) return route.fulfill({contentType:'text/javascript',body:clusterAssignmentJs});
  if(url.pathname.endsWith('/js/views/labs.js')) return route.fulfill({contentType:'text/javascript',body:labsJs});
  if(url.pathname.endsWith('/supabase.json')) return route.fulfill({json:{url:'https://live.example',anonKey:'public-test'}});
  if(url.pathname.endsWith('/newsboard_snapshot')) {
   requests++; if(offline || misses-->0) return route.fulfill({status:503,json:{error:'temporary'}});
   return route.fulfill({json:payload});
  }
  if(url.pathname.includes('/rpc/')) return route.fulfill({json:url.pathname.endsWith('newsboard_top10')?{latest:null,runs:[]}:url.pathname.endsWith('newsboard_story_badges')?[]:{events:[]}});
  assert.ok(!/cache.json|\/data\//.test(url.pathname),`Unexpected saved GitHub fallback: ${url}`);
  return route.abort();
 });
 const state={page,setPayload:v=>payload=v,setOffline:v=>offline=v,setMisses:v=>misses=v,requests:()=>requests};
 try { await fn(state); assert.deepEqual(errors,[]); } finally { await browser.close(); }
}
async function settled(page) { await page.waitForFunction(()=>document.querySelector('#btn-reload')?.disabled===false); }
test('first load retries a transient miss and displays latest data without Refresh',()=>scenario(async s=>{
 s.setMisses(1); await s.page.goto('https://board.example/newsboard/'); await settled(s.page);
 assert.equal(s.requests(),2); assert.match(await s.page.locator('body').innerText(),/Current live headline/);
 assert.doesNotMatch(await s.page.locator('#subline').innerText(),/Stale/);
 s.setPayload(snapshot('Newer live headline')); await s.page.locator('#btn-reload').click(); await settled(s.page);
 assert.match(await s.page.locator('body').innerText(),/Newer live headline/);
}));
test('fresh reload never resurrects a persisted snapshot; automatic retry recovers',()=>scenario(async s=>{
 await s.page.goto('https://board.example/newsboard/');await settled(s.page);
 await s.page.evaluate(saved=>localStorage.setItem('nb_last_successful_snapshot_v1',JSON.stringify(saved)),snapshot('Several-day-old cached headline','2026-09-18T12:00:00.000Z'));
 s.setOffline(true);await s.page.reload();await settled(s.page);
 assert.match(await s.page.locator('#subline').innerText(),/Live data unavailable/);
 assert.doesNotMatch(await s.page.locator('body').innerText(),/Several-day-old|Current live headline|Stale data/);
 assert.equal(await s.page.evaluate(()=>localStorage.getItem('nb_last_successful_snapshot_v1')),null);
 s.setOffline(false);s.setPayload(snapshot('Recovered automatically'));
 await s.page.waitForFunction(()=>document.body.innerText.includes('Recovered automatically'),{},{timeout:25000});
}));
test('failed refresh preserves only the already rendered session',()=>scenario(async s=>{
 await s.page.goto('https://board.example/newsboard/');await settled(s.page);
 s.setOffline(true);await s.page.locator('#btn-reload').click();await settled(s.page);
 assert.match(await s.page.locator('body').innerText(),/Current live headline/);
 assert.equal(await s.page.locator('#collection-health tbody tr').count(),12);
 assert.match(await s.page.locator('[data-health-source="abc1"]').innerText(),/Healthy/);
 assert.doesNotMatch(await s.page.locator('body').innerText(),/Stale data|stale \(no change/);
}));
test('fresh outage shows unavailable and no historical headlines',()=>scenario(async s=>{
 s.setOffline(true);await s.page.goto('https://board.example/newsboard/');await settled(s.page);
 assert.match(await s.page.locator('#subline').innerText(),/Live data unavailable/);
 assert.doesNotMatch(await s.page.locator('body').innerText(),/Current live headline|Stale data/);
}));
test('publishers validate independently and legacy lastAttemptSuccess cannot declare failure',()=>scenario(async s=>{
 const p=snapshot('Valid ABC headline');
 p.cacheLike.sources.cnn1={ok:true,item:{title:'Invalid CNN row',url:'not-a-url'},updatedAt:'invalid',health:{crawlStatus:'success'}};
 p.cacheLike.sources.nbc1={ok:true,item:{title:'Previous successful NBC headline',url:'https://nbcnews.com/news/test'},updatedAt:new Date().toISOString(),health:{crawlStatus:'failed'}};
 p.cacheLike.sources.cbs1={ok:true,item:{title:'CBS legacy ambiguous state',url:'https://cbsnews.com/news/test'},updatedAt:new Date().toISOString(),health:{lastAttemptSuccess:false}};
 s.setPayload(p);await s.page.goto('https://board.example/newsboard/');await settled(s.page);
 const body=await s.page.locator('body').innerText();assert.match(body,/Valid ABC headline/);assert.doesNotMatch(body,/Invalid CNN row/);assert.match(body,/Previous successful NBC headline/);assert.match(body,/Crawl Failed — showing last successful observation/);
 assert.equal((body.match(/Crawl Failed/g)||[]).length,1);
}));
test('unchanged old headline with a successful observation has no stale indicator',()=>scenario(async s=>{
 const p=snapshot('Unchanged legitimate headline',new Date().toISOString());p.cacheLike.sources.abc1.lastChangeAt='2026-09-18T12:00:00Z';p.cacheLike.sources.abc1.isStale=true;
 s.setPayload(p);await s.page.goto('https://board.example/newsboard/');await settled(s.page);
 assert.doesNotMatch(await s.page.locator('body').innerText(),/stale/i);assert.equal(await s.page.locator('.changeDot.stale').count(),0);
}));
test('combined browser states render pending/running, success, then final failure',()=>scenario(async s=>{
 for(const status of ['pending','running','success','failed']) {
  s.setPayload(snapshot('Tracked headline',new Date().toISOString(),status));
  if(status==='pending')await s.page.goto('https://board.example/newsboard/');else await s.page.locator('#btn-reload').click();
  await settled(s.page);const body=await s.page.locator('body').innerText();
  if(status==='failed')assert.match(body,/Crawl Failed/);
  else {assert.doesNotMatch(body,/Crawl Failed/);if(status!=='success')assert.match(body,new RegExp(`Browser crawl ${status}`));}
 }
}));
