import { features, canonicalUrl, matchStory } from './matcher.js';
export async function processWindow(db, { start = null, end = null, limit = 60, budgetMs = 45000 } = {}) {
 const rpc=async(name,args)=>{const {data,error}=await db.rpc(name,args);if(error)throw new Error(`${name}: ${error.message}`);return data;};
 const run=await rpc('newsboard_story_begin',{p_start:start,p_end:end});
 if(!run)return {status:'busy',processed:0};
 const began=Date.now();let processed=0;
 try {
  const batches=await rpc('newsboard_story_inputs',{p_run:run,p_limit:limit});
  for(const batch of batches){
   if(Date.now()-began>budgetMs)break;
   const items=batch.items.map(item=>{
    const f=features(item),rank=Number(item.rank);
    if(!item.title?.trim()||!f.url||!Number.isInteger(rank)||rank<1||rank>10)throw new Error(`Invalid raw item in ${batch.batch_key}`);
    return {...item,url:f.url,normalized:f.normalized,terms:f.terms,source_id:batch.source_id,observed_at:batch.observed_at,rank};
   });
   const terms=[...new Set(items.flatMap(i=>i.terms))];
   const candidates=await rpc('newsboard_story_candidates',{p_terms:terms,p_at:batch.observed_at,p_source:batch.source_id,p_urls:items.map(i=>i.url)});
   const assignments=[];
   for(const item of items){
    const matched=matchStory(item,candidates),id=matched.story_id||crypto.randomUUID();
    const published=item.published_at||item.publishedAt||null;
    assignments.push({...item,story_id:id,published_at:published&&Number.isFinite(Date.parse(published))?new Date(published).toISOString():null,match:matched.metadata});
    let story=candidates.find(s=>s.id===id);
    if(!story){story={id,representatives:[]};candidates.push(story);}
    story.representatives.push({title:item.title,url:canonicalUrl(item.url),source_id:item.source_id,observed_at:item.observed_at});
   }
   if(await rpc('newsboard_story_commit',{p_run:run,p_batch_key:batch.batch_key,p_assignments:assignments}))processed++;
  }
  await rpc('newsboard_story_finish',{p_run:run,p_error:null});
  return {status:'success',run_id:run,processed,batches_fetched:batches.length,more_possible:batches.length===limit||processed<batches.length};
 }catch(error){await rpc('newsboard_story_finish',{p_run:run,p_error:error.message}).catch(()=>{});throw error;}
}
