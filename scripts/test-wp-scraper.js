import fs from "fs";
import * as cheerio from "cheerio";

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function toAbs(href) {
  try {
    return new URL(String(href || ""), "https://www.washingtonpost.com").toString();
  } catch {
    return null;
  }
}

function isStoryUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/(^|\.)washingtonpost\.com$/i.test(u.hostname)) return false;
    const p = String(u.pathname || "");
    if (!/^\/[a-z0-9-]+\/20\d{2}\/\d{2}\/\d{2}\//i.test(p)) return false;
    if (/\/(graphics|video|podcasts?|opinions\/letters|live-updates)\//i.test(p)) return false;
    return true;
  } catch {
    return false;
  }
}

function scoreCandidate(c) {
  let score = 0;
  if (c.hasWebHeadlineField) score += 220;
  if (c.inHeadlineBlock) score += 120;
  if (c.inMain) score += 70;
  if (c.inHeading) score += 40;
  if (c.title.length >= 20 && c.title.length <= 220) score += 15;
  return score;
}

function extractTopStoryFromHtml(html) {
  const $ = cheerio.load(html);
  const selectors = [
    'main a[data-pb-local-content-field="web_headline"][href]',
    'a[data-pb-local-content-field="web_headline"][href]',
    "main h1 a[href], main h2 a[href], main h3 a[href]",
    "main a[href]",
  ];

  const seen = new Set();
  const ranked = [];

  for (const sel of selectors) {
    $(sel).each((_i, el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if ($(el).parents("nav,header,footer,[role='navigation']").length) return;

      const href = $(el).attr("href") || "";
      const url = toAbs(href);
      const title =
        normalizeSpaces($(el).find("span").first().text()) ||
        normalizeSpaces($(el).attr("aria-label")) ||
        normalizeSpaces($(el).text());
      if (!url || !title || !isStoryUrl(url)) return;

      const candidate = {
        url,
        title,
        hasWebHeadlineField: ($(el).attr("data-pb-local-content-field") || "") === "web_headline",
        inHeadlineBlock: $(el).parents(".headline.relative,.headline").length > 0,
        inMain: $(el).parents("main").length > 0,
        inHeading: $(el).parents("h1,h2,h3").length > 0,
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
  const html = fs.readFileSync("washington-post.html", "utf8");
  const top = extractTopStoryFromHtml(html);

  assert(top, "Expected a Washington Post top story candidate");
  assert(
    top.url.includes("/national-security/2026/02/19/trump-iran-attack-military/"),
    `Unexpected top URL: ${top.url}`,
  );
  assert(
    /Trump appears ready to attack Iran as U\.S\. strike force takes shape/i.test(top.title),
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

  const notBlocked = detectBlocked({ httpStatus: 200, pageTitle: "The Washington Post" });
  assert(notBlocked.blocked === false, "Expected non-blocked case to be false");

  console.log("Washington Post scraper tests passed.");
  console.log(`Top story: ${top.title} -> ${top.url}`);
}

try {
  run();
} catch (err) {
  console.error("Washington Post scraper tests failed:", String(err?.message || err));
  process.exit(1);
}
