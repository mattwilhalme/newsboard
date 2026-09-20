import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright';
const root=path.resolve('docs');const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();try{res.setHeader('content-type',file.endsWith('.json')?'application/json':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.NEWSBOARD_SMOKE_URL||`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
 const badge=page.locator('#cards-grid .storyIntelBadge').first();await badge.waitFor({timeout:45000});
 assert.ok((await badge.getAttribute('title')).includes('Open Story History'));
 await page.screenshot({path:'/tmp/newsboard-story-badges.png',fullPage:true});
 await badge.click();await page.locator('.storyPropagation li').first().waitFor({timeout:15000});
 const content=await page.locator('#story-history-content').innerText();assert.match(content,/First detected/);assert.match(content,/Picked up/);assert.match(content,/not first published worldwide/);
 await page.waitForTimeout(300);await page.screenshot({path:'/tmp/newsboard-story-history.png'});
 await page.keyboard.press('Escape');assert.equal(await page.locator('#drawer-story-history').getAttribute('aria-hidden'),'true');
 await page.setViewportSize({width:390,height:844});await badge.click();await page.locator('.storyPropagation li').first().waitFor();await page.waitForTimeout(300);await page.screenshot({path:'/tmp/newsboard-story-history-mobile.png'});
 await page.locator('#btn-story-history-close').click();
 await page.route('**/rest/v1/rpc/newsboard_story_history',route=>route.fulfill({status:503,contentType:'application/json',body:'{"message":"test unavailable"}'}));
 await page.reload({waitUntil:'domcontentloaded'});await badge.waitFor({timeout:45000});await badge.click();await page.getByText('Story History is temporarily unavailable.',{exact:false}).waitFor();assert.ok(await page.locator('#cards-grid .headline').count()>0);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({badges:await page.locator('#cards-grid .storyIntelBadge').count(),errors,history:content,failureIsolated:true},null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
