import { createClient } from '@supabase/supabase-js';
import { fetchFeed } from '../_shared/feed-discovery.js';
import { FEEDS } from './feeds.js';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
Deno.serve(async req=>{
 if(req.method!=='POST')return json({error:'POST required'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=req.headers.get('x-newsboard-token')||'';
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
 const {data:auth,error}=await db.from('crawler_settings').select('token_hash').eq('id',true).single();
 if(error)return json({error:'Authentication unavailable'},503); if(!token||hash!==auth.token_hash)return json({error:'Unauthorized'},401);
 const {data:states}=await db.from('feed_sources').select('id,etag,last_modified');
 const byId=Object.fromEntries((states||[]).map((x:any)=>[x.id,x])); const results:any[]=[];
 for(let offset=0;offset<FEEDS.length;offset+=3) await Promise.all(FEEDS.slice(offset,offset+3).map(async feed=>{
   const started=new Date().toISOString();
   try { const result=await fetchFeed(feed,byId[feed.id]); const {error:save}=await db.rpc('newsboard_save_feed_poll',{p_feed_id:feed.id,p_started_at:started,p_status:result.status,p_etag:result.etag,p_last_modified:result.lastModified,p_items:result.items}); if(save)throw save; results.push({feed:feed.id,status:result.status,items:result.items.length}); }
   catch(e){await db.rpc('newsboard_save_feed_failure',{p_feed_id:feed.id,p_started_at:started,p_error:String(e.message||e),p_http_status:e.httpStatus||null});results.push({feed:feed.id,error:String(e.message||e)});}
 }));
 return json({results});
});
