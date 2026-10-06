import {validateTop10,failedTop10} from '../supabase/functions/_shared/top10.js';
export const BROWSER_TOP10 = {
 ap1:{root:'main',headings:'.PagePromo-title a[href]',host:'apnews.com',article:'^/(article|live)/',exclude:'.PageListTrending,.PageListCarousel,[data-module-type="Trending"]'},
 usat1:{root:'main',headings:'a.gnt_m_hm[href],a.gnt_m_he[href],a.gnt_m_flm_a[href],a.gnt_m_tl_a[href],a.gnt_m_lm_a[href]',host:'usatoday.com',article:'^/(story|live-story|picture-gallery|videos)/',exclude:'[data-tb-region*="Recommended"],.gnt_m_gd'},
 nbc1:{root:'body',headings:'.storyline__headline a[href],.multistoryline__headline a[href],section.pkg h2 a[href],section.pkg h3 a[href],section.pkg .related-content-tease__headline a[href]',host:'nbcnews.com',article:'(/live-blog/|-rcna[0-9]+)',exclude:'[data-testid="breaking-content"],[data-icid="body-top-marquee"],[data-testid*="recommend"]'},
 cnn1:{root:'body',headings:'.container__title-url [data-editable="title"],.container__headline-text',host:'cnn.com',article:'^/[0-9]{4}/[0-9]{2}/[0-9]{2}/',exclude:'[data-zone-label*="paid"],[data-zone-label*="recommended"],.container_leaderboard,.container_ribbon'},
 guardian1:{root:'main #container-news',headings:'.card-headline',host:'theguardian.com',article:'/[0-9]{4}/[a-z]{3}/[0-9]{1,2}/',exclude:'[data-component*="paid"],[data-component*="commercial"]'},
 yahoo1:{root:'#top-stories',headings:'a[data-ylk*="elm:hdln"][href]',host:'yahoo.com',article:'\\.html$',exclude:'[data-ad],[data-testid*="ad-slot"]',carousel:true},
 latimes1:{root:'main',headings:'h1 a[href],h2 a[href],h3 a[href],.promo-title a.link[href]',host:'latimes.com',article:'^/(world-nation|california|politics|business|entertainment-arts|sports|science|environment|lifestyle|opinion)/',exclude:'.most-read,.newsletter,.promotional'},
 npr1:{root:'main',headings:'.story-text h3 a[href],h3.title a[href],a[data-metrics-ga4*="homepage_curation_click"][data-metrics-ga4*="curated story"][href]',host:'npr.org',article:'^/[0-9]{4}/[0-9]{2}/[0-9]{2}/',exclude:'[data-metrics-category-ga4="recirculation"],.recommended-stories',rejectTitle:'^(national security|politics|world|business|health|science|climate|culture|music|sports|technology)$'},
 bbc1:{root:'main',headings:'[data-testid="card-headline"]',host:'bbc.com',article:'^/(news|sport)/articles/|^/news/live/',exclude:'[data-testid*="most-read"],[data-testid*="recommend"]'},
 fox1:{root:'main.main-content-primary',headings:'article[class*="story-"] h1 a[href],article[class*="story-"] h2 a[href],article[class*="story-"] h3 a[href]',host:'foxnews.com',article:'^/(politics|us|world|media|entertainment|sports|lifestyle|health|tech|science)/',exclude:'.trending,.most-popular,.sponsored'},
};
// One evaluate against the CP page. No navigation, scrolling, new context or render.
export function extractRenderedCandidates({config}) {
 const clean=x=>String(x||'').replace(/\s+/g,' ').trim();
 const root=document.querySelector(config.root);if(!root)throw Error('Top 10 editorial root missing: '+config.root);
 const rows=[];let order=0;
 for(const el of root.querySelectorAll(config.headings)) {
  const r=el.getBoundingClientRect(),style=getComputedStyle(el);
  const title=clean(el.querySelector('.headline-text')?.textContent||el.textContent);
  let a=el.matches('a[href]')?el:el.closest('a[href]');
  if(config.host==='theguardian.com') {
   const card=el.closest('li')||el.parentElement;
   a=[...card.querySelectorAll('a[href][aria-label]')].find(x=>clean(x.getAttribute('aria-label'))===title);
  }
  let u;try{u=new URL(a?.getAttribute('href'),location.href);}catch{}
  const hidden=r.width===0||r.height===0||style.display==='none'||style.visibility==='hidden'||(!config.carousel&&(r.right<=0||r.left>=innerWidth));
  const excluded=el.closest('nav,footer,aside,[role="navigation"],.ad,.advertisement,.sponsored,[rel~="sponsored"]')||config.exclude&&el.closest(config.exclude);
  const utility=config.host==='usatoday.com'&&/horoscope|crossword|shuffle|^\/story\/shopping\//i.test(u?.pathname||'');
  const rejectedTitle=config.rejectTitle&&new RegExp(config.rejectTitle,'i').test(title);
  const reason=utility?'utility/shopping':rejectedTitle?'section/navigation label':excluded?'excluded module':hidden?'hidden duplicate/module':!u?'invalid URL':!(u.hostname===config.host||u.hostname.endsWith('.'+config.host))||!new RegExp(config.article,'i').test(u.pathname)?'non-editorial':null;
  const slide=el.closest('[aria-roledescription="slide"]')?.getAttribute('aria-label')?.match(/Slide (\d+)/i);
  rows.push({title,url:u?.href,rejected:reason,top:r.top+scrollY,left:r.left,order:order++,priority:1,slide:slide?Number(slide[1]):null});
 }
 return rows.sort((a,b)=>config.carousel?(a.slide??999)-(b.slide??999)||a.order-b.order:a.priority-b.priority||a.top-b.top||a.left-b.left||a.order-b.order);
}
export async function collectBrowserTop10(page,sourceId,centerpiece) {
 const start=Date.now();
 try{
  const config=BROWSER_TOP10[sourceId];
  const candidates=await page.evaluate(extractRenderedCandidates,{config});
  const result=validateTop10(candidates,{sourceId,baseUrl:page.url(),centerpiece,diagnostics:{method:sourceId==='cnn1'?'browser':'mobile browser',strategy:config.root+' '+config.headings,candidates:candidates.slice(0,30)}});
  result.diagnostics.extraction_ms=Date.now()-start;
  return result;
 }catch(e){return failedTop10(e);}
}
