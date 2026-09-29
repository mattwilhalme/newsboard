import { createClient } from '@supabase/supabase-js';

const {SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:key}=process.env;
if(!url||!key)throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const [command='list',...args]=process.argv.slice(2);
const check=({data,error})=>{if(error)throw error;return data;};
const reviewer=process.env.NEWSBOARD_AUDIT_REVIEWER||null;

if(command==='list'){
 const limit=Math.min(500,Math.max(1,Number(args[0])||100));
 const data=check(await db.rpc('newsboard_story_assignment_diagnostics',{p_limit:limit}));
 console.log(JSON.stringify(data,null,2));
}else if(command==='record'){
 const [storyId,verdict,...noteParts]=args;
 if(!storyId||!verdict)throw new Error('Usage: node scripts/story/audit.mjs record STORY_ID VERDICT [notes]');
 const id=check(await db.rpc('newsboard_story_audit_record',{p_story:storyId,p_verdict:verdict,p_notes:noteParts.join(' ')||null,p_reviewer:reviewer}));
 console.log(JSON.stringify({audit_id:id,story_id:storyId,verdict}));
}else if(command==='show'){
 const [storyId]=args;if(!storyId)throw new Error('Usage: node scripts/story/audit.mjs show STORY_ID');
 console.log(JSON.stringify(check(await db.rpc('newsboard_story_history',{p_story:storyId})),null,2));
}else if(command==='corrections'){
 const limit=Math.min(500,Math.max(1,Number(args[0])||100));
 console.log(JSON.stringify(check(await db.rpc('newsboard_story_corrections',{p_limit:limit})),null,2));
}else if(command==='reassign'){
 const [batchKey,rank,targetStoryId,...noteParts]=args;
 if(!batchKey||!rank||!targetStoryId)throw new Error('Usage: node scripts/story/audit.mjs reassign BATCH_KEY RANK TARGET_STORY_ID [notes]');
 const result=check(await db.rpc('newsboard_story_correct_article',{p_batch_key:batchKey,p_rank:Number(rank),p_target_story:targetStoryId,p_new_label:null,p_notes:noteParts.join(' ')||null,p_reviewer:reviewer}));
 console.log(JSON.stringify(result,null,2));
}else if(command==='create'){
 const [batchKey,rank,newLabel,...noteParts]=args;
 if(!batchKey||!rank||!newLabel)throw new Error('Usage: node scripts/story/audit.mjs create BATCH_KEY RANK "NEW IDENTITY LABEL" [notes]');
 const result=check(await db.rpc('newsboard_story_correct_article',{p_batch_key:batchKey,p_rank:Number(rank),p_target_story:null,p_new_label:newLabel,p_notes:noteParts.join(' ')||null,p_reviewer:reviewer}));
 console.log(JSON.stringify(result,null,2));
}else throw new Error('Usage: node scripts/story/audit.mjs list [limit] | show STORY_ID | corrections [limit] | record STORY_ID VERDICT [notes] | reassign BATCH_KEY RANK TARGET_STORY_ID [notes] | create BATCH_KEY RANK "NEW IDENTITY LABEL" [notes]');
