import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
const root=path.resolve('docs');
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
 if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{const data=fs.readFileSync(file);res.setHeader('content-type',file.endsWith('.json')?'application/json':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(data);}catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[],rpc=[],fallback=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().includes('/rest/v1/rpc/'))rpc.push({url:r.url().split('/').pop(),status:r.status(),error:r.status()>=400?await r.text():null});if(/\/data\/.*\.json|\/cache\.json/.test(r.url()))fallback.push(r.url());});
 await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.body.innerText.includes('Trump')||document.body.innerText.includes('Newsom'),{timeout:45000});
 await page.waitForTimeout(3000);
 await page.screenshot({path:'/tmp/newsboard-supabase-ui.png',fullPage:true});
 const text=await page.locator('body').innerText();
 await page.locator('#tab-labs').click();
 await page.waitForSelector('#deep-top10-list .top10Row');
 const top10Count=await page.locator('#deep-top10-list .top10Row').count();
 await page.screenshot({path:'/tmp/newsboard-supabase-top10-ui.png',fullPage:true});
 const result={top10Count,errors,rpc,fallback,hasFailureIndicator:text.includes('Latest crawl failed'),hasHeadlines:text.includes('Trump'),bodySample:text.slice(0,1600)};
 fs.writeFileSync('/tmp/newsboard-ui-smoke.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 if(top10Count!==10||errors.length||!rpc.some(r=>r.url==='newsboard_snapshot'&&r.status===200)||fallback.length)process.exitCode=1;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
