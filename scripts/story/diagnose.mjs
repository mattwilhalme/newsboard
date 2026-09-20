import {createClient} from '@supabase/supabase-js';
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const {data,error}=await db.from('story_members').select('story_id,source_id,first_headline,latest_headline,first_seen_at,match_metadata').order('first_seen_at',{ascending:false}).limit(100);if(error)throw error;
for(const m of data)console.log(JSON.stringify(m,null,2));
// Each first membership includes its top three rejected/ambiguous candidate scores.
// For later decisions: query story_assignments.metadata (service role only).
