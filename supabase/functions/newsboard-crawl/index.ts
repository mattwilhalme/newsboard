import {createClient} from '@supabase/supabase-js';
import {publishers,collectPublisher} from './collectors.js';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
Deno.serve(async req=>{
 if(req.method!=='POST') return json({error:'POST required'},405);
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 const token=req.headers.get('x-newsboard-token')||'';
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(b=>b.toString(16).padStart(2,'0')).join('');
 const {data:auth,error:authError}=await db.from('crawler_settings').select('token_hash').eq('id',true).single();
 if(authError) return json({error:'Authentication unavailable'},503);
 if(!token || hash!==auth.token_hash) return json({error:'Unauthorized'},401);
 let input;
 try{input=await req.json();}catch{return json({error:'Invalid JSON'},400);}
 const trigger=input.trigger==='supabase_cron'?'supabase_cron':'manual_edge_function';
 const {data:run,error:startError}=await db.rpc('newsboard_start_run',{p_trigger:trigger});
 if(startError) return json({error:'Run persistence failed',detail:startError.message},500);
 if(!run) return json({status:'already_running'},409);
 const summary=[];
 try{
  const {data:config,error}=await db.from('crawler_publishers').select('*').order('source_id');
  if(error) throw error;
  // Bounded concurrency keeps memory/CPU below Edge limits.
  for(let offset=0;offset<config.length;offset+=2){
   await Promise.all(config.slice(offset,offset+2).map(async cfg=>{
    const started=new Date().toISOString();
    let output=null, failure=null;
    try{
     if(cfg.method!=='http') throw new Error(cfg.reason||'Browser collector required');
     const publisher=publishers.find(p=>p.id===cfg.source_id);
     if(!publisher) throw new Error('No configured HTTP adapter');
     output=await collectPublisher(publisher);
    }catch(e){failure=e;}
    const payload={run_id:run,source_id:cfg.source_id,started_at:started,completed_at:new Date().toISOString(),method:cfg.method,success:!failure,error:failure?.message||null,http_status:output?.http_status||failure?.httpStatus||null,output};
    const {error:saveError}=await db.rpc('newsboard_save_source',{p:payload});
    if(saveError){
     const {error:recordError}=await db.from('crawler_source_runs').upsert({run_id:run,source_id:cfg.source_id,started_at:started,completed_at:new Date().toISOString(),collection_method:cfg.method,success:false,item_count:0,duration_ms:Date.now()-Date.parse(started),error:`persistence: ${saveError.message}`});
     if(recordError) throw new Error(`Publisher and failure persistence failed: ${cfg.source_id}`);
    }
    summary.push({publisher:cfg.source_id,success:!failure&&!saveError,items:output?.items.length||0,error:saveError?.message||failure?.message||null});
   }));
  }
  const {error:finishError}=await db.rpc('newsboard_finish_run',{p_run:run,p_error:null});
  if(finishError) throw finishError;
  console.log(JSON.stringify({run_id:run,trigger,summary}));
  return json({run_id:run,summary});
 }catch(e){
  await db.rpc('newsboard_finish_run',{p_run:run,p_error:e.message});
  console.error(JSON.stringify({run_id:run,error:e.message}));
  return json({run_id:run,error:e.message},500);
 }
});
