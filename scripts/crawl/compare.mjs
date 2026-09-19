import fs from 'node:fs';
import * as old from '../../server.js';
const browser = {abc1:old.scrapeABCHero,cbs1:old.scrapeCBSHero,usat1:old.scrapeUSATHero,nbc1:old.scrapeNBCHero,cnn1:old.scrapeCNNHero,guardian1:old.scrapeGuardianHero,ap1:old.scrapeAPHero,latimes1:old.scrapeLATimesHero,npr1:old.scrapeNPRHero,bbc1:old.scrapeBBCHero,fox1:old.scrapeFoxHero,yahoo1:old.scrapeWPHero};
const results=[];
const ids=process.argv.slice(2).length?process.argv.slice(2):old.SOURCE_REGISTRY.map(s=>s.id);
for(const id of ids){
 const invoke=async fn=>{try{return await fn();}catch(e){return {ok:false,error:e.message};}};
 const [http,rendered]=await Promise.all([invoke(old.HERO_SCRAPERS_HTTP[id]||(()=>{throw Error('No HTTP adapter');})),invoke(browser[id])]);
 const match=Boolean(http.ok&&rendered.ok&&old.normalizeUrl(http.item?.url)===old.normalizeUrl(rendered.item?.url)&&http.item?.title===rendered.item?.title);
 const result={id,at:new Date().toISOString(),match,http,rendered};results.push(result);
 fs.writeFileSync('/tmp/newsboard-collector-comparison.json',JSON.stringify(results,null,2));
 console.log(JSON.stringify({id,match,http:{ok:http.ok,item:http.item,error:http.error,status:http.meta?.http_status},rendered:{ok:rendered.ok,item:rendered.item,error:rendered.error}}));
}
