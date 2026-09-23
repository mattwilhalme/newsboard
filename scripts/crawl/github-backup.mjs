// Manual browser fallback. Uses the existing publisher implementations unchanged.
import {createClient} from '@supabase/supabase-js';
import * as scrapers from '../../server.js';
import {collectPublisher,publishers} from '../../supabase/functions/newsboard-crawl/collectors.js';
import {createHash} from 'node:crypto';
const {SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:key}=process.env;
if(!url||!key) throw new Error('Server-side Supabase credentials are required');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const check=({data,error})=>{if(error)throw error;return data;};
const id=check(await db.rpc('newsboard_start_run',{p_trigger:'github_backup'}));
if(!id) throw new Error('Another crawl is running; retry after it finishes');
const collectors={abc1:()=>collectPublisher(publishers.find(p=>p.id==='abc1')),cbs1:()=>collectPublisher(publishers.find(p=>p.id==='cbs1')),usat1:scrapers.scrapeUSATHero,nbc1:scrapers.scrapeNBCHero,cnn1:scrapers.scrapeCNNHero,guardian1:scrapers.scrapeGuardianHero,ap1:scrapers.scrapeAPHero,latimes1:scrapers.scrapeLATimesHero,npr1:scrapers.scrapeNPRHero,bbc1:scrapers.scrapeBBCHero,fox1:scrapers.scrapeFoxHero,yahoo1:scrapers.scrapeWPHero};
let fatal=null,succeeded=0;
try{
 for(const [source_id,collect] of Object.entries(collectors)){
  const started_at=new Date().toISOString();let output=null,error=null;
  try{
   const result=await collect();
   if(result.ok===false||!result.item?.url||!result.item?.title) throw new Error(result.error||'No usable CP');
   const item=result.item;
   output={source_id,observed_at:result.observed_at||result.updatedAt||new Date().toISOString(),item,items:[{...item,rank:1,slot_key:'hero:1',fingerprint:createHash('sha1').update(`${item.url}|${item.title}`).digest('hex')}],http_status:result.meta?.http_status||null};
   if(result.top10)Object.assign(output,{top10:result.top10,top10_quality:result.top10_quality,top10_diagnostics:result.top10_diagnostics});
  }catch(e){error=e.message;}
  const {error:saveError}=await db.rpc('newsboard_save_source',{p:{run_id:id,source_id,started_at,completed_at:new Date().toISOString(),method:['abc1','cbs1'].includes(source_id)?'http':'browser',success:!error,error,output}});
  if(saveError) throw new Error(`Persistence failed for ${source_id}: ${saveError.message}`);
  if(!error)succeeded++;
  console.log(`${source_id}: ${error?'FAILED — '+error:'SUCCESS'}`);
 }
}catch(e){fatal=e.message;}
check(await db.rpc('newsboard_finish_run',{p_run:id,p_error:fatal}));
console.log(JSON.stringify({run_id:id,trigger:'github_backup',succeeded,error:fatal}));
if(fatal||!succeeded)process.exitCode=1;
