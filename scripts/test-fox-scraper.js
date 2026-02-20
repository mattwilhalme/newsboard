import fs from "fs";
import * as cheerio from "cheerio";

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function toAbs(href) {
  try {
    return new URL(String(href || ""), "https://www.foxnews.com").toString();
  } catch {
    return null;
  }
}

function cleanTitle(title) {
  return normalizeSpaces(String(title || "").replace(/\s*-\s*Fox News\s*$/i, ""));
}

function isStoryUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/(^|\.)foxnews\.com$/i.test(u.hostname)) return false;
    const path = String(u.pathname || "");
    if (!/^\/[a-z0-9-]+\/[a-z0-9-]+/i.test(path)) return false;
    if (/^\/(live|search|category|shows|video|fox-nation|weather|sports\/odds|person|about|newsletter|apps)(\/|$)/i.test(path)) return false;
    return true;
  } catch {
    return false;
  }
}

function isVideoUrl(url) {
  return /\/video\//i.test(String(url || ""));
}

function scoreCandidate(c) {
  let score = 0;
  if (c.inMainPrimary) score += 100;
  if (c.inStoryClass) score += 130;
  if (c.isStory1) score += 80;
  if (c.hasImage) score += 45;
  if (c.imgSrc && /\/content\/uploads\//i.test(c.imgSrc)) score += 25;
  if (c.title.length >= 20 && c.title.length <= 220) score += 15;
  if (isVideoUrl(c.url)) score -= 220;
  return score;
}

function extractTopStoryFromHtml(html) {
  const $ = cheerio.load(html);
  const selectors = [
    "main.main-content-primary article.story-1 a[href]",
    "main.main-content-primary article[class*='story-'] a[href]",
    "main.main-content-primary a[href]",
    "main a[href]",
    "article.story-1 a[href]",
  ];

  const seen = new Set();
  const ranked = [];

  for (const sel of selectors) {
    $(sel).each((_i, el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const href = $(el).attr("href") || "";
      const url = toAbs(href);
      const img = $(el).find("img[alt]").first();
      const imgAlt = normalizeSpaces(img.attr("alt"));
      const imgSrc = normalizeSpaces(img.attr("src"));
      const textTitle = normalizeSpaces(
        $(el).find("h1,h2,h3,.title,.headline").first().text() ||
        $(el).attr("title") ||
        $(el).attr("aria-label") ||
        $(el).text(),
      );
      const title = cleanTitle(imgAlt || textTitle);
      if (!url || !title || !isStoryUrl(url)) return;
      const candidate = {
        url,
        title,
        imgSrc,
        hasImage: Boolean(img.length),
        inMainPrimary: $(el).parents("main.main-content-primary").length > 0,
        inStoryClass: $(el).parents("article[class*='story-']").length > 0,
        isStory1: $(el).parents("article.story-1").length > 0,
      };
      ranked.push({ ...candidate, score: scoreCandidate(candidate) });
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

function detectBlocked({ httpStatus, finalUrl, pageTitle, errorText }) {
  const status = Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null;
  if (status === 403) return { blocked: true, blocked_reason: "http_403" };
  if (status === 429) return { blocked: true, blocked_reason: "http_429" };
  const hay = `${finalUrl || ""} ${pageTitle || ""} ${errorText || ""}`.toLowerCase();
  if (/captcha|are you a robot|verify you are human/.test(hay)) return { blocked: true, blocked_reason: "captcha" };
  if (/interstitial|access denied|forbidden|blocked/.test(hay)) return { blocked: true, blocked_reason: "interstitial" };
  return { blocked: false, blocked_reason: null };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run() {
  const html = fs.readFileSync("fox-news.html", "utf8");
  const top = extractTopStoryFromHtml(html);
  assert(top, "Expected a Fox News top story candidate");
  assert(
    top.url.includes("/politics/senate-hopeful-deep-dem-ties-has-paid-family-over-350k-from-his-campaign-coffers"),
    `Unexpected top URL: ${top.url}`,
  );
  assert(
    /Nebraska Senate hopeful funnels eye-popping amount of campaign cash to wife and family/i.test(top.title),
    `Unexpected top title: ${top.title}`,
  );

  const blockCases = [
    { in: { httpStatus: 403 }, out: "http_403" },
    { in: { httpStatus: 429 }, out: "http_429" },
    { in: { pageTitle: "Please verify you are human" }, out: "captcha" },
    { in: { errorText: "Access denied by security policy" }, out: "interstitial" },
  ];
  for (const tc of blockCases) {
    const got = detectBlocked(tc.in);
    assert(got.blocked === true, `Expected blocked=true for case: ${JSON.stringify(tc.in)}`);
    assert(got.blocked_reason === tc.out, `Expected reason=${tc.out}, got=${got.blocked_reason}`);
  }
  const notBlocked = detectBlocked({ httpStatus: 200, pageTitle: "Fox News - Breaking News" });
  assert(notBlocked.blocked === false, "Expected non-blocked case to be false");

  console.log("Fox scraper tests passed.");
  console.log(`Top story: ${top.title} -> ${top.url}`);
}

try {
  run();
} catch (err) {
  console.error("Fox scraper tests failed:", String(err?.message || err));
  process.exit(1);
}
