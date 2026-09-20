import { createClient } from '@supabase/supabase-js';
import { processWindow } from './processor.js';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
Deno.serve(async req=>{
 if(req.method!=='POST')return json({error:'POST required'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=req.headers.get('x-newsboard-token')||'';
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
 const {data:auth,error}=await db.from('crawler_settings').select('token_hash').eq('id',true).single();
 if(error)return json({error:'Authentication unavailable'},503);
 if(!token||hash!==auth.token_hash)return json({error:'Unauthorized'},401);
 try{
  const input=await req.json();
  if((input.start&&!input.end)||(!input.start&&input.end))return json({error:'Backfill requires both start and end'},400);
  const result=await processWindow(db,{start:input.start||null,end:input.end||null,limit:60});
  console.log(JSON.stringify(result));return json(result);
 }catch(e){console.error(e.message);return json({error:e.message},500);}
});
