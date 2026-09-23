import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalArticleUrl,validateTop10} from '../../supabase/functions/_shared/top10.js';
import {collectPublisher,publishers} from '../../supabase/functions/newsboard-crawl/collectors.js';
import {extractHttpTop10} from '../../supabase/functions/newsboard-crawl/top10-http.js';
import {collectBrowserTop10} from '../../lib/top10Browser.js';
const rows=n=>Array.from({length:n},(_,i)=>({title:`Editorial story number ${i}`,url:`https://example.com/story/${i}`}));
const validate=r=>validateTop10(r,{sourceId:'test',baseUrl:'https://example.com',centerpiece:r[0]});
test('canonical URLs collapse tracking, fragment, host and protocol variants while retaining article IDs',()=>{
 assert.equal(canonicalArticleUrl('http://www.abcnews.com/US/story/?id=12&utm_source=x&entryId=2#latest'), 'https://abcnews.go.com/US/story?id=12');
 assert.equal(canonicalArticleUrl('/news/story.html?guccounter=1','https://news.yahoo.com'),'https://yahoo.com/news/story.html');
 assert.notEqual(canonicalArticleUrl('https://abcnews.com/US/story?id=12'),canonicalArticleUrl('https://abcnews.com/US/story?id=13'));
});
test('dedup before assigning sequential ranks, filling from subsequent valid editorial candidates',()=>{
 const r=rows(12);r.splice(1,0,{...r[0],url:r[0].url+'/?utm_medium=test#x'});
 const v=validate(r);assert.equal(v.items.length,10);assert.equal(v.diagnostics.duplicates_removed,1);assert.deepEqual(v.items.map(x=>x.rank),[1,2,3,4,5,6,7,8,9,10]);
});
test('partial extraction retains eight items without invalid or excluded fillers',()=>{
 const v=validate([...rows(8),{title:'Subscribe',url:'/account'},{title:'Plausible paid promotion',url:'/story/ad',rejected:'excluded module'}]);
 assert.equal(v.quality,'partial');assert.equal(v.items.length,8);
});
test('rank one mismatch produces a warning and URL identity survives retitling',()=>{
 const r=rows(10),v=validateTop10(r,{centerpiece:r[1]});assert.equal(v.quality,'warning');assert.equal(v.diagnostics.centerpiece_agreement,false);
 const renamed=validate([{...r[0],title:'A changed editorial headline'},...r.slice(1)]);assert.equal(renamed.items[0].fingerprint,validate(r).items[0].fingerprint);
});
test('one ABC homepage fetch returns CP plus ranking and recognizes live articles without live TV',async()=>{
 const original=globalThis.fetch;let requests=0;
 const html='<main>'+['/Live','/International/live-updates/real-news?id=1',...Array.from({length:9},(_,i)=>`/US/story?id=${i+2}`)].map((url,i)=>`<article data-testid="prism-card"><a data-testid="prism-linkbase" href="https://abcnews.com${url}"><h2>${i?'Primary editorial headline number '+i:'ABC News Live'}</h2></a></article>`).join('')+'</main>';
 try{globalThis.fetch=async()=>{requests++;return new Response(html);};const r=await collectPublisher(publishers.find(x=>x.id==='abc1'));assert.equal(requests,1);assert.equal(r.top10_quality,'complete');assert.match(r.item.url,/live-updates/);assert.equal(r.items.length,1);}finally{globalThis.fetch=original;}
});
test('missing rank module preserves a valid HTTP centerpiece',async()=>{
 const original=globalThis.fetch;
 try{globalThis.fetch=async()=>new Response('<main><h2><a href="https://abcnews.com/US/story?id=7">Valid centerpiece without ranked cards</a></h2></main>');const r=await collectPublisher(publishers.find(x=>x.id==='abc1'));assert.ok(r.item.title);assert.equal(r.top10_quality,'failed');}finally{globalThis.fetch=original;}
});
test('CBS uses lead section then more top stories, not unrelated links',()=>{
 const card=(i)=>`<article class="item"><a href="https://cbsnews.com/news/story-${i}"><h4 class="item__hed">CBS editorial headline ${i}</h4></a></article>`;
 const html='<nav>'+card(99)+'</nav><section id="component-latest-news">'+Array.from({length:9},(_,i)=>card(i)).join('')+'</section><section id="component-more-top-stories">'+card(9)+'</section>';
 assert.equal(extractHttpTop10('cbs1',html,{url:'https://cbsnews.com/news/story-0'}).quality,'complete');
});
test('browser ranking evaluates existing page once and contains extraction errors',async()=>{
 let calls=0;const r=await collectBrowserTop10({evaluate:async()=>{calls++;throw Error('DOM changed');}},'ap1',rows(1)[0]);assert.equal(calls,1);assert.equal(r.quality,'failed');assert.match(r.diagnostics.error,/DOM changed/);
});

test('out-of-scope HTTP publishers do not incur an extra HTML parse',()=>{
 assert.equal(extractHttpTop10('bbc1',{toString(){throw Error('Unexpected HTML parse');}},{}),null);
});
