import * as cheerio from "cheerio";
import {extractHttpTop10} from "./top10-http.js";
import { createHash } from "node:crypto";
const sha1=s=>createHash("sha1").update(s).digest("hex");
const parseUrlSafe=s=>{try{return new URL(s);}catch{return null;}};
function cleanText(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function stripHeadlineNoise(s) {
  let t = cleanText(s || "");
  if (!t) return t;

  // ISO timestamps / datastore-looking tails.
  t = t.replace(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\b/g, "");
  t = t.replace(/\b20\d{2}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(:\d{2})?\b/g, "");

  // Relative freshness badges often injected into anchor text.
  t = t.replace(/\b\d+\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s+ago\b/gi, "");
  t = t.replace(/\b(updated|posted)\s+\d+\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours|day|days)\s+ago\b/gi, "");

  t = t.replace(/\s{2,}/g, " ").replace(/[|•\-:;, ]+$/g, "").trim();
  return t;
}

function normalizeUrl(u) {
  const raw = String(u || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) url.hostname = host.slice(4);
    url.hash = "";

    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }

    const dropParams = new Set([
      "fbclid",
      "gclid",
      "dclid",
      "igshid",
      "mc_cid",
      "mc_eid",
      "ocid",
      "_ga",
      "_gl",
      "spm",
    ]);

    for (const key of [...url.searchParams.keys()]) {
      const lk = key.toLowerCase();
      if (lk.startsWith("utm_") || dropParams.has(lk)) url.searchParams.delete(key);
    }

    url.searchParams.sort();
    return url.toString();
  } catch {
    return raw;
  }
}


function toAbsoluteUrl(href, baseUrl) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  try {
    return normalizeUrl(new URL(raw, baseUrl).toString());
  } catch {
    return "";
  }
}

function pickHeadlineText($, el) {
  const node = $(el);
  const h = node.find("h1,h2,h3,h4").first();
  const txt = stripHeadlineNoise(
    cleanText(h.text() || node.attr("aria-label") || node.attr("title") || node.text() || ""),
  );
  return txt;
}

function defaultUrlAllow(url, hostPattern) {
  const u = parseUrlSafe(url);
  if (!u) return false;
  if (hostPattern && !hostPattern.test(u.hostname)) return false;
  const p = String(u.pathname || "").toLowerCase();
  if (!p || p === "/" || p.length < 4) return false;
  if (/\/(video|videos|live|search|account|privacy|terms|about|contact|advertis|newsletter|shop)\b/.test(p)) return false;
  return true;
}

function defaultTitleReject(title) {
  const t = String(title || "").toLowerCase();
  return (
    t.length < 12 ||
    /\b(sign in|subscribe|watch live|about our ads|privacy policy|terms of service|advertise with us)\b/.test(t)
  );
}

function extractCbsFromJsonLd(html = "", sourceUrl = "https://www.cbsnews.com/", document) {
  const $ = document || cheerio.load(html || "");
  const out = [];
  const seen = new Set();

  function pushCandidate(titleRaw, urlRaw) {
    const title = stripHeadlineNoise(cleanText(titleRaw || ""));
    const url = toAbsoluteUrl(urlRaw || "", sourceUrl);
    if (!title || !url || seen.has(url)) return;
    const parsed = parseUrlSafe(url);
    if (!/(^|\.)cbsnews\.com$/i.test(parsed?.hostname || "")) return;
    if (String(parsed?.pathname || "") === "/") return;
    if (/\/(video|videos|live|watch|account|privacy|terms)\b/i.test(url)) return;
    if (/cbs news \| breaking news, top stories/i.test(title)) return;
    if (defaultTitleReject(title)) return;
    seen.add(url);
    out.push({ title, url });
  }

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    pushCandidate(node.headline || node.name || "", node.url || node["@id"] || node.mainEntityOfPage || "");
    for (const v of Object.values(node)) visit(v);
  }

  $("script[type='application/ld+json']").each((_, el) => {
    const raw = $(el).text() || "";
    if (!raw.trim()) return;
    try {
      visit(JSON.parse(raw));
    } catch {}
  });

  const top = out[0] || null;
  if (!top) return null;
  return { ...top, selector: "cbs_jsonld" };
}

function extractCbsLeadFromDom(html = "", sourceUrl = "https://www.cbsnews.com/", document) {
  const $ = document || cheerio.load(html || "");
  const selectors = [
    "#component-latest-news article.item a:has(h4.item__hed)",
    "#component-latest-news h4.item__hed",
    "article.item.item--type-updating_story a:has(h4.item__hed)",
    "h4.item__hed",
  ];
  const seen = new Set();

  for (const sel of selectors) {
    const nodes = $(sel).toArray().slice(0, 24);
    for (const el of nodes) {
      const a = el.name === "a"
        ? $(el)
        : $(el).closest("a[href]").first().length
          ? $(el).closest("a[href]").first()
          : $(el).find("a[href]").first();
      if (!a.length) continue;
      const url = toAbsoluteUrl(a.attr("href") || "", sourceUrl);
      const title = stripHeadlineNoise(cleanText(
        a.find("h4.item__hed,h1,h2,h3,h4").first().text() ||
        a.attr("aria-label") ||
        a.text() ||
        "",
      ));
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);

      const u = parseUrlSafe(url);
      if (!/(^|\.)cbsnews\.com$/i.test(u?.hostname || "")) continue;
      if (String(u?.pathname || "") === "/") continue;
      if (/\/(video|videos|watch|account|privacy|terms)\b/i.test(url)) continue;
      if (/cbs news \| breaking news, top stories/i.test(title)) continue;
      if (defaultTitleReject(title)) continue;
      return { title, url, selector: sel };
    }
  }
  return null;
}

function extractNbcFromNextData(html = "", sourceUrl = "https://www.nbcnews.com/") {
  const $ = cheerio.load(html || "");
  const nextRaw = $("#__NEXT_DATA__").text() || "";
  if (!nextRaw.trim()) return null;

  function normalizeNbcUrl(v) {
    if (!v) return "";
    if (typeof v === "string") return toAbsoluteUrl(v, sourceUrl);
    if (typeof v === "object") return toAbsoluteUrl(v.primary || v.canonical || "", sourceUrl);
    return "";
  }

  function asHeadlineItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw.item || raw;
    const computed = raw.computedValues || item.computedValues || {};
    const headline = stripHeadlineNoise(cleanText(
      computed.headline ||
      (Array.isArray(computed.headlineAlternatives) ? computed.headlineAlternatives[0]?.text : "") ||
      item.headline ||
      item.name ||
      "",
    ));
    const url = normalizeNbcUrl(computed.url || item.url);
    if (!headline || !url || defaultTitleReject(headline)) return null;
    const u = parseUrlSafe(url);
    if (!/(^|\.)nbcnews\.com$/i.test(u?.hostname || "")) return null;
    if (!/-rcna\d+|\/live-blog\//i.test(url)) return null;
    return { title: headline, url };
  }

  try {
    const parsed = JSON.parse(nextRaw);
    const layouts =
      parsed?.props?.pageProps?.initialState?.front?.curation?.layouts ||
      parsed?.props?.initialState?.front?.curation?.layouts ||
      [];

    for (const layout of Array.isArray(layouts) ? layouts : []) {
      const packages = Array.isArray(layout?.packages) ? layout.packages : [];
      for (const pkg of packages) {
        const items = Array.isArray(pkg?.items) ? pkg.items : [];
        for (const rawItem of items) {
          const picked = asHeadlineItem(rawItem);
          if (picked) return { ...picked, selector: "nbc_next_data_ordered" };
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function extractFoxLeadFromDom(html = "", sourceUrl = "https://www.foxnews.com/") {
  const $ = cheerio.load(html || "");
  const seenArticles = new Set();
  const articleSelectors = [
    "main.main-content-primary article.story-1",
    "article.story-1",
    "main.main-content-primary article[class*='story-']",
    "main article[class*='story-']",
  ];
  const headlineSelectors = [
    ".info .title a[href]",
    ".info h1 a[href], .info h2 a[href], .info h3 a[href]",
    "header.info-header .title a[href]",
    "h1.title a[href], h2.title a[href], h3.title a[href]",
  ];

  function isFoxStoryUrl(url) {
    const u = parseUrlSafe(url);
    if (!u || !/(^|\.)foxnews\.com$/i.test(u.hostname)) return false;
    const p = String(u.pathname || "").toLowerCase();
    if (!/^\/[a-z0-9-]+\/[a-z0-9-]+/i.test(p)) return false;
    if (/^\/(live|search|category|shows|video|fox-nation|weather|sports\/odds|person|about|newsletter|apps)(\/|$)/i.test(p)) return false;
    return true;
  }

  function isKickerOnlyTitle(article, title) {
    const normalizedTitle = cleanText(title).toLowerCase();
    if (!normalizedTitle) return true;
    const kickerTitle = cleanText(article.find(".kicker,.kicker-text").first().text()).toLowerCase();
    if (kickerTitle && normalizedTitle === kickerTitle) return true;
    return /^\s*(tables turned|breaking news|watch live)\s*$/i.test(String(title || ""));
  }

  for (const articleSel of articleSelectors) {
    const articles = $(articleSel).toArray().slice(0, 24);
    for (const articleEl of articles) {
      if (seenArticles.has(articleEl)) continue;
      seenArticles.add(articleEl);
      const article = $(articleEl);

      for (const headlineSel of headlineSelectors) {
        const headlineAnchor = article.find(headlineSel).first();
        if (!headlineAnchor.length) continue;

        const title = stripHeadlineNoise(cleanText(
          String(headlineAnchor.text() || "").replace(/\s*-\s*Fox News\s*$/i, ""),
        ));
        const url = toAbsoluteUrl(headlineAnchor.attr("href") || "", sourceUrl);
        if (!title || !url || isKickerOnlyTitle(article, title)) continue;
        if (!isFoxStoryUrl(url) || defaultTitleReject(title)) continue;
        return { title, url, selector: `fox_dom:${articleSel} ${headlineSel}` };
      }
    }
  }

  return null;
}

function extractLeadFromHtml({
  html,
  sourceId,
  sourceUrl,
  selectors = [],
  hostPattern = null,
  urlAllow = null,
  titleReject = null,
  document,
}) {
  const $ = document || cheerio.load(html || "");
  const seen = new Set();
  const candidates = [];
  let selectorUsed = null;

  for (let i = 0; i < selectors.length; i += 1) {
    const sel = selectors[i];
    const matches = $(sel).toArray().slice(0, 20);
    for (let j = 0; j < matches.length; j += 1) {
      const el = matches[j];
      const anchor = el.name === "a" ? $(el) : $(el).closest("a[href]").first().length ? $(el).closest("a[href]").first() : $(el).find("a[href]").first();
      if (!anchor.length) continue;
      const href = anchor.attr("href") || "";
      const url = toAbsoluteUrl(href, sourceUrl);
      if (!url) continue;
      if ((urlAllow && !urlAllow(url)) || (!urlAllow && !defaultUrlAllow(url, hostPattern))) continue;

      const title = pickHeadlineText($, el);
      if (!title || (titleReject ? titleReject(title) : defaultTitleReject(title))) continue;
      if (seen.has(url)) continue;
      seen.add(url);

      const score = (selectors.length - i) * 1000 - j * 10;
      candidates.push({ title, url, score, selector: sel });
    }
  }

  if (!candidates.length) {
    const ogTitle = stripHeadlineNoise(cleanText($("meta[property='og:title']").attr("content") || ""));
    const canonical = toAbsoluteUrl($("link[rel='canonical']").attr("href") || "", sourceUrl);
    if (ogTitle && canonical && defaultUrlAllow(canonical, hostPattern) && !defaultTitleReject(ogTitle)) {
      candidates.push({ title: ogTitle, url: canonical, score: 1, selector: "meta[og:title]+canonical" });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0] || null;
  selectorUsed = top?.selector || null;
  if (!top) {
    return { ok: false, error: `${sourceId}: headline not found`, selectorUsed: null, candidates: 0, item: null };
  }

  return {
    ok: true,
    error: null,
    selectorUsed,
    candidates: candidates.length,
    item: {
      title: top.title,
      url: top.url,
      imgUrl: null,
      slotKey: sha1(`${sourceId}|top`).slice(0, 12),
    },
  };
}


const HTTP_HERO_CONFIGS = {
  abc1: {
    sourceUrl: "https://abcnews.com/",
    // A promoted live-update article is editorial; /Live is the TV utility.
    urlAllow: url => /^https:\/\/(?:abcnews\.com|abcnews\.go\.com)\/[^?#]*\/(?:story|wireStory|live-updates)(?:[/?]|$)/i.test(url),
    hostPattern: /(^|\.)abcnews\.go\.com$|(^|\.)abcnews\.com$/i,
    selectors: ["main [data-testid='prism-card'] a[data-testid='prism-linkbase'][href]", "main h1 a[href], main h2 a[href], main h3 a[href]"],
  },
  cbs1: {
    sourceUrl: "https://www.cbsnews.com/",
    hostPattern: /(^|\.)cbsnews\.com$/i,
    customExtractor: (html, sourceUrl, document) => extractCbsLeadFromDom(html, sourceUrl, document) || extractCbsFromJsonLd(html, sourceUrl, document),
    selectors: ["main h4.item__hed a[href]", "main h1 a[href], main h2 a[href], main h3 a[href]"],
  },
  usat1: {
    sourceUrl: "https://www.usatoday.com/",
    hostPattern: /(^|\.)usatoday\.com$/i,
    selectors: ["main a[href*='/story/']", "main h1 a[href], main h2 a[href], main h3 a[href]"],
  },
  nbc1: {
    sourceUrl: "https://www.nbcnews.com/",
    mobile: true,
    hostPattern: /(^|\.)nbcnews\.com$/i,
    customExtractor: extractNbcFromNextData,
    selectors: ["main a[href*='-rcna']", "main a[href*='/live-blog/']", "main h1 a[href], main h2 a[href], main h3 a[href]"],
  },
  guardian1: {
    sourceUrl: "https://www.theguardian.com/us",
    hostPattern: /(^|\.)theguardian\.com$/i,
    selectors: ["main a[data-link-name*='group-0'][href]", "main a[href*='/live/']", "main .headline-text"],
  },
  ap1: {
    sourceUrl: "https://apnews.com/",
    hostPattern: /(^|\.)apnews\.com$/i,
    selectors: ["main a[data-key='main-story'][href]", "main a.Link[href]", "main h1 a[href], main h2 a[href], main h3 a[href]"],
  },
  latimes1: {
    sourceUrl: "https://www.latimes.com/",
    hostPattern: /(^|\.)latimes\.com$/i,
    selectors: ["main h1.promo-title a[href]", "main .promo-title a[href]", "main article h1 a[href]"],
  },
  npr1: {
    sourceUrl: "https://www.npr.org/",
    hostPattern: /(^|\.)npr\.org$/i,
    selectors: ["main article a[href]", "main h1 a[href], main h2 a[href], main h3 a[href]"],
  },
  bbc1: {
    sourceUrl: "https://www.bbc.com/news",
    hostPattern: /(^|\.)bbc\.com$/i,
    selectors: ["main a[data-testid='internal-link'][href*='/news/articles/']", "main a[href*='/news/live/']", "main h2 a[href], main h3 a[href]"],
  },
  fox1: {
    sourceUrl: "https://www.foxnews.com/",
    hostPattern: /(^|\.)foxnews\.com$/i,
    customExtractor: extractFoxLeadFromDom,
    selectors: ["main.main-content-primary article.story-1 a[href]", "main.main-content-primary article a[href]", "main h1 a[href], main h2 a[href]"],
  },
  yahoo1: {
    sourceUrl: "https://www.yahoo.com/news/",
    mobile: true,
    hostPattern: /(^|\.)yahoo\.com$/i,
    selectors: ["a[data-ylk*='sec:strm'][data-ylk*='ct:story'][href]", "main a[data-ylk*='ct:story'][href]", "main a[href]"],
    urlAllow: (url) => {
      const u = parseUrlSafe(url);
      if (!u || !/(^|\.)yahoo\.com$/i.test(u.hostname)) return false;
      const p = String(u.pathname || "").toLowerCase();
      const full = String(url || "").toLowerCase();
      if (/\b(about-our-ads|our-ads|adchoices|privacy|legal|terms|account|member-center|subscriptions)\b/.test(full)) return false;
      if (/^\/(search|news|finance|sports|entertainment|lifestyle|mail|weather|video|autos)\/?$/.test(p)) return false;
      return /^\/[a-z0-9-]+\/[a-z0-9-]+/.test(p) || /^\/news\/articles\//.test(p);
    },
  },
};


export const publishers = Object.entries(HTTP_HERO_CONFIGS).map(([id, config])=>({id, ...config}));
export function parsePublisher(publisher, html, document) {
 const custom=publisher.customExtractor?.(html,publisher.sourceUrl,document);
 const result=custom ? {ok:true,item:{title:custom.title,url:custom.url,imgUrl:null,slotKey:sha1(`${publisher.id}|top`).slice(0,12)},selectorUsed:custom.selector} : extractLeadFromHtml({html,document,sourceId:publisher.id,...publisher});
 if(!result.ok || !result.item?.title || !result.item?.url) throw new Error(result.error || 'No usable CP');
 return {...result,item:{...result.item,rank:1,contentType:/live-blog|live-updates|\/live\//i.test(result.item.url)?'live':'news'}};
}
export async function collectPublisher(publisher, {onDocument} = {}) {
 const start=Date.now();
 const response=await fetch(publisher.sourceUrl,{signal:AbortSignal.timeout(20000),headers:{'user-agent':publisher.mobile?'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',accept:'text/html,application/xhtml+xml'}});
 if(!response.ok) throw Object.assign(new Error(`Homepage HTTP ${response.status}`),{httpStatus:response.status});
 const html=await response.text();
 if(html.length>8000000) throw new Error('Homepage exceeds 8 MB parsing budget');
 if (onDocument) onDocument(html);
 // Share one parsed tree between CP and Top 10; other publishers do no extra parsing.
 const document=['abc1','cbs1'].includes(publisher.id)?cheerio.load(html):undefined;
 const parsed=parsePublisher(publisher,html,document);
 const rankingStart=Date.now();
 const ranked=extractHttpTop10(publisher.id,html,parsed.item,document);
 if(ranked)ranked.diagnostics.extraction_ms=Date.now()-rankingStart;
 const items=[{...parsed.item,slot_key:'hero:1',fingerprint:top10Fingerprint(parsed.item.url,parsed.item.title)}];
 return {source_id:publisher.id,observed_at:new Date().toISOString(),item:parsed.item,top10:ranked?.items??null,top10_quality:ranked?.quality,top10_diagnostics:ranked?.diagnostics,items,http_status:response.status,duration_ms:Date.now()-start,selector:parsed.selectorUsed};
}
export {normalizeUrl};

function top10Fingerprint(url,title) { return sha1(`${normalizeUrl(url)}|${cleanText(title).toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim()}`); }
export function parseAbcTop10(html) {
 const $=cheerio.load(html);
 const wrap=node=>node?({textContent:$(node).text(),getAttribute:k=>$(node).attr(k),closest:s=>wrap($(node).closest(s)[0]),querySelector:s=>wrap($(node).find(s)[0]),querySelectorAll:s=>$(node).find(s).toArray().map(wrap)}):null;
 const document={querySelector:s=>wrap($(s)[0]),querySelectorAll:s=>$(s).toArray().map(wrap),body:wrap($('body')[0])};
 const extracted=(()=>{
      function clean(s) {
        return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      }
      function abs(href) {
        try {
          return new URL(href, "https://abcnews.com").toString();
        } catch {
          return null;
        }
      }
      function storyLike(link, title) {
        const u = String(link || "").toLowerCase();
        const t = String(title || "").toLowerCase();
        if (!u || u.startsWith("javascript:") || u.startsWith("mailto:")) return false;
        if (u.includes("/video") || u.includes("/videos") || u.includes("/live/video")) return false;
        if (u.endsWith("/live") || u.includes("/live?") || u.includes("/live/")) return false;
        if (u.includes("/search") || u.includes("/account") || u.includes("/newsletters")) return false;
        if (u.includes("/shop") || u.includes("/about") || u.includes("/contact")) return false;
        if (t.includes("sign in") || t.includes("subscribe") || t.includes("watch live")) return false;
        if (t.includes("abcnl prime") || t.includes("abc news live")) return false;
        return true;
      }
      function collectFromJsonLdNode(node, out) {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) collectFromJsonLdNode(item, out);
          return;
        }
        const t = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
        const typeSet = new Set(t.map((x) => String(x || "").toLowerCase()));
        const isStory = typeSet.has("newsarticle") || typeSet.has("article") || typeSet.has("reportage");
        const isList = typeSet.has("itemlist");

        if (isStory) {
          const title = clean(node.headline || node.name || "");
          const url = abs(node.url || node.mainEntityOfPage?.["@id"] || node.mainEntityOfPage || "");
          if (title && url) out.push({ title, url });
        }

        if (isList && Array.isArray(node.itemListElement)) {
          for (const listItem of node.itemListElement) {
            const it = listItem?.item || listItem;
            if (!it) continue;
            const title = clean(it.headline || it.name || listItem?.name || "");
            const url = abs(it.url || it["@id"] || listItem?.url || "");
            if (title && url) out.push({ title, url });
          }
        }

        for (const v of Object.values(node)) collectFromJsonLdNode(v, out);
      }

      const picked = [];
      let used = "anchor_harvest";
      let anchorAdded = 0;

      for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 40)) {
        const text = script.textContent || "";
        if (!text.trim()) continue;
        try {
          const parsed = JSON.parse(text);
          collectFromJsonLdNode(parsed, picked);
        } catch {}
      }

      const jsonldCount = picked.length;
      if (picked.length >= 10) {
        used = "jsonld";
        return {
          rows: picked.slice(0, 40),
          selector_used: used,
          candidates: { primary: jsonldCount, fallback: 0 },
        };
      }

      const root = document.querySelector("main") || document.body;
      const links = Array.from(root.querySelectorAll("a[href]")).slice(0, 900);
      for (const a of links) {
        if (picked.length >= 80) break;
        if (a.closest("header,nav,footer,[role='navigation']")) continue;
        const href = abs(a.getAttribute("href") || "");
        const title = clean(a.getAttribute("aria-label") || a.textContent || "");
        if (!storyLike(href, title)) continue;
        if (!href || !title || title.length < 16) continue;
        picked.push({ title, url: href });
        anchorAdded += 1;
      }

      return {
        rows: picked,
        selector_used: used,
        candidates: { primary: jsonldCount, fallback: anchorAdded },
      };
 })();
    const candidates = [];
    const seen = new Set();
    for (const row of Array.isArray(extracted?.rows) ? extracted.rows : []) {
      const title = stripHeadlineNoise(cleanText(row?.title || ""));
      const url = normalizeUrl(row?.url || "");
      if (!title || !url || seen.has(url)) continue;
      const lcTitle = title.toLowerCase();
      const lcUrl = url.toLowerCase();
      if (lcUrl === "https://abcnews.com/live" || lcUrl === "https://abcnews.com/live/") continue;
      if (lcTitle.includes("abcnl prime") || lcTitle.includes("abc news live")) continue;
      seen.add(url);
      candidates.push({
        title,
        url,
        fingerprint: top10Fingerprint(url, title),
      });
    }

    const primary = candidates[0] || null;
    const relatedLinks = [];
    const rankingRows = [];
    const primaryUrl = parseUrlSafe(primary?.url || "");
    const primaryId = primaryUrl?.searchParams?.get("id") || "";

    for (const row of candidates) {
      const u = parseUrlSafe(row.url);
      const isPrimaryFamily =
        Boolean(primaryUrl && u) &&
        String(primaryUrl.origin + primaryUrl.pathname).toLowerCase() === String(u.origin + u.pathname).toLowerCase();
      const hasEntry = Boolean(u?.searchParams?.get("entryId"));
      const sameId = Boolean(primaryId) && String(u?.searchParams?.get("id") || "") === String(primaryId);

      if (isPrimaryFamily && hasEntry && sameId) {
        relatedLinks.push({ title: row.title, url: row.url });
        continue;
      }

      rankingRows.push(row);
      if (rankingRows.length >= 10) break;
    }

    const items = rankingRows.map((row, idx) => ({
      rank: idx + 1,
      title: row.title,
      url: row.url,
      fingerprint: row.fingerprint,
      related_links: idx === 0 ? relatedLinks.slice(0, 12) : [],
    }));


 if(items.length!==10) throw new Error(`ABC Top 10: expected 10, found ${items.length}`);
 return items;
}
