import { features, canonicalUrl, matchStory } from './matcher.js';
import { MATCH_CONFIG, scorePair } from './matcher.js';

export const AUTO_MERGE_CONFIG = Object.freeze({ minimumScore: 0.84, limit: 8 });
export const EXACT_DUPLICATE_CLEANUP_LIMIT = 12;

function evidenceHash(pair,evidence){
 const reps=[...new Set([...(pair.representatives_a||[]),...(pair.representatives_b||[])].map(r=>`${r.source_id}|${r.title}|${r.url}|${r.description||''}`))].sort();
 let h=2166136261;for(const ch of `${MATCH_CONFIG.version}|${reps.join('||')}`){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');
}
export async function refreshMatchSuggestions(db,{limit=500}={}){
 const call=async(name,args)=>{const {data,error}=await db.rpc(name,args);if(error)throw new Error(`${name}: ${error.message}`);return data;};
 const pairs=await call('newsboard_story_suggestion_inputs',{p_limit:limit}),rows=[];
 for(const pair of pairs||[]){
  let best=null;
  for(const a of pair.representatives_a||[])for(const b of pair.representatives_b||[]){const scored=scorePair(a,b);if(!best||scored.score>best.score)best={...scored,representative_a:a,representative_b:b};}
  if(!best)continue;
  const target=Date.parse(pair.first_a)<=Date.parse(pair.first_b)?{id:pair.story_a,label:pair.label_a,source:pair.source_a}:{id:pair.story_b,label:pair.label_b,source:pair.source_b};
  const source=target.id===pair.story_a?{id:pair.story_b,label:pair.label_b,source:pair.source_b}:{id:pair.story_a,label:pair.label_a,source:pair.source_a};
  const evidence={...best,matcher_version:MATCH_CONFIG.version,score:best.score,source_story_id:source.id,target_story_id:target.id,source_label:source.label,target_label:target.label,source_publisher:source.source,target_publisher:target.source,newest_at:pair.newest_at};
  rows.push({story_a:pair.story_a,story_b:pair.story_b,matcher_version:MATCH_CONFIG.version,score:best.score,qualifies:Boolean(best.eligible&&best.score>=MATCH_CONFIG.threshold),evidence_hash:evidenceHash(pair,best),evidence});
 }
 return {pairs_scored:rows.length,stored:await call('newsboard_story_store_suggestions',{p_rows:rows})};
}
export async function processWindow(db, { start = null, end = null, limit = 24, budgetMs = 25000 } = {}) {
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
   const manualTargets=await rpc('newsboard_story_manual_targets',{p_source:batch.source_id,p_urls:items.map(i=>i.url)});
   const assignments=[];
   for(const item of items){
    const matched=matchStory(item,candidates),manualId=manualTargets?.[item.url]||null,id=manualId||matched.story_id||crypto.randomUUID();
    const published=item.published_at||item.publishedAt||null;
    const inputEvidence={description:String(item.description||item.deck||item.subheadline||'').slice(0,1000)||null,section:String(item.section||'').slice(0,100)||null,published_at:published||null};
    const baseMatch={...matched.metadata,input_evidence:inputEvidence};
    const match=manualId?{...baseMatch,decision:'manual_override',manual_target_story_id:manualId}:baseMatch;
    assignments.push({...item,story_id:id,published_at:published&&Number.isFinite(Date.parse(published))?new Date(published).toISOString():null,match});
    let story=candidates.find(s=>s.id===id);
    if(!story){story={id,representatives:[]};candidates.push(story);}
    story.representatives.push({title:item.title,description:inputEvidence.description,url:canonicalUrl(item.url),source_id:item.source_id,observed_at:item.observed_at});
   }
   if(await rpc('newsboard_story_commit',{p_run:run,p_batch_key:batch.batch_key,p_assignments:assignments}))processed++;
  }
  const morePossible=batches.length===limit||processed<batches.length;
  // Release the worker lease before optional suggestion maintenance. Batch
  // commits are durable, and an expensive suggestion refresh must never leave
  // an otherwise useful processing run stuck until its lease expires.
  await rpc('newsboard_story_finish',{p_run:run,p_error:null});
  let suggestionsRefreshed=false,autoMergeResult=null,exactDuplicateCleanup=null;
  if(!morePossible&&Date.now()-began<budgetMs){
   const refreshed=await refreshMatchSuggestions(db).catch(error=>{console.warn(`story suggestion refresh: ${error.message}`);return null;});
   suggestionsRefreshed=Boolean(refreshed);
   if(refreshed&&Date.now()-began<budgetMs){
    autoMergeResult=await rpc('newsboard_story_auto_merge_suggestions',{
     p_limit:AUTO_MERGE_CONFIG.limit,p_min_score:AUTO_MERGE_CONFIG.minimumScore,
    }).catch(error=>{console.warn(`story suggestion auto-merge: ${error.message}`);return null;});
   }
  }
  if(!morePossible&&Date.now()-began<budgetMs){
   exactDuplicateCleanup=await rpc('newsboard_story_consolidate_exact_duplicates',{
    p_limit:EXACT_DUPLICATE_CLEANUP_LIMIT,p_recent:7,
   }).catch(error=>{console.warn(`exact story duplicate cleanup: ${error.message}`);return null;});
  }
  return {status:'success',run_id:run,processed,batches_fetched:batches.length,more_possible:morePossible,suggestions_refreshed:suggestionsRefreshed,auto_merge:autoMergeResult,exact_duplicate_cleanup:exactDuplicateCleanup};
 }catch(error){await rpc('newsboard_story_finish',{p_run:run,p_error:error.message}).catch(()=>{});throw error;}
}
