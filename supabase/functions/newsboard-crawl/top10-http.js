import * as cheerio from 'cheerio';
import {validateTop10,failedTop10} from '../_shared/top10.js';
export function extractHttpTop10(sourceId,html,centerpiece,document) {
 if(!['abc1','cbs1'].includes(sourceId))return null;
 try {
  const $=document||cheerio.load(html), candidates=[];
  const config=sourceId==='abc1'?{
   base:'https://abcnews.com/',cards:'main [data-testid="prism-card"]',headline:'[data-testid="prism-headline"],h1,h2,h3,h4',anchor:'a[data-testid="prism-linkbase"][href]',host:/^(abcnews\.go\.com|abcnews\.com)$/,article:/\/(story|wireStory|live-updates)(\/|$)/,
  }:sourceId==='cbs1'?{
   base:'https://www.cbsnews.com/',cards:'#component-latest-news article.item, #component-more-top-stories article.item',headline:'h4.item__hed,h1,h2,h3,h4',anchor:'a[href]',host:/^(www\.)?cbsnews\.com$/,article:/^\/(news|live-updates)\//,
  }:null;
  if(!config)return null;
  $(config.cards).each((index,el)=>{
   const card=$(el);const heading=card.find(config.headline).first();
   const a=heading.closest('a[href]').length?heading.closest('a[href]'):card.find(config.anchor).first();
   const title=(heading.text()||a.attr('aria-label')||'').replace(/\s+/g,' ').trim();
   let u;try{u=new URL(a.attr('href'),config.base);}catch{}
   const excluded=card.closest('nav,footer,aside,[role="navigation"],[data-testid*="sponsor"],.sponsored,.newsletter,.most-popular').length;
   candidates.push({title,url:u?.href,rejected:excluded?'excluded module':!u?'invalid URL':!config.host.test(u.hostname)||!config.article.test(u.pathname)?'non-editorial':null});
  });
  return validateTop10(candidates,{sourceId,baseUrl:config.base,centerpiece,diagnostics:{method:'http',strategy:config.cards}});
 } catch(e){return failedTop10(e);}
}
