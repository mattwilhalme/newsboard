import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPublisher,parseAbcTop10,normalizeUrl,publishers} from '../../supabase/functions/newsboard-crawl/collectors.js';
test('reject a blocked response even when it contains plausible news markup',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response('<main><h4 class="item__hed"><a href="https://cbsnews.com/news/plausible">A plausible headline on a blocked page</a></h4></main>',{status:403});
  await assert.rejects(collectPublisher(publishers.find(p=>p.id==='cbs1')),/HTTP 403/);
 }finally{globalThis.fetch=original;}
});
test('empty HTTP pages fail rather than clear state',async()=>{
 const original=globalThis.fetch;
 try{globalThis.fetch=async()=>new Response('<main></main>');await assert.rejects(collectPublisher(publishers.find(p=>p.id==='cbs1')),/not found|No usable/);}finally{globalThis.fetch=original;}
});
test('ABC rejects a truncated Top 10',()=>{
 const items=Array.from({length:9},(_,i)=>({'@type':'NewsArticle',headline:`Example story headline number ${i}`,url:`https://abcnews.com/US/story?id=${i}`}));
 assert.throws(()=>parseAbcTop10(`<script type="application/ld+json">${JSON.stringify(items)}</script>`),/expected 10/);
});
test('normalization keeps article identity while dropping tracking parameters',()=>{
 assert.equal(normalizeUrl('https://www.abcnews.com/US/story/?utm_source=test&id=123#section'),'https://abcnews.com/US/story?id=123');
});
