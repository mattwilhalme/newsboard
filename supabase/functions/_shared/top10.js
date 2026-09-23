import {createHash} from 'node:crypto';
export const TOP10_SOURCES = ['abc1','cbs1','nbc1','cnn1','ap1','usat1','yahoo1','guardian1'];
export function canonicalArticleUrl(raw, base) {
  try {
    const u=new URL(raw,base);
    if(!/^https?:$/.test(u.protocol))return '';
    u.protocol='https:';
    u.hostname=u.hostname.toLowerCase().replace(/^www\./,'');
    if(u.hostname==='abcnews.com')u.hostname='abcnews.go.com';
    if(u.hostname==='news.yahoo.com')u.hostname='yahoo.com';
    u.hash='';u.pathname=u.pathname.replace(/\/{2,}/g,'/').replace(/\/$/,'')||'/';
    for(const key of [...u.searchParams.keys()])if(/^(utm_|fbclid$|gclid$|dclid$|ocid$|ncid$|guccounter$|guce_|cmpid$|cid$|cvid$|ref$|ref_src$|mod$|output$|smid$|_ga$|_gl$|mc_|entryId$)/i.test(key))u.searchParams.delete(key);
    u.searchParams.sort();return u.href;
  }catch{return '';}
}
export function validateTop10(candidates,{sourceId,baseUrl,centerpiece,diagnostics={}}) {
  const seen=new Set(),items=[],rejected=[];
  for(const [index,c] of (candidates||[]).entries()) {
    const title=String(c.title||'').replace(/\s+/g,' ').trim();
    const url=canonicalArticleUrl(c.url,baseUrl);
    const reason=c.rejected || (!url?'invalid URL':title.length<12?'missing headline':title.length>350?'non-editorial':seen.has(url)?'duplicate URL':null);
    if(reason){rejected.push({index,title:title.slice(0,150),url,reason});continue;}
    seen.add(url);
    if(items.length<10)items.push({rank:items.length+1,title,url,fingerprint:createHash('sha1').update(url).digest('hex'),related_links:[]});
  }
  const agreement=Boolean(items.length && canonicalArticleUrl(centerpiece?.url,baseUrl)===items[0].url);
  const quality=!items.length?'failed':!agreement?'warning':items.length===10?'complete':'partial';
  return {items,quality,diagnostics:{...diagnostics,source_id:sourceId,item_count:items.length,unique:items.length,
    centerpiece_agreement:agreement,duplicates_removed:rejected.filter(r=>r.reason==='duplicate URL').length,
    candidates_rejected:rejected.length,rejected:rejected.slice(0,80),candidate_count:candidates?.length||0,
    warning:!agreement?'Rank 1 differs from centerpiece; excluded from rank-event/Story Identity processing':items.length<10?'Partial editorial list; no fillers or rank/exit events':null}};
}
export function failedTop10(error) {return {items:[],quality:'failed',diagnostics:{error:String(error?.message||error).slice(0,500)}};}
