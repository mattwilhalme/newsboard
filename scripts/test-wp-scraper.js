import fs from "fs";
import * as cheerio from "cheerio";

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function toAbs(href) {
  try {
    return new URL(String(href || ""), "https://www.yahoo.com").toString();
  } catch {
    return null;
  }
}

function isStoryUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/(^|\.)yahoo\.com$/i.test(u.hostname)) return false;
    const p = String(u.pathname || "");
    if (!/^\/[a-z0-9-]+\/[a-z0-9-]+/i.test(p) && !/^\/news\/articles\//i.test(p)) return false;
    return true;
  } catch {
    return false;
  }
}

function scoreCandidate(c) {
  let score = 0;
  if (c.secStrm) score += 180;
  if (c.ctStory) score += 120;
  if (c.elmHdln) score += 120;
  if (c.stretched) score += 25;
  if (Number.isFinite(c.mpos)) score += Math.max(0, 140 - (c.mpos * 20));
  if (Number.isFinite(c.cpos)) score += Math.max(0, 70 - (c.cpos * 8));
  if (c.title.length >= 20 && c.title.length <= 220) score += 15;
  return score;
}

function extractTopStoryFromHtml(html) {
  const $ = cheerio.load(html);
  const selectors = [
    'a[data-ylk*="sec:strm"][data-ylk*="ct:story"][data-ylk*="elm:hdln"][href]',
    'main a[data-ylk*="ct:story"][href]',
    'a[data-ylk][href]',
  ];

  const seen = new Set();
  const ranked = [];

  for (const sel of selectors) {
    $(sel).each((_i, el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if ($(el).parents("nav,header,footer,[role='navigation']").length) return;

      const href = $(el).attr("href") || "";
      const ylk = $(el).attr("data-ylk") || "";
      const url = toAbs(href);
      const title =
        normalizeSpaces($(el).find("span").first().text()) ||
        normalizeSpaces($(el).attr("aria-label")) ||
        normalizeSpaces($(el).text());
      if (!url || !title || !isStoryUrl(url)) return;

      const candidate = {
        url,
        title,
        secStrm: ylk.includes("sec:strm"),
        ctStory: ylk.includes("ct:story"),
        elmHdln: ylk.includes("elm:hdln"),
        stretched: (($(el).attr("class") || "").includes("stretched-box")),
        mpos: Number((ylk.match(/(?:^|;)mpos:(\d+)/) || [])[1] || NaN),
        cpos: Number((ylk.match(/(?:^|;)cpos:(\d+)/) || [])[1] || NaN),
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
  const html = fs.readFileSync("yahoo.html", "utf8");
  const top = extractTopStoryFromHtml(html);

  assert(top, "Expected a Yahoo top story candidate");
  assert(
    top.url.includes("/entertainment/celebrity/article/eric-dane-greys-anatomy-and-euphoria-star-dies-at-53-nearly-1-year-after-revealing-als-diagnosis-023808459.html"),
    `Unexpected top URL: ${top.url}`,
  );
  assert(
    /Eric Dane, 'Grey's Anatomy' and 'Euphoria' star, dies at 53/i.test(top.title),
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

  const notBlocked = detectBlocked({ httpStatus: 200, pageTitle: "Yahoo" });
  assert(notBlocked.blocked === false, "Expected non-blocked case to be false");

  console.log("Yahoo scraper tests passed.");
  console.log(`Top story: ${top.title} -> ${top.url}`);
}

try {
  run();
} catch (err) {
  console.error("Yahoo scraper tests failed:", String(err?.message || err));
  process.exit(1);
}
