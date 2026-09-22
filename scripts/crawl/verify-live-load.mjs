import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:'chrome'});
try {
 const page=await browser.newPage(); const errors=[],staticFallback=[]; let snapshot;
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(/\/cache\.json|\/data\/.*\.json|cdn.jsdelivr.net/.test(r.url()))staticFallback.push(r.url());});
 page.on('response',async r=>{if(r.url().endsWith('/newsboard_snapshot')&&r.ok())snapshot=await r.json();});
 await page.goto(process.env.NEWSBOARD_SMOKE_URL || 'https://mattwilhalme.github.io/newsboard/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.querySelector('#btn-reload')?.disabled===false,{},{timeout:90000});
 assert.ok(snapshot?.cacheLike?.sources,'Initial load must fetch live snapshot without Refresh');
 const body=await page.locator('body').innerText();
 const expected=['abc1','cbs1','usat1','nbc1','cnn1','guardian1','ap1','latimes1','npr1','bbc1','fox1','yahoo1'];
 for(const id of expected)assert.ok(body.includes(snapshot.cacheLike.sources[id].item.title),`Missing live headline: ${id}`);
 const workers=await page.evaluate(async()=>({controller:!!navigator.serviceWorker.controller,registrations:(await navigator.serviceWorker.getRegistrations()).length,cacheKeys:await caches.keys()}));
 assert.deepEqual(staticFallback,[]);assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/newsboard-live-first-load.png',fullPage:true});
 await page.route('**/rest/v1/rpc/newsboard_snapshot',r=>r.fulfill({status:503,json:{error:'Verification outage'}}));
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.querySelector('#btn-reload')?.disabled===false,{},{timeout:90000});
 const staleLabel=await page.locator('#subline').innerText();assert.match(staleLabel,/Stale data.*snapshot: \d{4}-/);
 await page.screenshot({path:'/tmp/newsboard-live-stale-snapshot.png',fullPage:true});
 await page.unroute('**/rest/v1/rpc/newsboard_snapshot');
 await page.waitForFunction(()=>document.querySelector('#subline').innerText.startsWith('Last update:'),{},{timeout:45000});
 console.log(JSON.stringify({url:page.url(),sourceCount:Object.keys(snapshot.cacheLike.sources).length,automaticFirstLoad:true,automaticOutageRecovery:true,staleLabel,workers,staticFallback,errors,statuses:Object.fromEntries(Object.entries(snapshot.cacheLike.sources).map(([id,s])=>[id,s.health.crawlStatus]))},null,2));
}finally{await browser.close();}
