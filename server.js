// server.js
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";
import { getSupabaseAdmin, hasSupabaseAdmin, SUPABASE_SCREENSHOT_BUCKET, SUPABASE_SCREENSHOT_PUBLIC } from "./lib/supabaseClient.js";
import { captureAndUploadScreenshot, recordScreenshotEvent, pruneOldScreenshots } from "./lib/screenshots.js";

const app = express();
app.use(express.json());
app.use(express.static("."));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const ARCHIVE_DIR = path.join(process.cwd(), "archive");
const CACHE_FILE = path.join(process.cwd(), "cache.json");
const SUPABASE_CONFIG_FILE = path.join(process.cwd(), "docs", "supabase.json");
const SCREENSHOT_RETENTION_HOURS = 12;
const DEBUG_SCREENSHOT = process.env.DEBUG_SCREENSHOT === "1";

const DEFAULT_SCREENSHOT_PROFILE = {
  viewportWidth: 1920,
  viewportHeight: 1080,
  scrollY: 0,
  settleMs: 700,
};

const SCREENSHOT_PROFILES = {
  // aliases
  usatoday1: { viewportHeight: 1500, scrollY: 150, settleMs: 900 },
  lat1: { viewportHeight: 1500, scrollY: 1140, settleMs: 900 },

  // in-repo source IDs
  abc1: { viewportHeight: 1350, scrollY: 630 },
  cbs1: { viewportHeight: 1500, scrollY: 0, settleMs: 900 },
  usat1: { viewportHeight: 1500, scrollY: 150, settleMs: 900 },
  nbc1: { viewportHeight: 1500, scrollY: 0, settleMs: 900 },
  cnn1: { viewportHeight: 1500, scrollY: 1140, settleMs: 900 },
  reuters1: { viewportHeight: 1500, scrollY: 225, settleMs: 900 },
  ap1: { viewportHeight: 1500, scrollY: 705, settleMs: 900 },
  latimes1: { viewportHeight: 1500, scrollY: 1140, settleMs: 900 },
  npr1: { viewportHeight: 1500, scrollY: 0, settleMs: 900 },
};

if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function nowISO() {
  return new Date().toISOString();
}

function cleanText(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return u;
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(obj) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
}

function readSupabaseConfig() {
  try {
    if (!fs.existsSync(SUPABASE_CONFIG_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SUPABASE_CONFIG_FILE, "utf8"));
    if (!raw?.url || !raw?.anonKey) return null;
    return { url: String(raw.url), anonKey: String(raw.anonKey) };
  } catch {
    return null;
  }
}

function pickSupabaseRowValue(row, keys) {
  for (const k of keys) {
    const v = row?.[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && !v.trim()) continue;
    return v;
  }
  return null;
}

function mergeSourceSnapshotRows(older, newer) {
  if (!older) return newer;
  if (!newer) return older;
  return {
    ...older,
    ...newer,
    item: { ...(older?.item || {}), ...(newer?.item || {}) },
  };
}

async function fetchSupabaseRows(cfg, relation, opts = {}) {
  const url = new URL(`/rest/v1/${relation}`, cfg.url);
  url.searchParams.set("select", "*");
  if (opts.order) url.searchParams.set("order", opts.order);
  if (Number.isFinite(opts.limit)) url.searchParams.set("limit", String(opts.limit));

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Supabase ${relation} failed (${resp.status}): ${body.slice(0, 160)}`);
  }

  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

async function loadSupabaseSnapshot() {
  const cfg = readSupabaseConfig();
  if (!cfg) throw new Error("Supabase config missing or invalid");

  const [curRows, histRows] = await Promise.all([
    fetchSupabaseRows(cfg, "v_current_hero_since"),
    fetchSupabaseRows(cfg, "v_history_hero_stories", { order: "last_seen_at.desc", limit: 200 }),
  ]);

  const sources = {};
  for (const row of curRows) {
    const id = String(row?.source_id || row?.id || "").trim();
    if (!id) continue;

    const mapped = {
      ok: row.ok !== false,
      updatedAt: row.observed_at || row.updated_at || row.last_seen_at || null,
      firstSeenAt: pickSupabaseRowValue(row, ["first_seen_at", "firstSeenAt", "since_at", "current_since_at"]),
      secondsInTop: pickSupabaseRowValue(row, ["seconds_in_top", "secondsInTop", "seconds_in_slot", "seconds_in_current"]),
      error: row.error || null,
      runId: row.run_id || null,
      sourceName: row.source_name || row.sourceName || row.name || null,
      changeType: row.change_type || row.changeType || null,
      isStale: Boolean(row.is_stale ?? row.isStale ?? false),
      lastChangeAt: row.last_change_at || row.lastChangeAt || null,
      item: {
        title: row.title || null,
        url: row.url || null,
        imgUrl: row.img_url || row.imgUrl || null,
      },
    };
    sources[id] = mergeSourceSnapshotRows(sources[id], mapped);
  }

  const history = { generatedAt: nowISO(), sources: {} };
  for (const row of histRows) {
    const id = String(pickSupabaseRowValue(row, ["source_id", "source", "id"]) || "").trim();
    if (!id) continue;
    if (!history.sources[id]) history.sources[id] = { entries: [] };

    history.sources[id].entries.push({
      url: pickSupabaseRowValue(row, ["url", "story_url", "hero_url", "link", "href"]),
      title: pickSupabaseRowValue(row, ["title", "any_title", "story_title", "headline", "hero_title"]),
      imgUrl: pickSupabaseRowValue(row, ["img_url", "any_img_url", "imgUrl", "image_url", "image", "thumb_url", "thumbnail_url"]),
      firstSeenAt: pickSupabaseRowValue(row, ["first_seen_at", "firstSeenAt", "first_seen", "first_seen_ts"]),
      lastSeenAt: pickSupabaseRowValue(row, ["last_seen_at", "lastSeenAt", "last_seen", "observed_at", "updated_at", "updatedAt"]),
      seenCount: pickSupabaseRowValue(row, ["seen_count", "seenCount", "count", "observations"]),
    });
  }

  return {
    generatedAt: nowISO(),
    cacheLike: { generatedAt: nowISO(), sources },
    history,
  };
}

function baseSource(id, name, home_url, kind = "hero") {
  return {
    id,
    name,
    home_url,
    kind,
    created_at: nowISO(),
    updated_at: null,
    ok: false,
    stale: true,
    item: null,
    last: null,
    history: [],
    archive: [],
  };
}

function ensureCacheShape(cache) {
  const c = cache && typeof cache === "object" ? cache : {};
  if (!c.sources || typeof c.sources !== "object") c.sources = {};

  if (!c.sources.abc1) c.sources.abc1 = baseSource("abc1", "ABC News", "https://abcnews.com/", "hero");
  if (!c.sources.cbs1) c.sources.cbs1 = baseSource("cbs1", "CBS News", "https://www.cbsnews.com/", "hero");
  if (!c.sources.usat1) c.sources.usat1 = baseSource("usat1", "USA Today", "https://www.usatoday.com/", "hero");
  if (!c.sources.nbc1) c.sources.nbc1 = baseSource("nbc1", "NBC News", "https://www.nbcnews.com/", "hero");
  if (!c.sources.cnn1) c.sources.cnn1 = baseSource("cnn1", "CNN", "https://www.cnn.com/", "hero");
  if (!c.sources.reuters1) c.sources.reuters1 = baseSource("reuters1", "The Guardian", "https://www.theguardian.com/", "hero");
  if (!c.sources.ap1) c.sources.ap1 = baseSource("ap1", "Associated Press", "https://apnews.com/", "hero");
  if (!c.sources.latimes1) c.sources.latimes1 = baseSource("latimes1", "Los Angeles Times", "https://www.latimes.com/", "hero");
  if (!c.sources.npr1) c.sources.npr1 = baseSource("npr1", "NPR", "https://www.npr.org/", "hero");

  return c;
}

async function withBrowser(fn, opts = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    userAgent: opts.mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function classifyScreenshotKind(prevItem, nextItem) {
  const prevUrl = String(prevItem?.url || "");
  const nextUrl = String(nextItem?.url || "");
  const prevTitle = String(prevItem?.title || "");
  const nextTitle = String(nextItem?.title || "");

  if (!nextUrl) return "heartbeat";
  if (!prevUrl || prevUrl !== nextUrl) return "new_url";
  if (prevTitle !== nextTitle) return "new_headline";
  return "heartbeat";
}

function screenshotProfileFor(sourceId) {
  const id = String(sourceId || "").toLowerCase();
  return {
    ...DEFAULT_SCREENSHOT_PROFILE,
    ...(SCREENSHOT_PROFILES[id] || {}),
  };
}

async function captureTimelineShot(page, { sourceId, runId, tsIso, item }) {
  if (!item) return null;
  const profile = screenshotProfileFor(sourceId);
  if (DEBUG_SCREENSHOT) {
    console.log("[screenshot] source", sourceId, "profile", profile);
  }
  return await captureAndUploadScreenshot({
    page,
    sourceId,
    runId,
    tsIso,
    profile: { ...profile, debug: DEBUG_SCREENSHOT },
  });
}

async function archiveRun(page, runId, snapshot) {
  try {
    const htmlPath = path.join(ARCHIVE_DIR, `${runId}.html`);
    const jsonPath = path.join(ARCHIVE_DIR, `${runId}.json`);
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, "utf8");
    fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");

    return {
      runId,
      html: `/archive/${runId}.html`,
      json: `/archive/${runId}.json`,
    };
  } catch {
    return null;
  }
}

/* ---------------------------
   ABC (single top item)
--------------------------- */
async function scrapeABCHero() {
  return await withBrowser(async (page) => {
    const runId = `abc_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://abcnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://abcnews.com").toString();
        } catch {
          return null;
        }
      }

      // ABC: try prism linkbase blocks first
      const a = document.querySelector('[data-testid="prism-linkbase"]');
      if (a) {
        const href = a.getAttribute("href") || "";
        const title = clean(a.getAttribute("aria-label") || a.textContent || "");
        const url = href ? abs(href) : null;
        if (title && url) return { ok: true, title, url };
      }

      // Fallback: first strong h1/h2 with link
      const main = document.querySelector("main") || document.body;
      const headings = Array.from(main.querySelectorAll("h1, h2, h3"));
      for (const h of headings) {
        const a2 = h.closest("a[href]") || h.querySelector("a[href]");
        const title = clean(h.textContent || "");
        const href = a2?.getAttribute("href") || null;
        const url = href ? abs(href) : null;
        if (!title || title.length < 12) continue;
        if (!url) continue;
        return { ok: true, title, url };
      }

      return { ok: false, error: "ABC not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("abc1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "abc1", runId, tsIso: fetchedAt, item });
    const snapshot = { id: "abc1", fetchedAt, runId, ok: Boolean(item), error: item ? null : (hero?.error || "ABC not found"), item, shot };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item, shot };
  });
}

/* ---------------------------
   CBS (single top item) - "Latest news" module, prefer real articles
--------------------------- */
async function scrapeCBSHero() {
  return await withBrowser(async (page) => {
    const runId = `cbs_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cbsnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.cbsnews.com").toString();
        } catch {
          return null;
        }
      }

      // Prefer an h4 item__hed (your target)
      const h4 = document.querySelector("h4.item__hed");
      if (h4) {
        const a = h4.closest("a[href]") || h4.parentElement?.querySelector("a[href]");
        const title = clean(h4.textContent || "");
        const href = a?.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        if (title && url) return { ok: true, title, url };
      }

      // Fallback: first reasonable headline element with a link
      const candidates = Array.from(document.querySelectorAll("h1, h2, h3, h4")).slice(0, 60);
      for (const h of candidates) {
        const title = clean(h.textContent || "");
        if (!title || title.length < 12) continue;
        const a = h.closest("a[href]") || h.querySelector("a[href]");
        const href = a?.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        if (!url) continue;
        if (!/\/news\//i.test(url) && !/cbsnews\.com\//i.test(url)) continue;
        return { ok: true, title, url };
      }

      return { ok: false, error: "CBS not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("cbs1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "cbs1", runId, tsIso: fetchedAt, item });
    const snapshot = { id: "cbs1", fetchedAt, runId, ok: Boolean(item), error: item ? null : (hero?.error || "CBS not found"), item, shot };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item, shot };
  });
}

/* ---------------------------
   NBC (single top item)
--------------------------- */
async function scrapeNBCHero() {
  return await withBrowser(async (page) => {
    const runId = `nbc_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.nbcnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.nbcnews.com").toString();
        } catch {
          return null;
        }
      }

      function isStoryUrl(url) {
        if (!url) return false;
        if (!/^https?:\/\/(www\.)?nbcnews\.com\//i.test(url)) return false;
        if (/\/(account|search|tips|newsletters|video\/shorts)(\/|$)/i.test(url)) return false;
        return true;
      }

      function inBlockedChrome(el) {
        return Boolean(
          el.closest(
            "header,nav,footer,aside,[role='navigation'],.layout-header,.menu-overlay-wrapper,.shortcuts,.share-list,.headline-container",
          ),
        );
      }

      function scoreAnchor(a, title, url) {
        let score = 0;
        if (a.closest(".headline-item-container, .headline-large, .multistoryline__headline")) score += 100;
        if (a.closest("h1,h2,h3")) score += 25;
        if (a.closest("main")) score += 30;
        if (a.getAttribute("tabindex") === "-1") score += 12;
        if (/\/live-blog\//i.test(url)) score += 60;
        if (/-rcna\d+/i.test(url)) score += 20;
        if (/\/(us-news|world|politics|news|sports|business|health|science)\//i.test(url)) score += 20;
        if (title.length >= 20 && title.length <= 220) score += 12;
        if (inBlockedChrome(a)) score -= 150;
        if (/^\s*(Olympics|Politics|U\.?S\.?\s*News|World|Health|Sports|Local|Business|Science)\s*$/i.test(title)) score -= 120;
        if (/watch live|newsletter/i.test(title)) score -= 30;
        return score;
      }

      const seen = new Set();
      const anchors = [];
      const selectors = [
        "h2.multistoryline__headline a[href]",
        ".headline-item-container .headline-large h2 a[href]",
        "[data-testid*='storyline'] h2 a[href]",
        "a[href*='/live-blog/'][href]",
        "h1 a[href], h2 a[href], h3 a[href]",
        "main a[href]",
      ];

      for (const sel of selectors) {
        for (const a of Array.from(document.querySelectorAll(sel))) {
          if (seen.has(a)) continue;
          seen.add(a);
          anchors.push(a);
        }
      }

      const ranked = anchors
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          const title = clean(a.textContent || a.getAttribute("aria-label") || "");
          if (!url || !title || !isStoryUrl(url)) return null;
          return { title, url, score: scoreAnchor(a, title, url) };
        })
        .filter((x) => x && x.score > -10)
        .sort((a, b) => b.score - a.score);

      if (ranked.length) {
        const top = ranked[0];
        return { ok: true, title: top.title, url: top.url };
      }

      // Fallback: parse inline JSON blobs when DOM classes shift.
      const scripts = Array.from(document.querySelectorAll("script"));
      for (const s of scripts) {
        const txt = s.textContent || "";
        if (!txt || txt.length < 2000) continue;
        const re = /"headline":"([^"]{12,240})"[\s\S]{0,600}?"url":\{"primary":"(https:\\\/\\\/www\.nbcnews\.com\\\/[^"]+)"/g;
        let m;
        while ((m = re.exec(txt))) {
          const title = clean(m[1]);
          const raw = m[2].replace(/\\\//g, "/").replace(/\\u0026/g, "&");
          const url = abs(raw);
          if (!url || !title || !isStoryUrl(url)) continue;
          return { ok: true, title, url };
        }
      }

      return { ok: false, error: "NBC: top story not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("nbc1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "nbc1", runId, tsIso: fetchedAt, item });
    const snapshot = { id: "nbc1", fetchedAt, runId, ok: Boolean(item), error: item ? null : (hero?.error || "NBC not found"), item, shot };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item, shot };
  });
}

/* ---------------------------
   CNN (single top item) - lead-package container + title
--------------------------- */
async function scrapeCNNHero() {
  return await withBrowser(async (page) => {
    const runId = `cnn1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cnn.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.cnn.com").toString();
        } catch {
          return null;
        }
      }

      // Target the specific h2 you mentioned: container__title_url-text container_lead-package__title_url-text
      const h2 = document.querySelector("h2.container__title_url-text.container_lead-package__title_url-text[data-editable='title']");
      if (h2) {
        const title = clean(h2.textContent || "");
        const a = h2.closest("a[href]");
        const href = a?.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        if (title && url) return { ok: true, title, url };
      }

      // Fallback: look for any lead-package container with title
      const container = document.querySelector(".container.container_lead-package[data-layout='container_lead-package']");
      if (container) {
        const titleEl = container.querySelector("h2.container__title_url-text[data-editable='title']");
        const title = clean(titleEl?.textContent || "");
        const a = container.querySelector('a.container__title-url[href]');
        const href = a?.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        if (title && url) return { ok: true, title, url };
      }

      // Final fallback: use container attributes
      const lead = document.querySelector(".container.container_lead-package");
      if (lead) {
        const title = clean(lead.getAttribute("data-title") || lead.getAttribute("data-collapsed-text") || "");
        const a = lead.querySelector('a[href]');
        const href = a?.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        if (title && url) return { ok: true, title, url };
      }

      return { ok: false, error: "CNN: headline not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("cnn1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "cnn1", runId, tsIso: fetchedAt, item });
    const snapshot = { id: "cnn1", fetchedAt, runId, ok: Boolean(item), error: item ? null : (hero?.error || "CNN not found"), item, shot };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item, shot };
  });
}

/* ---------------------------
   The Guardian (single top item) - main headline card
--------------------------- */
async function scrapeReutersHero() {
  return await withBrowser(async (page) => {
    const runId = `reuters1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.theguardian.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.theguardian.com").toString();
        } catch {
          return null;
        }
      }

      // Guardian: Look for main news cards with data-link-name containing "news | group"
      const newsCards = Array.from(document.querySelectorAll('a[data-link-name*="news | group"][href*="/us-news/"], a[data-link-name*="news | group"][href*="/world/"], a[data-link-name*="news | group"][href*="/politics/"]'))
        .map(a => {
          const title = clean(a.getAttribute('aria-label') || a.querySelector('.headline-text')?.textContent || '');
          const href = a.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          return { a, title, url };
        })
        .filter(item => item.title && item.url && item.title.length > 15);

      if (newsCards.length > 0) {
        const first = newsCards[0];
        return { ok: true, title: first.title, url: first.url };
      }

      // Fallback: any card with headline-text
      const headlineCards = Array.from(document.querySelectorAll('.headline-text'))
        .map(span => {
          const a = span.closest('a[href]');
          const title = clean(span.textContent || '');
          const href = a?.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          return { title, url };
        })
        .filter(item => item.title && item.url && item.title.length > 15);

      if (headlineCards.length > 0) {
        const first = headlineCards[0];
        return { ok: true, title: first.title, url: first.url };
      }

      return { ok: false, error: "Guardian: no headline found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("reuters1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "reuters1", runId, tsIso: fetchedAt, item });
    const snapshot = {
      id: "reuters1",
      fetchedAt,
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "The Guardian not found"),
      item,
      shot,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item, shot };
  });
}

/* ---------------------------
   USA Today (single top item)
--------------------------- */
async function scrapeUSATHero() {
  return await withBrowser(async (page) => {
    const runId = `usat1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.usatoday.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      function absUrl(h) {
        try {
          return new URL(h, "https://www.usatoday.com").toString();
        } catch {
          return null;
        }
      }

      function pickFromSrcset(srcset) {
        if (!srcset) return null;
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            const [url, w] = p.split(/\s+/);
            const n = Number(String(w || "").replace("w", "")) || 0;
            return { url, w: n };
          })
          .filter((x) => x.url);
        if (!parts.length) return null;
        parts.sort((a, b) => b.w - a.w);
        return parts[0].url;
      }

      // USAT often uses a top hero link with a shadow-region title span.
      const a =
        document.querySelector('a:has(span[data-tb-shadow-region-title="0"])') ||
        document.querySelector('a:has(span[data-tb-title])') ||
        document.querySelector("a.gnt_m_he") ||
        null;

      if (!a) return { ok: false, error: "USAT: hero anchor not found" };

      const href = a.getAttribute("href") || "";
      const url = href ? absUrl(href) : null;

      const span =
        a.querySelector('span[data-tb-shadow-region-title="0"]') ||
        a.querySelector("span[data-tb-title]") ||
        a.querySelector("[data-tb-shadow-region-title]") ||
        a.querySelector("[data-tb-title]") ||
        null;

      const title = clean(span?.textContent || "");

      const img =
        a.querySelector("img.gnt_m_he_i[src], img.gnt_m_he_i[srcset]") ||
        a.querySelector("img[src], img[srcset]") ||
        null;

      let imgUrl = null;
      let imgAlt = null;

      if (img) {
        imgAlt = clean(img.getAttribute("alt") || "") || null;
        imgUrl = absUrl(img.getAttribute("src") || "") || null;
        if (!imgUrl) {
          const fromSet = pickFromSrcset(img.getAttribute("srcset") || "");
          imgUrl = fromSet ? absUrl(fromSet) : null;
        }
      }

      const dek = clean(a.getAttribute("data-c-br") || "") || null;

      return {
        ok: Boolean(title && url),
        title,
        url,
        imgUrl,
        imgAlt,
        dek,
        debug: {
          href,
          aClass: a.getAttribute("class") || null,
          dataTL: a.getAttribute("data-t-l") || null,
          pickedSpanHasShadow0: Boolean(a.querySelector('span[data-tb-shadow-region-title="0"]')),
        },
      };
    });

    // Optional: og:image fallback if tile doesn't expose image url
    let finalUrl = hero?.url ? normalizeUrl(hero.url) : null;
    let finalTitle = cleanText(hero?.title || "");
    let finalImgUrl = hero?.imgUrl ? normalizeUrl(hero.imgUrl) : null;

    if (hero?.ok && finalUrl && !finalImgUrl) {
      try {
        const r = await page.request.get(finalUrl, { timeout: 20000 });
        const html = await r.text();
        const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
        if (m?.[1]) finalImgUrl = normalizeUrl(m[1]);
      } catch {}
    }

    const item = hero?.ok
      ? {
          title: finalTitle,
          url: finalUrl,
          imgUrl: finalImgUrl,
          imgAlt: hero?.imgAlt || null,
          dek: hero?.dek || null,
          slotKey: sha1("usat|hero").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "usat1", runId, tsIso: fetchedAt, item });
    const snapshot = {
      id: "usat1",
      fetchedAt,
      runId,
      item,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "USAT not found"),
      debug: hero?.debug || null,
      shot,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return {
      ok: Boolean(item),
      error: snapshot.error,
      updatedAt: nowISO(),
      runId,
      archive,
      item,
      shot,
    };
  });
}

/* ---------------------------
   Associated Press (single top item)
--------------------------- */
async function scrapeAPHero() {
  return await withBrowser(async (page) => {
    const runId = `ap1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://apnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://apnews.com").toString();
        } catch {
          return null;
        }
      }

      function isStoryUrl(url) {
        return Boolean(url && /^https?:\/\/(www\.)?apnews\.com\/article\//i.test(url));
      }

      function scoreAnchor(a, title, url) {
        let score = 0;
        if (a.closest(".PageListStandardE-leadPromo-info")) score += 90;
        if (a.closest(".PagePromo-title, h1, h2, h3")) score += 40;
        if (a.querySelector('span[data-tb-shadow-region-title="0"]')) score += 35;
        if (a.querySelector("span.PagePromoContentIcons-text")) score += 20;
        if (/\/article\//i.test(url)) score += 15;
        if (title.length >= 24 && title.length <= 240) score += 12;
        if (a.closest(".PagePromo-description, .Trending")) score -= 45;
        return score;
      }

      const seen = new Set();
      const anchors = [];
      const selectors = [
        '.PageListStandardE-leadPromo-info h3.PagePromo-title a.Link[href]',
        '.PageListStandardE-leadPromo-info .PagePromo-title a.Link[href]',
        'a.Link[href] span.PagePromoContentIcons-text[data-tb-shadow-region-title="0"]',
        ".PagePromo-title a.Link[href]",
        "main a.Link[href]",
      ];

      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const a = el.tagName === "A" ? el : el.closest("a[href]");
          if (!a || seen.has(a)) continue;
          seen.add(a);
          anchors.push(a);
        }
      }

      const ranked = anchors
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          const title =
            clean(a.querySelector('span[data-tb-shadow-region-title="0"]')?.textContent || "") ||
            clean(a.querySelector("span.PagePromoContentIcons-text")?.textContent || "") ||
            clean(a.getAttribute("aria-label") || "") ||
            clean(a.textContent || "");
          if (!url || !title || !isStoryUrl(url)) return null;
          return { title, url, score: scoreAnchor(a, title, url) };
        })
        .filter((x) => x && x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (ranked.length) {
        const top = ranked[0];
        return { ok: true, title: top.title, url: top.url };
      }

      return { ok: false, error: "AP: top story not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("ap1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "ap1", runId, tsIso: fetchedAt, item });
    const snapshot = {
      id: "ap1",
      fetchedAt,
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "AP not found"),
      item,
      shot,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item, shot };
  });
}

/* ---------------------------
   Los Angeles Times (single top item)
--------------------------- */
async function scrapeLATimesHero() {
  return await withBrowser(async (page) => {
    const runId = `latimes1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.latimes.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.latimes.com").toString();
        } catch {
          return null;
        }
      }
      function isStoryUrl(url) {
        if (!url) return false;
        if (!/^https?:\/\/(www\.)?latimes\.com\//i.test(url)) return false;
        if (!/\/story\//i.test(url)) return false;
        if (/\/b2b\//i.test(url)) return false;
        return true;
      }

      const seen = new Set();
      const anchors = [];
      const selectors = [
        "main h1.promo-title a.link[href*='/story/']",
        "main h1 a.link[href*='/story/']",
        "main .promo-title a.link[href*='/story/']",
        "main a.link[href*='/story/']",
        "h1.promo-title a.link[href*='/story/']",
      ];

      for (const sel of selectors) {
        for (const a of Array.from(document.querySelectorAll(sel))) {
          if (seen.has(a)) continue;
          seen.add(a);
          anchors.push(a);
        }
      }

      const ranked = anchors
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          const title = clean(a.textContent || a.getAttribute("aria-label") || "");
          if (!url || !title || !isStoryUrl(url)) return null;
          let score = 0;
          if (a.closest("h1")) score += 80;
          if (a.closest(".promo-title")) score += 40;
          if (a.closest("main")) score += 30;
          if (title.length >= 24 && title.length <= 240) score += 10;
          if (a.closest("header,nav,footer,[data-element='page-header'],[data-element='page-subheader']")) score -= 120;
          return { title, url, score };
        })
        .filter((x) => x && x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (ranked.length) {
        const top = ranked[0];
        return { ok: true, title: top.title, url: top.url };
      }

      return { ok: false, error: "LA Times: top story not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("latimes1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "latimes1", runId, tsIso: fetchedAt, item });
    const snapshot = {
      id: "latimes1",
      fetchedAt,
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "LA Times not found"),
      item,
      shot,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item, shot };
  });
}

/* ---------------------------
   NPR (single top item)
--------------------------- */
async function scrapeNPRHero() {
  return await withBrowser(async (page) => {
    const runId = `npr1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.npr.org/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2000);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.npr.org").toString();
        } catch {
          return null;
        }
      }
      function isStoryUrl(url) {
        if (!url) return false;
        if (!/^https?:\/\/(www\.)?npr\.org\//i.test(url)) return false;
        if (!/^https?:\/\/(www\.)?npr\.org\/\d{4}\/\d{2}\/\d{2}\//i.test(url)) return false;
        if (/\/(podcasts?|newsletters?|shop|donate|series|sections|programs|music)(\/|$)/i.test(url)) return false;
        return true;
      }

      const seen = new Set();
      const anchors = [];
      const selectors = [
        'a[data-metrics-ga4*="homepage_curation_click"][data-metrics-ga4*="curated story"][data-metrics-ga4*="1.1.1-L"][href]',
        'a[data-metrics-ga4*="homepage_curation_click"][data-metrics-ga4*="curated story"][href]',
        ".story-text a[href]",
        "main a[href]",
      ];

      for (const sel of selectors) {
        for (const a of Array.from(document.querySelectorAll(sel))) {
          if (seen.has(a)) continue;
          seen.add(a);
          anchors.push(a);
        }
      }

      const ranked = anchors
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const metrics = String(a.getAttribute("data-metrics-ga4") || "").toLowerCase();
          const url = href ? abs(href) : null;
          const title =
            clean(a.querySelector("h3.title, h3 .title-inner")?.textContent || "") ||
            clean(a.getAttribute("aria-label") || "") ||
            clean(a.textContent || "");

          if (!url || !title || !isStoryUrl(url)) return null;

          let score = 0;
          if (metrics.includes("homepage_curation_click")) score += 40;
          if (metrics.includes("curated story")) score += 80;
          if (metrics.includes("1.1.1-l")) score += 120;
          if (a.querySelector("h3.title, h3 .title-inner")) score += 35;
          if (a.closest("h1,h2,h3")) score += 20;
          if (a.closest(".story-wrap,.story-text,article,main")) score += 15;
          if (title.length >= 24 && title.length <= 240) score += 10;
          if (a.closest("header,nav,footer,.menu,.navigation,[data-metrics-category-ga4='recirculation']")) score -= 160;

          return { title, url, score };
        })
        .filter((x) => x && x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (ranked.length) {
        const top = ranked[0];
        return { ok: true, title: top.title, url: top.url };
      }

      return { ok: false, error: "NPR: top story not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("npr1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "npr1", runId, tsIso: fetchedAt, item });
    const snapshot = {
      id: "npr1",
      fetchedAt,
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "NPR not found"),
      item,
      shot,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item, shot };
  });
}

/* ---------------------------
   Refresh / API
--------------------------- */
async function refreshSources({ id = "" } = {}) {
  const cache = ensureCacheShape(readCache());
  const which = String(id || "").toLowerCase();
  const runList = which ? [which] : ["abc1", "cbs1", "usat1", "nbc1", "cnn1", "reuters1", "ap1", "latimes1", "npr1"];
  const pruneResult = await pruneOldScreenshots({ hours: SCREENSHOT_RETENTION_HOURS });
  if ((pruneResult?.prunedRows || 0) > 0 || (pruneResult?.deletedObjects || 0) > 0) {
    console.log(`Screenshot prune: rows=${pruneResult.prunedRows || 0}, storage_objects=${pruneResult.deletedObjects || 0}`);
  }

  for (const sid of runList) {
    let res;
    const prevItem = cache.sources?.[sid]?.item || null;

    if (sid === "abc1") res = await scrapeABCHero();
    else if (sid === "cbs1") res = await scrapeCBSHero();
    else if (sid === "usat1") res = await scrapeUSATHero();
    else if (sid === "nbc1") res = await scrapeNBCHero();
    else if (sid === "cnn1") res = await scrapeCNNHero();
    else if (sid === "reuters1") res = await scrapeReutersHero();
    else if (sid === "ap1") res = await scrapeAPHero();
    else if (sid === "latimes1") res = await scrapeLATimesHero();
    else if (sid === "npr1") res = await scrapeNPRHero();
    else throw new Error(`Unknown source id: ${sid}`);

    if (res?.item && res?.shot?.object_path) {
      try {
        const kind = classifyScreenshotKind(prevItem, res.item);
        await recordScreenshotEvent({
          ts: res.updatedAt || nowISO(),
          sourceId: sid,
          runId: res.runId || "",
          kind,
          title: res.item?.title || null,
          url: res.item?.url || null,
          object_path: res.shot.object_path,
          shot_url: res.shot.shot_url || null,
        });
      } catch (err) {
        console.warn(`screenshot_events insert failed (${sid}):`, String(err?.message || err));
      }
    }

    cache.sources[sid] = {
      ...cache.sources[sid],
      updated_at: res.updatedAt || nowISO(),
      ok: Boolean(res.ok),
      stale: !res.ok,
      item: res.item || null,
      last: {
        runId: res.runId || null,
        ok: Boolean(res.ok),
        error: res.error || null,
        fetchedAt: res.updatedAt || nowISO(),
        shot: res.shot || null,
      },
    };

    if (res.archive) {
      cache.sources[sid].archive = cache.sources[sid].archive || [];
      cache.sources[sid].archive.unshift(res.archive);
      cache.sources[sid].archive = cache.sources[sid].archive.slice(0, 30);
    }
  }

  writeCache(cache);
  return cache;
}

app.get("/api/sources", (req, res) => {
  const cache = ensureCacheShape(readCache());
  const sources = Object.values(cache.sources).map((s) => ({
    id: s.id,
    name: s.name,
    home_url: s.home_url,
    kind: s.kind,
    created_at: s.created_at,
  }));
  res.json(sources);
});

app.get("/api/state", (req, res) => {
  const cache = ensureCacheShape(readCache());
  res.json({ ok: true, cache });
});

app.get("/api/supabase-snapshot", async (req, res) => {
  try {
    const snapshot = await loadSupabaseSnapshot();
    res.json({ ok: true, ...snapshot });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/timeline", async (req, res) => {
  try {
    const hoursRaw = Number(req.query?.hours || 12);
    const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(72, Math.floor(hoursRaw))) : 12;
    const source = String(req.query?.source || "").trim();
    const cutoffIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    if (!hasSupabaseAdmin()) {
      return res.json({ ok: true, hours, generatedAt: nowISO(), events: [] });
    }

    const sb = getSupabaseAdmin();
    let q = sb
      .from("screenshot_events")
      .select("ts,source_id,kind,title,url,object_path,shot_url")
      .gte("ts", cutoffIso)
      .order("ts", { ascending: true });

    if (source) q = q.eq("source_id", source);

    const { data, error } = await q;
    if (error) throw error;

    const events = Array.isArray(data) ? data.map((x) => ({ ...x })) : [];

    if (!SUPABASE_SCREENSHOT_PUBLIC) {
      const objectPaths = events.map((e) => e.object_path).filter(Boolean);
      const uniquePaths = [...new Set(objectPaths)];
      const signedByPath = new Map();

      for (let i = 0; i < uniquePaths.length; i += 100) {
        const batch = uniquePaths.slice(i, i + 100);
        const { data: signed, error: signErr } = await sb.storage
          .from(SUPABASE_SCREENSHOT_BUCKET)
          .createSignedUrls(batch, 3600);
        if (signErr) {
          console.warn("timeline signed url generation failed:", signErr.message || signErr);
          continue;
        }
        for (const row of signed || []) {
          if (row?.path && row?.signedUrl) signedByPath.set(row.path, row.signedUrl);
        }
      }

      for (const ev of events) {
        ev.shot_url = signedByPath.get(ev.object_path) || null;
      }
    } else {
      for (const ev of events) {
        if (ev.shot_url) continue;
        const pub = sb.storage.from(SUPABASE_SCREENSHOT_BUCKET).getPublicUrl(ev.object_path || "");
        ev.shot_url = pub?.data?.publicUrl || null;
      }
    }

    res.json({
      ok: true,
      hours,
      generatedAt: nowISO(),
      events: events.map((e) => ({
        ts: e.ts,
        source_id: e.source_id,
        kind: e.kind,
        title: e.title,
        url: e.url,
        shot_url: e.shot_url || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const id = req.body?.id || "";
    const cache = await refreshSources({ id });
    res.json({ ok: true, cache });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/diff", (req, res) => {
  const cache = ensureCacheShape(readCache());
  res.json({ ok: true, cache });
});

async function main() {
  const args = new Set(process.argv.slice(2));

  // CLI mode (GitHub Actions): scrape once, write cache.json, and exit.
  if (args.has("--refresh")) {
    try {
      const cache = await refreshSources({});
      console.log(JSON.stringify({ ok: true, cache }, null, 2));
      process.exit(0);
    } catch (err) {
      console.error("Refresh error:", err);
      process.exit(1);
    }
  }

  // Only start the HTTP server when this file is executed directly.
  if (process.argv[1] && process.argv[1].endsWith("server.js")) {
    app.listen(PORT, () => console.log(`Newsboard server listening on http://localhost:${PORT}`));
  }
}

await main();

export {
  scrapeABCHero,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  scrapeCNNHero,
  scrapeReutersHero,
  scrapeAPHero,
  scrapeLATimesHero,
  scrapeNPRHero,
  refreshSources,
};
