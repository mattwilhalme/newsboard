import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeHeadline,canonicalUrl,matchStory,scorePair} from '../../supabase/functions/story-intelligence/matcher.js';
const at='2026-09-20T15:00:00Z';
function match(a,b){return matchStory({title:a,url:'https://a.test/story/a',source_id:'a',observed_at:at},[{id:'story',representatives:[{title:b,url:'https://b.test/story/b',source_id:'b',observed_at:at}]}]);}
for(const [a,b,expected] of [
 ['Powerful earthquake strikes Northern California','7.1 earthquake hits Northern California coast',true],
 ['Trump announces new China tariffs','Trump discusses border security',false],
 ['Storm leaves thousands without power in Texas','Thousands remain without power after severe Texas storms',true],
 ['Fed cuts interest rates','Powell discusses inflation outlook',false],
 ['Trump discusses tariffs on China','Trump discusses immigration policy',false],
 ['Warriors defeat Lakers','Warriors trade player',false],
 ['Fed cuts interest rates amid inflation fears','Fed hikes interest rates amid inflation fears',false],
 ["Trump says proposed arch will also be a top grade Military Complex","Trump says triumphal arch will also serve as military complex with snipers",false],
 ['North Korea launches 2 missiles within hours of each other as tensions rise','North Korea launches two missiles as tensions rise',true],
])test(`${expected?'match':'reject'}: ${a}`,()=>assert.equal(Boolean(match(a,b).story_id),expected,JSON.stringify(match(a,b))));
test('normalization strips formatting but preserves semantic terms',()=>{assert.equal(normalizeHeadline('LIVE UPDATES:  Storm hits Texas — NBC News'),'storm hits texas');assert.notEqual(normalizeHeadline('Trump supports tariffs'),normalizeHeadline('Trump opposes tariffs'));});
test('URL identity preserves article ID parameters',()=>{assert.equal(canonicalUrl('https://www.abcnews.com/US/story/?id=12&utm_source=x#x'),'https://abcnews.com/US/story?id=12');});
test('ambiguous stories stay separate',()=>{const rep={title:'Powerful earthquake strikes Northern California',url:'https://b.test/a',source_id:'b',observed_at:at};const result=matchStory({...rep,source_id:'a'},[{id:'one',representatives:[rep]},{id:'two',representatives:[rep]}]);assert.equal(result.story_id,null);assert.equal(result.metadata.decision,'ambiguous');});
test('compares multiple representatives, not only a canonical label',()=>{const result=matchStory({title:'Storm leaves thousands without power in Texas',observed_at:at,source_id:'a'},[{id:'one',representatives:[{title:'Texas governor speaks at press conference',observed_at:at},{title:'Thousands remain without power after severe Texas storms',observed_at:at}]}]);assert.equal(result.story_id,'one');});
test('shared entities alone and old stories cannot establish identity',()=>{assert.equal(match('Trump China','Trump China').story_id,null);assert.equal(scorePair({title:'Storm leaves thousands without power in Texas',observed_at:at},{title:'Storm leaves thousands without power in Texas',observed_at:'2026-09-10T00:00:00Z'}).eligible,false);});
test('same publisher URL still rejects unrelated rolling-blog topic',()=>{const r=scorePair({source_id:'a',title:'Trump announces China tariffs',url:'https://a.test/live',observed_at:at},{source_id:'a',title:'Warriors trade star player',url:'https://a.test/live',observed_at:at});assert.equal(r.eligible,false);});
test('short quake rewrite matches with three event/location/action terms',()=>assert.ok(match('Powerful quake hits California coast','7.1 earthquake hits Northern California coast').story_id));
test('real CBS and USA Today match when URL slugs corroborate distinctive phrase',()=>{
 const a={source_id:'cbs1',observed_at:at,title:'Trump says proposed arch will also be a top grade Military Complex',url:'https://cbsnews.com/news/trump-triumphal-arch-arlington-top-grade-military-complex'};
 const b={source_id:'usat1',observed_at:at,title:'Trump says triumphal arch will also serve as military complex with snipers',url:'https://usatoday.com/story/news/politics/2026/09/20/donald-trump-arch-military-complex/91859453007'};
 const score=scorePair(a,b);assert.ok(score.score>=.75);assert.equal(score.phrase_corroboration,true);
});
