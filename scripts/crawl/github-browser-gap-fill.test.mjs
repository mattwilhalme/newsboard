import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCrawlResult, collectors, main } from './github-browser-gap-fill.mjs';
import { BrowserInfrastructureError } from '../../lib/browserbase.js';

test('publisher anti-bot responses are blocked, not infrastructure failures', () => {
  for (const status of [403, 429]) assert.deepEqual(
    classifyCrawlResult({ error: `Mobile homepage HTTP ${status}`, meta: { http_status: status } }),
    { status: 'blocked', http_status: status, error: `Mobile homepage HTTP ${status}` },
  );
  assert.equal(classifyCrawlResult({ error: 'headline not found', meta: { http_status: 200 } }).status, 'crawl_failed');
  assert.equal(classifyCrawlResult({ error: 'AP access interstitial did not clear', meta: { http_status: 200, access_blocked: true } }).status, 'blocked');
  assert.equal(classifyCrawlResult(null, new Error('browserType.launch: executable does not exist')).status, 'infrastructure_error');
  assert.equal(classifyCrawlResult(null, new BrowserInfrastructureError('Browserbase API HTTP 403')).status, 'infrastructure_error');
});

test('existing browser collectors cover both browser-required and HTTP fallback publishers', () => {
  assert.deepEqual(Object.keys(collectors), ['ap1', 'cnn1', 'nbc1', 'guardian1', 'usat1', 'yahoo1', 'abc1', 'cbs1', 'latimes1', 'npr1', 'bbc1', 'fox1']);
  assert.ok(Object.values(collectors).every(collect => typeof collect === 'function'));
});

test('a busy lease exits cleanly without scraping or further database requests', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const originalExitCode = process.exitCode;
  const requests = [];
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await main();
    assert.equal(process.exitCode, originalExitCode);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.endsWith('/rpc/newsboard_start_run'));
    assert.deepEqual(requests[0].body, { p_trigger: 'github_browser_gap_fill' });
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    process.exitCode = originalExitCode;
  }
});

test('dispatched worker links the attempt and records completion even when already fresh', async () => {
  const originalFetch=globalThis.fetch, originalEnv={...process.env};
  const calls=[];
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test',NEWSBOARD_DISPATCH_ID:'00000000-0000-0000-0000-000000000001',GITHUB_RUN_ID:'123',NEWSBOARD_RUNNER_STARTED_AT:'2026-09-22T20:00:00Z'});
  globalThis.fetch=async(url,options={})=>{
    const endpoint=String(url).split('/').at(-1).split('?')[0];calls.push({endpoint,body:options.body?JSON.parse(options.body):null});
    const body=endpoint==='newsboard_browser_start'?'00000000-0000-0000-0000-000000000002':endpoint==='newsboard_browser_sources'?[]:null;
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    await main();
    assert.equal(calls[0].endpoint,'newsboard_browser_start');assert.equal(calls[0].body.p_github_run_id,123);
    assert.equal(calls.at(-1).endpoint,'newsboard_browser_complete');
    assert.ok(calls.some(c=>c.endpoint==='newsboard_finish_run'));
  }finally{globalThis.fetch=originalFetch;process.env=originalEnv;}
});

test('only database-assigned HTTP fallback is crawled, regardless of previous observation freshness',async()=>{
 const originalFetch=globalThis.fetch,originalEnv={...process.env},original=collectors.abc1;
 const calls=[];let crawled=0;
 Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test'});delete process.env.NEWSBOARD_DISPATCH_ID;
 collectors.abc1=async()=>{crawled++;return {ok:true,item:{title:'Recovered existing browser headline',url:'https://abcnews.com/US/story?id=1'},updatedAt:new Date().toISOString()};};
 globalThis.fetch=async(url,options={})=>{
  const endpoint=String(url).split('/').at(-1);calls.push({endpoint,body:options.body?JSON.parse(options.body):null});
  const result=endpoint==='newsboard_start_run'?'00000000-0000-0000-0000-000000000003':endpoint==='newsboard_browser_sources'?[{source_id:'abc1'}]:null;
  return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
 };
 try{await main();assert.equal(crawled,1);const saved=calls.find(c=>c.endpoint==='newsboard_save_source');assert.equal(saved.body.p.source_id,'abc1');assert.equal(saved.body.p.success,true);assert.ok(!calls.some(c=>c.endpoint.includes('v_crawler_health')));}finally{globalThis.fetch=originalFetch;process.env=originalEnv;collectors.abc1=original;}
});

test('denied responses and 200 interstitials are persisted as blocked without saving stories', async () => {
  const originalFetch=globalThis.fetch, originalEnv={...process.env}, original=collectors.ap1, originalExitCode=process.exitCode;
  const calls=[];
  Object.assign(process.env,{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test'});delete process.env.NEWSBOARD_DISPATCH_ID;
  let status=403;
  collectors.ap1=async()=>({ok:false,error:'AP access interstitial did not clear',meta:{http_status:status,access_blocked:true}});
  globalThis.fetch=async(url,options={})=>{
    const endpoint=String(url).split('/').at(-1);calls.push({endpoint,body:options.body?JSON.parse(options.body):null});
    const result=endpoint==='newsboard_start_run'?'00000000-0000-0000-0000-000000000004':endpoint==='newsboard_browser_sources'?[{source_id:'ap1'}]:null;
    return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    process.exitCode=undefined;
    for (status of [403,200]) {
      calls.length=0;
      await main();
      const saved=calls.find(c=>c.endpoint==='newsboard_save_source').body.p;
      assert.equal(saved.outcome,'blocked');assert.equal(saved.http_status,status);assert.equal(saved.success,false);assert.equal(saved.output,null);
      assert.equal(process.exitCode,undefined);
    }
  } finally { globalThis.fetch=originalFetch;process.env=originalEnv;collectors.ap1=original;process.exitCode=originalExitCode; }
});
