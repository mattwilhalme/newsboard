import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const html = fs.readFileSync('docs/index.html', 'utf8');
const snapshot = (title, stamp = new Date().toISOString(), status = 'success') => ({cacheLike:{sources:{abc1:{ok:true,updatedAt:stamp,item:{title,url:'https://abcnews.go.com/test'},health:{crawlStatus:status}}}},history:{sources:{}}});
async function scenario(fn) {
 const browser = await chromium.launch({channel:'chrome'});
 const page = await browser.newPage();
 let requests=0, misses=0, payload=snapshot('Current live headline'), offline=false;
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*', async route => {
  const url=new URL(route.request().url());
  if(url.pathname==='/newsboard/') return route.fulfill({contentType:'text/html',body:html});
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
test('outage uses only last successful browser snapshot with timestamp; automatic retry recovers',()=>scenario(async s=>{
 const stamp='2026-09-18T12:00:00.000Z'; s.setPayload(snapshot('Saved prior headline',stamp));
 await s.page.goto('https://board.example/newsboard/'); await settled(s.page);
 s.setOffline(true); await s.page.reload(); await settled(s.page);
 assert.match(await s.page.locator('#subline').innerText(),new RegExp(`Stale data.*${stamp}`));
 assert.match(await s.page.locator('body').innerText(),/Saved prior headline/);
 s.setOffline(false);s.setPayload(snapshot('Recovered automatically'));
 await s.page.waitForFunction(()=>document.body.innerText.includes('Recovered automatically'),{},{timeout:25000});
}));
test('outage on clean browser shows no obsolete GitHub stories',()=>scenario(async s=>{
 s.setOffline(true);await s.page.goto('https://board.example/newsboard/');await settled(s.page);
 assert.match(await s.page.locator('#subline').innerText(),/No saved snapshot/);
 assert.doesNotMatch(await s.page.locator('body').innerText(),/Current live headline/);
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
