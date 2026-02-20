import fs from "fs";
import * as cheerio from "cheerio";

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function toAbs(href) {
  try {
    return new URL(String(href || ""), "https://www.bbc.com").toString();
  } catch {
    return null;
  }
}

function isStoryUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/(^|\.)bbc\.com$|(^|\.)bbc\.co\.uk$/i.test(u.hostname)) return false;
    const path = String(u.pathname || "");
    if (!path.startsWith("/news/")) return false;
    if (/^\/news\/?$/i.test(path)) return false;
    if (/^\/news\/(videos|av|topics|special-reports)(\/|$)/i.test(path)) return false;
    if (/^\/news\/articles\/[a-z0-9]+$/i.test(path)) return true;
    if (/^\/news\/live\/[a-z0-9\/-]+$/i.test(path)) return true;
    if (/^\/news\/[a-z-]+-\d+$/i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function isLive(url) {
  return /\/news\/live\//i.test(String(url || ""));
}

function isVideo(url) {
  return /\/news\/(videos|av)\//i.test(String(url || ""));
}

function scoreCandidate(c) {
  let score = 0;
  if (/\/news\/articles\//i.test(c.url)) score += 220;
  if (isLive(c.url)) score += 120;
  if (c.hasLiveBadge) score += 140;
  if (/^https?:\/\/(www\.)?bbc\.(com|co\.uk)\/news\/[a-z-]+-\d+$/i.test(c.url)) score += 80;
  if (c.hasHeadline) score += 60;
  if (c.inMain) score += 60;
  if (c.title.length >= 24 && c.title.length <= 240) score += 16;
  if (isVideo(c.url)) score -= 220;
  return score;
}

function extractTopStoryFromHtml(html) {
  const $ = cheerio.load(html);
  const hasLiveBadge = (el) =>
    $(el).find('[data-testid="live-icon-svg-styled"],[data-testid*="live-icon"]').length > 0 ||
    $(el)
      .find("span")
      .toArray()
      .some((s) => normalizeSpaces($(s).text()).toUpperCase() === "LIVE");
  const selectors = [
    'main a[data-testid="external-anchor"][href*="/news/live/"]',
    'main a[href*="/news/live/"]',
    'main a[data-testid="internal-link"][href*="/news/articles/"]',
    'main a[data-testid="internal-link"][href*="/news/live/"]',
    'main a[data-testid="internal-link"][href^="/news/"]',
    'a[data-testid="external-anchor"][href*="/news/live/"]',
    'a[href*="/news/live/"]',
    'a[data-testid="internal-link"][href*="/news/articles/"]',
    'a[data-testid="internal-link"][href*="/news/live/"]',
    'a[data-testid="internal-link"][href^="/news/"]',
  ];

  const seen = new Set();
  const ranked = [];

  for (const sel of selectors) {
    $(sel).each((_i, el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const href = $(el).attr("href") || "";
      const url = toAbs(href);
      const title =
        normalizeSpaces($(el).find('[data-testid="card-headline"]').first().text()) ||
        normalizeSpaces($(el).find("h1,h2,h3").first().text()) ||
        normalizeSpaces($(el).attr("aria-label")) ||
        normalizeSpaces($(el).text());
      if (!url || !title || !isStoryUrl(url)) return;
      const candidate = {
        url,
        title,
        hasLiveBadge: hasLiveBadge(el),
        hasHeadline: $(el).find('[data-testid="card-headline"],h1,h2,h3').length > 0,
        inMain: $(el).parents("main").length > 0,
      };
      ranked.push({ ...candidate, score: scoreCandidate(candidate) });
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const topAny = ranked[0];
  const topArticle = ranked.find((r) => !isLive(r.url)) || null;
  if (isLive(topAny.url) && topAny.hasLiveBadge) return topAny;
  return topArticle && topArticle.score >= topAny.score - 25 ? topArticle : topAny;
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
  const html = fs.readFileSync("bbc.html", "utf8");
  const top = extractTopStoryFromHtml(html);

  assert(top, "Expected a BBC top story candidate");
  const isLive = /\/news\/live\//i.test(top.url);
  const isArticle = /\/news\/articles\//i.test(top.url);
  assert(isLive || isArticle, `Expected BBC article or live URL, got: ${top.url}`);
  if (isLive) {
    assert(
      /Trump to speak after Supreme Court struck down global tariffs/i.test(top.title),
      `Expected live-blog headline, got: ${top.title}`,
    );
  } else {
    assert(/^https?:\/\/(www\.)?bbc\.(com|co\.uk)\/news\/articles\/[a-z0-9]+$/i.test(top.url), `Expected BBC article URL, got: ${top.url}`);
    assert(top.title.length >= 24, `Expected non-trivial article headline, got: ${top.title}`);
  }

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

  const notBlocked = detectBlocked({ httpStatus: 200, pageTitle: "BBC Home" });
  assert(notBlocked.blocked === false, "Expected non-blocked case to be false");

  console.log("BBC scraper tests passed.");
  console.log(`Top story: ${top.title} -> ${top.url}`);
}

try {
  run();
} catch (err) {
  console.error("BBC scraper tests failed:", String(err?.message || err));
  process.exit(1);
}
