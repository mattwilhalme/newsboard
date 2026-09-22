import {createClient} from '@supabase/supabase-js';
import {createHandler} from './dispatcher.js';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createHandler({db,token:Deno.env.get('NEWSBOARD_GITHUB_DISPATCH_TOKEN')}));
