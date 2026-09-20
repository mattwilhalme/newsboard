// Versioned, dependency-free matching. Never infers publication time.
export const MATCH_CONFIG = Object.freeze({ version: 'deterministic-v1', threshold: 0.75, ambiguityMargin: 0.08, candidateHours: 48, phraseBonus: 0.15,
  weights: { headline: 0.40, terms: 0.35, entities: 0.12, url: 0.08, temporal: 0.05 } });
const STOP = new Set('a an the and or but of to in on at by for from with as is are was were be been being it its this that these those his her their they he she we you your our has have had will would could can may might says said say new latest live updates update breaking news watch video photos what know about after before over under into amid also than how why who when where which some more most now just here there very report reported reports according powerful major severe'.split(' '));
const ALIASES = { quake:'earthquake', quakes:'earthquake', earthquakes:'earthquake', hits:'strike', hit:'strike', strikes:'strike', struck:'strike', storms:'storm', leaves:'leave', remains:'remain', tariffs:'tariff', cuts:'cut', cutting:'cut', hikes:'hike', raises:'hike', increases:'hike', drones:'drone', launches:'launch', missiles:'missile', snipers:'sniper', bans:'ban', reporters:'reporter', announces:'announce', announced:'announce' };
export function normalizeHeadline(value) {
 return String(value||'').normalize('NFKC').toLowerCase().replace(/^(?:(?:live(?: updates)?|breaking(?: news)?|updates?)\s*[:|–—-]\s*)+/i,'')
 .replace(/\s+[|–—]\s+(?:ap news|associated press|abc news|nbc news|cbs news|cnn|bbc news|usa today|yahoo news|the guardian)$/i,'')
 .replace(/[’']/g,'').replace(/[^\p{L}\p{N}.]+/gu,' ').replace(/\.(?!\d)/g,' ').replace(/\s+/g,' ').trim();
}
export function significantTerms(value) {
 return [...new Set(normalizeHeadline(value).split(' ').filter(t=>t.length>1&&!STOP.has(t)&&!/^\d+$/.test(t)).map(t=>ALIASES[t]||t))];
}
export function canonicalUrl(value) {
 try { const u=new URL(value);if(!/^https?:$/.test(u.protocol))return '';u.hostname=u.hostname.replace(/^www\./,'');u.hash='';
  for(const k of [...u.searchParams.keys()]) if(/^(utm_|fbclid|gclid|cmp|cid|ref|ocid)/i.test(k))u.searchParams.delete(k);
  u.searchParams.sort();u.pathname=u.pathname.replace(/\/+$/,'')||'/';return u.href;
 }catch{return '';}
}
export function features(item) {
 const title=String(item.title||'');const terms=significantTerms(title);
 const entities=[...new Set([...title.matchAll(/\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*/g)].filter(m=>m.index>0||m[0].includes(' ')||!new Set(['storm','thousands','earthquake','powerful','major','severe','largest','first','second','live','breaking']).has(m[0].toLowerCase())).flatMap(m=>significantTerms(m[0])).filter(t=>terms.includes(t)))];
 let slug='';try{slug=decodeURIComponent(new URL(item.url).pathname).replace(/\b(?:story|articles?|news|politics|world|international|business|wirestory|live|updates|html|com)\b/gi,' ');}catch{}
 return { normalized:normalizeHeadline(title), terms, entities, url:canonicalUrl(item.url), urlTerms:significantTerms(slug).filter(t=>!/[0-9]/.test(t)) };
}
const overlap=(a,b)=>a.filter(t=>b.includes(t));
const dice=(a,b)=>a.length+b.length ? 2*overlap(a,b).length/(a.length+b.length):0;
const contain=(a,b)=>Math.min(a.length,b.length)?overlap(a,b).length/Math.min(a.length,b.length):0;
export function scorePair(candidate, representative) {
 const a=features(candidate),b=features(representative);
 const hours=Math.abs(Date.parse(candidate.observed_at)-Date.parse(representative.observed_at))/3600000;
 const shared=overlap(a.terms,b.terms);
 const headline_similarity=dice(a.terms,b.terms), term_overlap=contain(a.terms,b.terms),entity_overlap=contain(a.entities,b.entities),url_overlap=dice(a.urlTerms,b.urlTerms);
 const temporal_proximity=Number.isFinite(hours)?Math.max(0,1-hours/MATCH_CONFIG.candidateHours):0;
 const pairs = ts => ts.slice(1).map((t,i)=>ts[i]+' '+t);
 const shared_phrases = overlap(pairs(a.terms), pairs(b.terms));
 const phrase_corroboration = shared.length>=4 && shared_phrases.length>0 && overlap(a.urlTerms,b.urlTerms).length>=3;
 let reason='below_threshold';
 const sameUrl=a.url&&a.url===b.url&&candidate.source_id===representative.source_id;
 const conflict=[['cut','hike'],['win','lose'],['approves','rejects']].some(([x,y])=>(a.terms.includes(x)&&b.terms.includes(y))||(a.terms.includes(y)&&b.terms.includes(x)));
 const entityOnly=shared.length>0&&shared.every(t=>a.entities.includes(t)&&b.entities.includes(t));
 // One shared person/topic is never sufficient. URL continuity is publisher-local
 // and still requires title evidence, avoiding ever-changing live-blog reuse.
 const continuity=sameUrl&&!conflict&&shared.length>=2&&term_overlap>=0.5;
 const gated=!conflict&&shared.length>=3&&!entityOnly&&headline_similarity>=0.45;
 const w=MATCH_CONFIG.weights;
 let score=w.headline*headline_similarity+w.terms*term_overlap+w.entities*entity_overlap+w.url*url_overlap+w.temporal*temporal_proximity;
 if(phrase_corroboration)score=Math.min(1,score+MATCH_CONFIG.phraseBonus);
 if(continuity){score=Math.max(score,0.98);reason='same_publisher_url_and_title';}
 else if(!gated){reason=conflict?'conflicting_action':'insufficient_event_evidence';score=Math.min(score,0.49);}
 else if(score>=MATCH_CONFIG.threshold)reason='high_confidence';
 return {score:Number(score.toFixed(4)),headline_similarity,term_overlap,entity_overlap,url_overlap,temporal_proximity,shared_terms:shared,shared_phrases,phrase_corroboration,reason,eligible:(gated||continuity)&&hours<=MATCH_CONFIG.candidateHours};
}
export function matchStory(item, stories) {
 const candidates=stories.map(story=>{
  const ranked=(story.representatives||[]).map(rep=>({...scorePair(item,rep),representative:{title:rep.title,source_id:rep.source_id,url:rep.url}})).sort((a,b)=>b.score-a.score);
  return {candidate_story_id:story.id,...ranked[0]};
 }).filter(x=>Number.isFinite(x.score)).sort((a,b)=>b.score-a.score||a.candidate_story_id.localeCompare(b.candidate_story_id));
 const best=candidates[0],second=candidates[1];
 const ambiguous=best&&second&&second.eligible&&best.score-second.score<MATCH_CONFIG.ambiguityMargin;
 const accepted=best?.eligible&&best.score>=MATCH_CONFIG.threshold&&!ambiguous;
 return {story_id:accepted?best.candidate_story_id:null,metadata:{version:MATCH_CONFIG.version,decision:accepted?'matched':ambiguous?'ambiguous':'new_story',threshold:MATCH_CONFIG.threshold,...(best||{}),candidates:candidates.slice(0,3)}};
}
