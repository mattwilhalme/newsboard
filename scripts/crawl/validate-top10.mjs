import fs from 'node:fs';
import * as scrapers from '../../server.js';
import {collectPublisher,publishers} from '../../supabase/functions/newsboard-crawl/collectors.js';
const collectors={abc1:()=>collectPublisher(publishers.find(p=>p.id==='abc1'),{onDocument:html=>fs.writeFileSync('archive/top10-abc1.html',html)}),cbs1:()=>collectPublisher(publishers.find(p=>p.id==='cbs1'),{onDocument:html=>fs.writeFileSync('archive/top10-cbs1.html',html)}),ap1:scrapers.scrapeAPHero,usat1:scrapers.scrapeUSATHero,nbc1:scrapers.scrapeNBCHero,yahoo1:scrapers.scrapeWPHero,guardian1:scrapers.scrapeGuardianHero,cnn1:scrapers.scrapeCNNHero};
process.env.NEWSBOARD_TOP10_SCREENSHOTS='1';
const results=[];
for(const [source_id,collect] of Object.entries(collectors)) {
 if(process.argv[2]&&process.argv[2]!==source_id)continue;
 const started=Date.now();
 try{
 const r=await collect();const result={source_id,duration_ms:Date.now()-started,...r};results.push(result);
 fs.writeFileSync(`archive/top10-validation-${source_id}.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify({source_id,cp:r.item,quality:r.top10_quality,items:r.top10?.length,agreement:r.top10_diagnostics?.centerpiece_agreement,duration_ms:result.duration_ms,error:r.error}));
 }catch(e){results.push({source_id,error:e.message});console.log(source_id,e.message);}
}
fs.writeFileSync('archive/top10-validation.json',JSON.stringify(results,null,2));
