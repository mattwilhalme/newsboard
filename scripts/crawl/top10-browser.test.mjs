import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {BROWSER_TOP10,extractRenderedCandidates} from '../../lib/top10Browser.js';
import {validateTop10} from '../../supabase/functions/_shared/top10.js';
import {MOBILE_ADAPTERS,extractMobileHero} from '../../lib/mobileHero.js';
let browser,page;
before(async()=>{browser=await chromium.launch({channel:process.env.PLAYWRIGHT_BROWSER_CHANNEL||'chrome'});page=await browser.newPage({viewport:{width:390,height:844}});});
after(async()=>browser?.close());
const cases={
 ap1:['https://apnews.com/article/','<main><div class="PageListStandardE">','</div></main>',(u,t)=>`<h2 class="PagePromo-title"><a href="${u}">${t}</a></h2>`],
 usat1:['https://usatoday.com/story/','<main>','</main>',(u,t)=>`<a style="display:block" class="gnt_m_lm_a" href="${u}">${t}</a>`],
 nbc1:['https://nbcnews.com/news/story-rcna','<section class="pkg multi-storyline">','</section>',(u,t)=>`<h2 class="multistoryline__headline"><a href="${u}">${t}</a></h2>`],
 cnn1:['https://cnn.com/2026/09/23/news/','<div class="container_lead-package">','</div>',(u,t)=>`<a href="${u}"><span style="display:block" class="container__headline-text">${t}</span></a>`],
 guardian1:['https://theguardian.com/world/2026/sep/23/','<main><div id="container-news"><ul>','</ul></div></main>',(u,t)=>`<li><a href="${u}" aria-label="${t}"></a><h3 class="card-headline"><span class="headline-text">${t}</span></h3></li>`],
 yahoo1:['https://yahoo.com/news/','<div id="top-stories">','</div>',(u,t,i)=>`<article aria-roledescription="slide" aria-label="Slide ${i+1} of 10" style="position:absolute;left:${i*400}px;top:100px;width:350px"><a data-ylk="elm:hdln" href="${u}">${t}</a></article>`],
};
for(const [id,[base,start,end,card]] of Object.entries(cases))test(`${id}: publisher scope, rendered order, URL dedup and ten valid ranks`,async()=>{
 const url=i=>base+i+(id==='yahoo1'?'.html':'');
 const html=start+Array.from({length:10},(_,i)=>card(url(i),`Editorial headline number ${i}`,i)).join('')+card(url(0)+'?utm_source=duplicate','Duplicate headline same article',10)+end;
 await page.setContent(html+'<nav><h2><a href="https://example.com/story">Unrelated navigation article</a></h2></nav>');
 const candidates=await page.evaluate(extractRenderedCandidates,{config:BROWSER_TOP10[id]});
 const r=validateTop10(candidates,{sourceId:id,centerpiece:{url:url(0)}});assert.equal(r.quality,'complete');assert.equal(r.items.length,10);assert.equal(r.items[9].rank,10);
 if(id==='nbc1'){const cp=await page.evaluate(extractMobileHero,MOBILE_ADAPTERS.nbc1);assert.equal(cp.url,url(0));}
});
test('USA Today skips utility and shopping articles',async()=>{
 await page.setContent('<main><a class="gnt_m_lm_a" href="https://usatoday.com/story/life/horoscope/daily">Read your daily horoscope today</a></main>');
 const r=await page.evaluate(extractRenderedCandidates,{config:BROWSER_TOP10.usat1});assert.equal(r[0].rejected,'utility/shopping');
});

test('CNN excludes trending ribbon even when links lead to real articles',async()=>{
 await page.setContent('<div class="container_ribbon"><a href="https://cnn.com/2026/09/23/news/ticker"><span class="container__headline-text">Trending topic ticker</span></a></div>');
 const r=await page.evaluate(extractRenderedCandidates,{config:BROWSER_TOP10.cnn1});assert.equal(r[0].rejected,'excluded module');
});

test('USA Today retains editorial grocery/car coverage, excluding commercial shopping',async()=>{
 await page.setContent('<main>'+['/story/grocery/shopping/2026/news','/story/cars/shopping/2026/evs','/story/shopping/deals/2026/product','/picture-gallery/news/2026/gallery','/videos/news/2026/report'].map(u=>`<a class="gnt_m_lm_a" href="https://usatoday.com${u}">Editorial headline with enough text</a>`).join('')+'</main>');
 const r=await page.evaluate(extractRenderedCandidates,{config:BROWSER_TOP10.usat1});assert.equal(r.find(x=>x.url.includes('/story/shopping/')).rejected,'utility/shopping');assert.equal(r.filter(x=>!x.rejected).length,4);
});
