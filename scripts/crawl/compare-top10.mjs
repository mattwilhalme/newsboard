import fs from 'node:fs';
import {scrapeABCTop10,normalizeUrl} from '../../server.js';
import {parseAbcTop10} from '../../supabase/functions/newsboard-crawl/collectors.js';
const [response,old]=await Promise.all([fetch('https://abcnews.com/'),scrapeABCTop10()]);
const items=parseAbcTop10(await response.text());
const comparisons=items.map((x,i)=>({rank:x.rank,title:x.title,url:x.url,match:x.title===old.items[i]?.title&&normalizeUrl(x.url)===normalizeUrl(old.items[i]?.url)&&x.rank===old.items[i]?.rank,fingerprintMatch:x.fingerprint===old.items[i]?.fingerprint}));
fs.writeFileSync('/tmp/newsboard-top10-comparison.json',JSON.stringify({at:new Date().toISOString(),old,items,comparisons},null,2));
console.log(JSON.stringify(comparisons,null,2));
