import assert from 'node:assert/strict';
import test from 'node:test';
import { processWindow } from '../../supabase/functions/story-intelligence/processor.js';

test('manual article target overrides the matcher before commit', async () => {
  const target='00000000-0000-0000-0000-000000000123';
  let committed=null;
  const db={rpc:async(name,args)=>{
    if(name==='newsboard_story_begin')return {data:'00000000-0000-0000-0000-000000000001',error:null};
    if(name==='newsboard_story_inputs')return {data:[{batch_key:'snapshot:test',source_id:'abc1',observed_at:'2026-09-29T12:00:00Z',items:[{rank:1,title:'Manual identity article',url:'https://abcnews.com/story?id=1'}]}],error:null};
    if(name==='newsboard_story_candidates')return {data:[],error:null};
    if(name==='newsboard_story_manual_targets')return {data:{'https://abcnews.com/story?id=1':target},error:null};
    if(name==='newsboard_story_commit'){committed=args.p_assignments;return {data:true,error:null};}
    if(name==='newsboard_story_finish')return {data:null,error:null};
    throw new Error(`Unexpected RPC ${name}`);
  }};
  const result=await processWindow(db);
  assert.equal(result.status,'success');
  assert.equal(committed[0].story_id,target);
  assert.equal(committed[0].match.decision,'manual_override');
});
