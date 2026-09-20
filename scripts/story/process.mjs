// Explicitly bounded backfill. No default whole-database processing.
import { createClient } from '@supabase/supabase-js';
import { processWindow } from '../../supabase/functions/story-intelligence/processor.js';
const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
let start,end;
if(args.includes('--hours')){const hours=Number(get('--hours'));if(!(hours>0&&hours<=24))throw new Error('--hours must be >0 and <=24');end=new Date().toISOString();start=new Date(Date.parse(end)-hours*3600000).toISOString();}
else if(args.includes('--start')&&args.includes('--end')){start=get('--start');end=get('--end');}
else throw new Error('Use --hours 6, --hours 24, or --start ISO --end ISO; add --max-batches N for an explicit larger run');
if(!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||Date.parse(end)<=Date.parse(start)||Date.parse(end)-Date.parse(start)>86400000)throw new Error('Invalid window (maximum 24 hours)');
const {SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:key}=process.env;if(!url||!key)throw new Error('Server-side Supabase credentials required');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const max=args.includes('--max-batches')?Number(get('--max-batches')):60;if(!Number.isInteger(max)||max<1||max>5000)throw new Error('Invalid batch bound');
let total=0;do{const result=await processWindow(db,{start,end,limit:Math.min(60,max-total)});console.log(JSON.stringify(result));total+=result.processed;if(result.status==='busy'||!result.processed||!result.more_possible)break;}while(total<max);
console.log(JSON.stringify({start,end,total,max_batches:max}));
