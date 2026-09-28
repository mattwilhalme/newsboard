import { createClient } from '@supabase/supabase-js';

const {SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:key}=process.env;
if(!url||!key)throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const [command='list',storyId,verdict,...noteParts]=process.argv.slice(2);
const check=({data,error})=>{if(error)throw error;return data;};

if(command==='list'){
 const limit=Math.min(500,Math.max(1,Number(storyId)||100));
 const data=check(await db.rpc('newsboard_story_assignment_diagnostics',{p_limit:limit}));
 console.log(JSON.stringify(data,null,2));
}else if(command==='record'){
 if(!storyId||!verdict)throw new Error('Usage: node scripts/story/audit.mjs record STORY_ID VERDICT [notes]');
 const id=check(await db.rpc('newsboard_story_audit_record',{p_story:storyId,p_verdict:verdict,p_notes:noteParts.join(' ')||null,p_reviewer:process.env.NEWSBOARD_AUDIT_REVIEWER||null}));
 console.log(JSON.stringify({audit_id:id,story_id:storyId,verdict}));
}else throw new Error('Usage: node scripts/story/audit.mjs list [limit] | record STORY_ID VERDICT [notes]');
