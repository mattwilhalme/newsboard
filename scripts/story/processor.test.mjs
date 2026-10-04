import assert from 'node:assert/strict';
import test from 'node:test';
import { processWindow } from '../../supabase/functions/story-intelligence/processor.js';

test('manual article target overrides the matcher before commit', async () => {
  const target='00000000-0000-0000-0000-000000000123';
  let committed=null;const calls=[];
  const db={rpc:async(name,args)=>{
    calls.push(name);
    if(name==='newsboard_story_begin')return {data:'00000000-0000-0000-0000-000000000001',error:null};
    if(name==='newsboard_story_inputs')return {data:[{batch_key:'snapshot:test',source_id:'abc1',observed_at:'2026-09-29T12:00:00Z',items:[{rank:1,title:'Manual identity article',url:'https://abcnews.com/story?id=1'}]}],error:null};
    if(name==='newsboard_story_candidates')return {data:[],error:null};
    if(name==='newsboard_story_manual_targets')return {data:{'https://abcnews.com/story?id=1':target},error:null};
    if(name==='newsboard_story_suggestion_inputs')return {data:[],error:null};
    if(name==='newsboard_story_store_suggestions')return {data:0,error:null};
    if(name==='newsboard_story_auto_merge_suggestions')return {data:{merged:0,failed:0},error:null};
    if(name==='newsboard_story_commit'){committed=args.p_assignments;return {data:true,error:null};}
    if(name==='newsboard_story_finish')return {data:null,error:null};
    throw new Error(`Unexpected RPC ${name}`);
  }};
  const result=await processWindow(db);
  assert.equal(result.status,'success');
  assert.equal(committed[0].story_id,target);
  assert.equal(committed[0].match.decision,'manual_override');
  assert.ok(calls.indexOf('newsboard_story_finish')<calls.indexOf('newsboard_story_suggestion_inputs'));
  assert.ok(calls.indexOf('newsboard_story_store_suggestions')<calls.indexOf('newsboard_story_auto_merge_suggestions'));
});

test('high-confidence suggestion maintenance applies bounded automatic merges', async () => {
  const calls=[];
  const db={rpc:async(name,args)=>{
    calls.push([name,args]);
    if(name==='newsboard_story_begin')return {data:'00000000-0000-0000-0000-000000000001',error:null};
    if(name==='newsboard_story_inputs')return {data:[],error:null};
    if(name==='newsboard_story_finish')return {data:null,error:null};
    if(name==='newsboard_story_suggestion_inputs')return {data:[],error:null};
    if(name==='newsboard_story_store_suggestions')return {data:0,error:null};
    if(name==='newsboard_story_auto_merge_suggestions')return {data:{merged:2,failed:0,minimum_score:args.p_min_score},error:null};
    throw new Error(`Unexpected RPC ${name}`);
  }};
  const result=await processWindow(db);
  assert.deepEqual(result.auto_merge,{merged:2,failed:0,minimum_score:0.84});
  const autoCall=calls.find(([name])=>name==='newsboard_story_auto_merge_suggestions');
  assert.deepEqual(autoCall[1],{p_limit:8,p_min_score:0.84});
});

test('backlog runs finish cleanly before skipping suggestion maintenance', async () => {
  const calls=[];
  const batches=[1,2].map(rank=>({batch_key:`snapshot:${rank}`,source_id:'abc1',observed_at:'2026-09-29T12:00:00Z',items:[{rank:1,title:`Backlog article number ${rank}`,url:`https://abcnews.com/story?id=${rank}`}]}));
  const db={rpc:async(name,args)=>{
    calls.push(name);
    if(name==='newsboard_story_begin')return {data:'00000000-0000-0000-0000-000000000001',error:null};
    if(name==='newsboard_story_inputs')return {data:batches,error:null};
    if(name==='newsboard_story_candidates')return {data:[],error:null};
    if(name==='newsboard_story_manual_targets')return {data:{},error:null};
    if(name==='newsboard_story_commit')return {data:true,error:null};
    if(name==='newsboard_story_finish')return {data:null,error:null};
    throw new Error(`Unexpected RPC ${name}`);
  }};
  const result=await processWindow(db,{limit:2,budgetMs:25000});
  assert.equal(result.status,'success');
  assert.equal(result.processed,2);
  assert.equal(result.more_possible,true);
  assert.equal(result.suggestions_refreshed,false);
  assert.equal(calls.filter(name=>name==='newsboard_story_finish').length,1);
  assert.equal(calls.includes('newsboard_story_suggestion_inputs'),false);
});
