import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchTick,createHandler,DISPATCH_URL} from '../../supabase/functions/newsboard-browser-dispatch/dispatcher.js';
function fixture(decision='dispatch') {
 const calls=[];let claimed=false;
 return {calls,rpc:async(name,args)=>{
  calls.push({name,args});
  if(name==='newsboard_browser_mark_sent')return true;
  if(name==='newsboard_browser_claim'){
   if(claimed)return {decision:'dispatch_active'};
   claimed=true;return {decision,attempt_id:'00000000-0000-0000-0000-000000000001'};
  }
 }};
}
test('overlapping ticks dispatch at most once after atomic claim',async()=>{
 const f=fixture();let fetches=0;
 const run=()=>dispatchTick({...f,token:'private',fetchImpl:async(url,opts)=>{
  fetches++;assert.equal(url,DISPATCH_URL);assert.deepEqual(JSON.parse(opts.body),{ref:'main',inputs:{dispatch_id:'00000000-0000-0000-0000-000000000001'}});
  return new Response(null,{status:204});
 }});
 const results=await Promise.all([run(),run(),run()]);assert.equal(fetches,1);assert.equal(results[0].outcome,'accepted');
});
for(const decision of ['fresh','crawler_active','dispatch_active','backoff','disabled','missing_credential'])test(`${decision}: no GitHub request`,async()=>{
 const f=fixture(decision);let fetched=false;
 await dispatchTick({...f,token:decision==='missing_credential'?null:'private',fetchImpl:()=>{fetched=true;}});
 assert.equal(fetched,false);
 if(decision==='missing_credential')assert.equal(f.calls[0].args.p_has_credential,false);
});
for(const status of [200,204,401,403,422,429,500])test(`GitHub HTTP ${status} is recorded without claiming crawl success`,async()=>{
 const f=fixture();const result=await dispatchTick({...f,token:'private',fetchImpl:async()=>new Response(status===204?null:JSON.stringify({workflow_run_id:123,message:'must not store raw response'}),{status,headers:{'x-github-request-id':'request-id','retry-after':'600'}})});
 assert.equal(result.outcome,[200,204].includes(status)?'accepted':'rejected');
 const saved=f.calls.at(-1).args;assert.equal(saved.p_status,status);assert.equal(saved.p_retry_seconds,600);assert.ok(!JSON.stringify(saved).includes('must not store'));
 assert.equal(saved.p_run_id,status===200?123:null);
});
test('transport uncertainty holds dispatch lease instead of retrying',async()=>{
 const f=fixture();const result=await dispatchTick({...f,token:'private',fetchImpl:async()=>{throw Error('token must never be logged');}});
 assert.equal(result.outcome,'uncertain');assert.equal(f.calls.at(-1).args.p_status,null);
});
test('unauthenticated requests cannot claim or dispatch',async()=>{
 const handler=createHandler({db:{from:()=>{throw Error('Must not access DB');}},token:'private'});
 assert.equal((await handler(new Request('https://example',{method:'POST'}))).status,401);
 assert.equal((await handler(new Request('https://example'))).status,405);
});
test('wrong authentication token is rejected',async()=>{
 const db={from:()=>({select:()=>({eq:()=>({single:async()=>({data:{token_hash:'wrong'}})})})})};
 const result=await createHandler({db,token:'private'})(new Request('https://example',{method:'POST',headers:{'x-newsboard-token':'invalid'}}));
 assert.equal(result.status,401);
});
