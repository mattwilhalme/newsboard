import test from 'node:test';
import assert from 'node:assert/strict';
import { collectors, shouldCollect, main } from './github-browser-gap-fill.mjs';

test('only the configured browser-dependent sources are registered', () => {
  assert.deepEqual(Object.keys(collectors), ['ap1', 'cnn1', 'nbc1', 'guardian1', 'usat1', 'yahoo1']);
  assert.ok(Object.values(collectors).every(collect => typeof collect === 'function'));
});

test('freshness boundary and failed attempts determine collection', () => {
  const fresh = { last_success_at: '2026-09-19T20:00:00Z', age_seconds: 419, last_attempt_success: true };
  assert.equal(shouldCollect(fresh), false);
  assert.equal(shouldCollect({ ...fresh, age_seconds: 420 }), true);
  assert.equal(shouldCollect({ ...fresh, last_attempt_success: false }), true);
  assert.equal(shouldCollect({ ...fresh, last_success_at: null }), true);
  assert.equal(shouldCollect(undefined), true);
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
    const body=endpoint==='newsboard_browser_start'?'00000000-0000-0000-0000-000000000002':endpoint==='v_crawler_health'?Object.keys(collectors).map(source_id=>({source_id,last_success_at:'2026-09-22T20:00:00Z',age_seconds:0,last_attempt_success:true})):null;
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    await main();
    assert.equal(calls[0].endpoint,'newsboard_browser_start');assert.equal(calls[0].body.p_github_run_id,123);
    assert.equal(calls.at(-1).endpoint,'newsboard_browser_complete');
    assert.ok(calls.some(c=>c.endpoint==='newsboard_finish_run'));
  }finally{globalThis.fetch=originalFetch;process.env=originalEnv;}
});
