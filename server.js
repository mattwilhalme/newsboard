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
const SCREENSHOT_RETENTION_HOURS = 18;
const DEBUG_SCREENSHOT = process.env.DEBUG_SCREENSHOT === "1";

const DEFAULT_SCREENSHOT_PROFILE = {
  viewportWidth: 1920,
  viewportHeight: 1620,
  scrollY: 0,
  settleMs: 700,
};

const SCREENSHOT_PROFILES = {
  // aliases
  usatoday1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  lat1: { viewportHeight: 2250, scrollY: 300, settleMs: 900 },

  // in-repo source IDs
  abc1: { viewportHeight: 2025, scrollY: 250 },
  cbs1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  usat1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  nbc1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  cnn1: { viewportHeight: 2250, scrollY: 700, settleMs: 900 },
  guardian1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  ap1: { viewportHeight: 2700, scrollY: 0, settleMs: 900 },
  latimes1: { viewportHeight: 2250, scrollY: 120, settleMs: 900 },
  npr1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  bbc1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  fox1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  yahoo1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  // Backwards compatibility aliases
  reuters1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
  wp1: { viewportHeight: 2250, scrollY: 0, settleMs: 900 },
};

if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function nowISO() {
  return new Date().toISOString();
}

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
  try {
    const url = new URL(u);
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
    return u;
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function hashString(str) {
  return crypto.createHash("sha1").update(String(str || "")).digest("hex");
}

function canonicalizeUrl(input) {
  if (!input) return null;
  try {
    const u = new URL(String(input));
    u.hash = "";
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);

    const drop = new Set([
      "gclid",
      "fbclid",
      "dclid",
      "cmpid",
      "icid",
      "ito",
      "mc_cid",
      "mc_eid",
      "ocid",
      "_ga",
      "_gl",
      "spm",
      "wt.mc_id",
    ]);
    for (const key of [...u.searchParams.keys()]) {
      const lk = String(key || "").toLowerCase();
      if (lk.startsWith("utm_") || drop.has(lk)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return null;
  }
}

function inferContentType({ url, title }) {
  const u = String(url || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  if (u.includes("/video") || u.includes("video.")) return "video";
  if (u.includes("/live") || /\blive\b/.test(t)) return "live";
  if (u.includes("/opinion") || u.includes("/editorial")) return "opinion";
  if (u.includes("/analysis")) return "analysis";
  if (u.includes("/photo") || u.includes("/gallery")) return "gallery";
  return "news";
}

function detectBlocked({ httpStatus, finalUrl, pageTitle, errorText }) {
  const status = Number(httpStatus);
  if (status === 403) return { blocked: true, blocked_reason: "http_403" };
  if (status === 429) return { blocked: true, blocked_reason: "http_429" };

  const hay = `${finalUrl || ""} ${pageTitle || ""} ${errorText || ""}`.toLowerCase();
  if (/captcha|are you a robot|verify you are human/.test(hay)) return { blocked: true, blocked_reason: "captcha" };
  if (/consent|gdpr|privacy/.test(hay)) return { blocked: true, blocked_reason: "consent" };
  if (/paywall|subscribe to read/.test(hay)) return { blocked: true, blocked_reason: "paywall" };
  if (/interstitial|access denied|forbidden|blocked/.test(hay)) return { blocked: true, blocked_reason: "interstitial" };
  return { blocked: false, blocked_reason: null };
}

function top10Fingerprint(url, title) {
  const u = String(url || "").trim();
  if (u) return sha1(u);
  const t = cleanText(title || "").toLowerCase();
  return sha1(t || "unknown");
}

function parseUrlSafe(u) {
  try {
    return new URL(String(u || ""));
  } catch {
    return null;
  }
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

const SOURCE_REGISTRY = [
  { id: "abc1", name: "ABC News", home_url: "https://abcnews.com/" },
  { id: "cbs1", name: "CBS News", home_url: "https://www.cbsnews.com/" },
  { id: "usat1", name: "USA Today", home_url: "https://www.usatoday.com/" },
  { id: "nbc1", name: "NBC News", home_url: "https://www.nbcnews.com/" },
  { id: "cnn1", name: "CNN", home_url: "https://www.cnn.com/" },
  { id: "guardian1", name: "The Guardian", home_url: "https://www.theguardian.com/" },
  { id: "ap1", name: "Associated Press", home_url: "https://apnews.com/" },
  { id: "latimes1", name: "Los Angeles Times", home_url: "https://www.latimes.com/" },
  { id: "npr1", name: "NPR", home_url: "https://www.npr.org/" },
  { id: "bbc1", name: "BBC", home_url: "https://www.bbc.com/" },
  { id: "fox1", name: "Fox News", home_url: "https://www.foxnews.com/" },
  { id: "yahoo1", name: "Yahoo News", home_url: "https://news.yahoo.com/" },
];

const SERVER_SOURCE_IDS = SOURCE_REGISTRY.map((s) => s.id);
const UI_EXPECTED_SOURCE_IDS = ["abc1", "cbs1", "usat1", "nbc1", "cnn1", "guardian1", "ap1", "latimes1", "npr1", "bbc1", "fox1", "yahoo1"];

function canonicalServerSourceId(rawId) {
  const s = String(rawId || "").toLowerCase().trim();
  if (!s) return "";
  if (s === "guardian" || s === "reuters1" || s === "reuters") return "guardian1";
  if (s === "yahoo" || s === "wp1" || s === "wp" || s === "wapo" || s === "washingtonpost") return "yahoo1";
  return s;
}

function buildRefreshRunList(id = "") {
  const which = canonicalServerSourceId(id);
  if (!which) return [...SERVER_SOURCE_IDS];
  return SERVER_SOURCE_IDS.includes(which) ? [which] : [];
}

function ensureCacheShape(cache) {
  const c = cache && typeof cache === "object" ? cache : {};
  if (!c.sources || typeof c.sources !== "object") c.sources = {};

  // Migrate legacy IDs to canonical IDs.
  if (c.sources.reuters1 && !c.sources.guardian1) {
    c.sources.guardian1 = { ...c.sources.reuters1, id: "guardian1", name: "The Guardian", home_url: "https://www.theguardian.com/" };
  }
  if (c.sources.wp1 && !c.sources.yahoo1) {
    c.sources.yahoo1 = { ...c.sources.wp1, id: "yahoo1", name: "Yahoo News", home_url: "https://news.yahoo.com/" };
  }
  delete c.sources.reuters1;
  delete c.sources.wp1;

  for (const s of SOURCE_REGISTRY) {
    if (!c.sources[s.id]) c.sources[s.id] = baseSource(s.id, s.name, s.home_url, "hero");
  }

  return c;
}

function logSourceGuardrail() {
  const serverSet = new Set(SERVER_SOURCE_IDS);
  const missingInServer = UI_EXPECTED_SOURCE_IDS.filter((id) => !serverSet.has(id));
  if (missingInServer.length) {
    console.warn(`[guardrail] UI expected IDs missing in server source list: ${missingInServer.join(",")}`);
  }
  const fullRunList = buildRefreshRunList("");
  const notInRefresh = SERVER_SOURCE_IDS.filter((id) => !fullRunList.includes(id));
  if (notInRefresh.length) {
    console.warn(`[guardrail] refreshSources() would skip configured IDs: ${notInRefresh.join(",")}`);
  }
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

function getSupabaseAdminOrNull() {
  if (!hasSupabaseAdmin()) return null;
  try {
    return getSupabaseAdmin();
  } catch {
    return null;
  }
}

function pickHeroSlotKey(item) {
  const raw = String(item?.slotKey || "").trim();
  if (!raw) return "hero:1";
  // Older scrapers may use hashed slot keys; normalize to a stable hero slot.
  if (/^[a-f0-9]{12,40}$/i.test(raw)) return "hero:1";
  return raw;
}

async function insertHeroRun({ sourceId, observedAtIso, runId, item, ok, error, raw }) {
  const sb = getSupabaseAdminOrNull();
  if (!sb) return { inserted: 0, skipped: true };

  const row = {
    source_id: sourceId,
    observed_at: observedAtIso,
    run_id: runId || null,
    title: item?.title || null,
    url: item?.url || null,
    img_url: item?.imgUrl || null,
    ok: Boolean(ok),
    error: error ? String(error) : null,
    raw: raw && typeof raw === "object" ? raw : {},
  };

  const { error: dbErr } = await sb.from("hero_runs").insert(row);
  if (dbErr) throw dbErr;
  return { inserted: 1 };
}

async function insertHeadlineEvent({ sourceId, observedAtIso, slotKey, item, ok, error, raw }) {
  const sb = getSupabaseAdminOrNull();
  if (!sb) return { inserted: 0, skipped: true };

  const row = {
    source_id: sourceId,
    observed_at: observedAtIso,
    slot_key: slotKey || "hero:1",
    title: item?.title || null,
    url: item?.url || null,
    img_url: item?.imgUrl || null,
    ok: Boolean(ok),
    error: error ? String(error) : null,
    raw: raw && typeof raw === "object" ? raw : {},
  };

  const { error: dbErr } = await sb.from("headline_events").insert(row);
  if (dbErr) throw dbErr;
  return { inserted: 1 };
}

async function insertTop10Snapshot({ sourceId, observedAtIso, runId, items, raw }) {
  const sb = getSupabaseAdminOrNull();
  if (!sb) return { inserted: 0, skipped: true };

  const rows = (Array.isArray(items) ? items : [])
    .filter((it) => Number.isFinite(Number(it?.rank)))
    .map((it) => ({
      source_id: sourceId,
      observed_at: observedAtIso,
      slot_key: `top10:${Number(it.rank)}`,
      title: it?.title || null,
      url: it?.url || null,
      img_url: it?.imgUrl || null,
      ok: true,
      error: null,
      raw: {
        ...(raw && typeof raw === "object" ? raw : {}),
        run_kind: "top10",
        run_id: runId || null,
        rank: Number(it.rank),
        fingerprint: it?.fingerprint || null,
        canonical_url: canonicalizeUrl(it?.url || null),
        module: "top10_list",
        content_type: inferContentType({ url: it?.url, title: it?.title }),
      },
    }));

  if (!rows.length) return { inserted: 0 };
  const { error: dbErr } = await sb.from("headline_events").insert(rows);
  if (dbErr) throw dbErr;
  return { inserted: rows.length };
}

/* ---------------------------
   ABC (single top item)
--------------------------- */
async function scrapeABCHero() {
  return await withBrowser(async (page) => {
    const runId = `abc_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    const navResp = await page.goto("https://abcnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
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

      function isVideoLike(url, title, typeHint = "") {
        const u = String(url || "").toLowerCase();
        const t = String(title || "").toLowerCase();
        const h = String(typeHint || "").toLowerCase();
        if (h === "video") return true;
        return (
          /\/video(\/|$)/.test(u) ||
          /\/live(\/|$)/.test(u) ||
          /\babc news live\b/.test(t) ||
          /\blive video\b/.test(t)
        );
      }

      const candidates = [];
      const main = document.querySelector("main") || document.body;
      const prismMatches = main.querySelectorAll('[data-testid="prism-linkbase"]').length;
      const headingMatches = main.querySelectorAll("h1, h2, h3").length;

      function classifyType(url, title, card) {
        const u = String(url || "").toLowerCase();
        const t = String(title || "").toLowerCase();
        const hasLivePill = Boolean(card?.querySelector(".MediaPlaceholder__Pill--live, [data-testid='live-icon-svg-styled']"));
        if (/\/live(\/|$)/.test(u) || /\/live-updates(\/|$)/.test(u)) {
          if (hasLivePill || /\blive blog\b/.test(t)) return "live";
          if (/\babc news live\b/.test(t) || /\blive video\b/.test(t)) return "video";
          return "live";
        }
        if (isVideoLike(url, title)) return "video";
        return "news";
      }

      function pushCandidate(candidate) {
        if (!candidate?.title || !candidate?.url) return;
        candidates.push(candidate);
      }

      // Candidate A: first lead card in main content (article/live/video).
      const heroCards = Array.from(main.querySelectorAll('[data-testid="prism-card"]')).slice(0, 24);
      for (let i = 0; i < heroCards.length; i += 1) {
        const card = heroCards[i];
        if (!card || card.closest("header, nav, footer, [role='navigation']")) continue;

        const link =
          card.querySelector('a[data-testid="prism-linkbase"][href]') ||
          card.querySelector("a[data-testid='prism-meta'][href]") ||
          card.querySelector("a[href]");
        if (!link) continue;
        if (link.matches('[tracking*="breakingnews_banner"]')) continue;

        const href = clean(link.getAttribute("href") || "");
        const url = href ? abs(href) : null;
        if (!url) continue;

        const heading =
          card.querySelector("h1[id*='headline'], h2[id*='headline'], h3[id*='headline'], h1, h2, h3") ||
          link.querySelector("h1, h2, h3") ||
          null;
        const title = clean(
          heading?.textContent ||
            link.getAttribute("aria-label") ||
            link.textContent ||
            card.textContent ||
            ""
        );
        if (!title || title.length < 12) continue;

        const type = classifyType(url, title, card);
        let score = 1500 - (i * 28);
        if (heading?.id && /abcnews-rssource-.*headline/i.test(heading.id)) score += 140;
        if (link.getAttribute("data-testid") === "prism-meta") score -= 40;
        if (/\bwatch live\b/i.test(title)) score -= 220;

        pushCandidate({
          title,
          url,
          contentType: type,
          selector_used: "abc_prism_main_lead",
          score,
          hero_html: link.outerHTML || card.outerHTML || null,
        });
      }

      // Candidate B: first prism linkbase fallback.
      const prismAnchor = main.querySelector('[data-testid="prism-linkbase"][href]');
      if (prismAnchor) {
        const href = prismAnchor.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        const heading = prismAnchor.querySelector("h1, h2, h3");
        const title = clean(heading?.textContent || prismAnchor.getAttribute("aria-label") || prismAnchor.textContent || "");
        pushCandidate({
          title,
          url,
          contentType: classifyType(url, title, prismAnchor.closest('[data-testid="prism-card"]')),
          selector_used: "abc_prism_linkbase",
          score: 900,
          hero_html: prismAnchor.outerHTML || null,
        });
      }

      // Candidate C: explicit live video hero fallback.
      const liveHero =
        document.querySelector(".LiveVideo__Hero") ||
        document.querySelector(".MediaPlaceholder__Pill--live")?.closest("[data-testid='prism-card']");
      if (liveHero) {
        const liveMeta =
          liveHero.closest("[data-testid='prism-card']")?.querySelector("a[data-testid='prism-meta'][href]") ||
          liveHero.querySelector("a[data-testid='prism-meta'][href]") ||
          null;
        const liveH2 = liveHero.closest("[data-testid='prism-card']")?.querySelector("h1[id*='headline'], h2[id*='headline'], h3[id*='headline'], h1, h2, h3") || null;
        const liveHref = liveMeta?.getAttribute("href") || "";
        const liveUrl = liveHref ? abs(liveHref) : null;
        const liveTitle = clean(liveH2?.textContent || liveMeta?.getAttribute("aria-label") || liveMeta?.textContent || "");
        pushCandidate({
          title: liveTitle,
          url: liveUrl,
          contentType: classifyType(liveUrl, liveTitle, liveHero),
          selector_used: "abc_live_video_fallback",
          score: 700,
          hero_html: liveMeta?.outerHTML || liveHero?.outerHTML || null,
        });
      }

      // Candidate D: first strong heading with link.
      for (const h of Array.from(main.querySelectorAll("h1, h2, h3")).slice(0, 40)) {
        const a2 = h.closest("a[href]") || h.querySelector("a[href]");
        const title = clean(h.textContent || "");
        const href = a2?.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        if (!title || title.length < 12 || !url) continue;
        pushCandidate({
          title,
          url,
          contentType: classifyType(url, title, h.closest('[data-testid="prism-card"]')),
          selector_used: "heading_fallback",
          score: 500,
          hero_html: a2?.outerHTML || h?.outerHTML || null,
        });
        break;
      }

      const ranked = candidates
        .filter((c) => c?.title && c?.url)
        .sort((a, b) => (Number(b.score) - Number(a.score)));
      const picked = ranked[0] || null;
      if (!picked) return { ok: false, error: "ABC not found" };

      // Breaking banner: DOM first, then app shell fallback.
      let breakingHeadline = null;
      let breakingUrl = null;
      let hasBreakingBanner = false;

      const breakingDomAnchor =
        document.querySelector('a[tracking*="breakingnews_banner"][href]') ||
        document.querySelector('a[href*="/story/"][tracking*="breaking"]') ||
        null;
      if (breakingDomAnchor) {
        const rawTitle = clean(breakingDomAnchor.textContent || "");
        const rawHref = clean(breakingDomAnchor.getAttribute("href") || "");
        if (rawTitle) {
          hasBreakingBanner = true;
          breakingHeadline = rawTitle.replace(/^breaking\s*/i, "").trim() || rawTitle;
          breakingUrl = rawHref ? abs(rawHref) : null;
        }
      }

      if (!hasBreakingBanner) {
        const shell = window.__abcnews__?.page?.content?.shell || null;
        const bnObj = shell?.bnObj || null;
        const bnStory = shell?.bnStory || null;
        const showBanner =
          typeof bnObj?.displayBanner === "boolean"
            ? Boolean(bnObj.displayBanner)
            : Boolean(bnObj?.text || bnStory?.locator);
        if (showBanner) {
          const txt = clean(bnObj?.text || bnObj?.video?.headline || "");
          const loc = clean(bnObj?.link || bnStory?.locator || "");
          if (txt || loc) {
            hasBreakingBanner = true;
            breakingHeadline = txt || null;
            breakingUrl = loc ? abs(loc) : null;
          }
        }
      }

      return {
        ok: true,
        title: picked.title,
        url: picked.url,
        contentType: picked.contentType || "news",
        selector_used: picked.selector_used || null,
        candidates: {
          primary: prismMatches,
          fallback: headingMatches,
          ranked: ranked.length,
        },
        hero_html: picked.hero_html || null,
        breakingHeadline,
        breakingUrl,
        hasBreakingBanner,
      };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          contentType: hero?.contentType || "news",
          breakingLabel: hero?.hasBreakingBanner ? "Breaking News" : null,
          breakingHeadline: cleanText(hero?.breakingHeadline || "") || null,
          breakingUrl: hero?.breakingUrl ? normalizeUrl(hero.breakingUrl) : null,
          slotKey: sha1("abc1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "abc1", runId, tsIso: fetchedAt, item });
    const snapshot = { id: "abc1", fetchedAt, runId, ok: Boolean(item), error: item ? null : (hero?.error || "ABC not found"), item, shot };
    const archive = await archiveRun(page, runId, snapshot);
    const pageTitle = await page.title().catch(() => null);

    return {
      ok: Boolean(item),
      error: snapshot.error,
      updatedAt: nowISO(),
      runId,
      archive,
      item,
      shot,
      meta: {
        run_kind: "hero",
        profile: "desktop",
        final_url: page.url() || null,
        http_status: navResp?.status?.() ?? null,
        page_title: pageTitle || null,
        selector_used: hero?.selector_used || null,
        candidates: hero?.candidates || null,
        hero_html: hero?.hero_html || null,
      },
    };
  });
}

async function scrapeABCTop10() {
  return await withBrowser(async (page) => {
    const runId = `abc_top10_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const navResp = await page.goto("https://abcnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const extracted = await page.evaluate(() => {
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
    });

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

    const observedAt = nowISO();
    const ok = items.length >= 10;
    const pageTitle = await page.title().catch(() => null);
    return {
      ok,
      sourceId: "abc1",
      observedAt,
      updatedAt: observedAt,
      runId,
      error: ok ? null : `Expected 10 stories, found ${items.length}`,
      items,
      meta: {
        run_kind: "top10",
        profile: "desktop",
        final_url: page.url() || null,
        http_status: navResp?.status?.() ?? null,
        page_title: pageTitle || null,
        selector_used: extracted?.selector_used || null,
        candidates: extracted?.candidates || null,
      },
    };
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

      function isArticleLikeUrl(url) {
        if (!url) return false;
        if (/\/live-blog\//i.test(url)) return true;
        if (/-rcna\d+/i.test(url)) return true;
        if (/\/\d{4}\/\d{2}\/\d{2}\//i.test(url)) return true;
        return false;
      }

      function canonicalUrl(url) {
        try {
          const u = new URL(String(url || ""));
          u.hash = "";
          // Keep query because NBC sometimes uses campaign params for same story;
          // canonical comparison below strips it explicitly.
          const bare = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
          return bare.toLowerCase();
        } catch {
          return String(url || "").trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
        }
      }

      function isWeakTitle(title) {
        const t = clean(String(title || ""));
        if (!t) return true;
        if (t.length < 12) return true;
        if (/^(live|live updates|latest stories|updates|watch live)$/i.test(t)) return true;
        return false;
      }

      function pickString(v) {
        if (!v) return "";
        if (typeof v === "string") return clean(v);
        if (typeof v === "object") {
          if (typeof v.text === "string") return clean(v.text);
          if (typeof v.primary === "string") return clean(v.primary);
        }
        return "";
      }

      function pickUrl(v) {
        if (!v) return null;
        if (typeof v === "string") return abs(v);
        if (typeof v === "object") {
          if (typeof v.primary === "string") return abs(v.primary);
          if (typeof v.canonical === "string") return abs(v.canonical);
        }
        return null;
      }

      function refineTitleForUrl(url, fallbackTitle) {
        const target = canonicalUrl(url || "");
        if (!target) return clean(fallbackTitle || "");

        // Prefer structured JSON payload title when visible anchor text is generic.
        try {
          const nextDataEl = document.querySelector("script#__NEXT_DATA__");
          const raw = nextDataEl?.textContent || "";
          if (raw && raw.length > 5000) {
            const payload = JSON.parse(raw);
            const layouts = payload?.props?.initialState?.front?.curation?.layouts || [];
            for (const layout of layouts) {
              for (const pkg of (layout?.packages || [])) {
                for (const it of (pkg?.items || [])) {
                  const item = it?.item || {};
                  const computed = it?.computedValues || item?.computedValues || {};
                  const u = pickUrl(computed?.url) || pickUrl(item?.url) || null;
                  if (!u || canonicalUrl(u) !== target) continue;
                  const title =
                    pickString(computed?.headline) ||
                    pickString(item?.headline) ||
                    pickString(item?.headlineAlternatives?.[0]) ||
                    "";
                  if (title && !isWeakTitle(title)) return title;
                }
              }
            }
          }
        } catch {}

        // Fallback: inspect large inline script blobs for headline/url pairs.
        try {
          const scripts = Array.from(document.querySelectorAll("script"));
          for (const s of scripts) {
            const txt = s.textContent || "";
            if (!txt || txt.length < 2000) continue;
            const re = /"headline":"([^"]{8,260})"[\s\S]{0,800}?"url":\{"primary":"(https:\\\/\\\/www\.nbcnews\.com\\\/[^"]+)"/g;
            let m;
            while ((m = re.exec(txt))) {
              const title = clean(m[1]);
              const rawUrl = m[2].replace(/\\\//g, "/").replace(/\\u0026/g, "&");
              const u = abs(rawUrl);
              if (u && canonicalUrl(u) === target && title && !isWeakTitle(title)) return title;
            }
          }
        } catch {}

        return clean(fallbackTitle || "");
      }

      function isLikelyTopicBanner(a, title, url) {
        const t = String(title || "").toLowerCase();
        const genericTitle = /^(olympics|politics|u\.?s\.?\s*news|world|health|sports|business|science|latest stories|live updates|calendar|newsletter|medal tracker)$/i.test(
          String(title || "").trim(),
        );
        const utilityTitle = /(live updates|latest stories|calendar|newsletter|medal tracker|stream on peacock|watch live)/i.test(t);
        const hubUrl = /\/collection\//i.test(url || "");
        const sectionUrl = /^https?:\/\/(www\.)?nbcnews\.com\/(olympics|politics|us-news|world|health|sports|business|science|tech-media)(\/)?$/i.test(
          url || "",
        );
        const inTopicChrome = Boolean(
          a.closest(
            "[data-testid*='subnav'], [class*='subnav'], [class*='Subnav'], [data-testid*='navigation'], [class*='navigation'], [class*='category-nav']",
          ),
        );
        if (genericTitle || utilityTitle || sectionUrl) return true;
        if (hubUrl && !isArticleLikeUrl(url || "")) return true;
        if (inTopicChrome && !isArticleLikeUrl(url || "")) return true;
        return false;
      }

      function inBlockedChrome(el) {
        return Boolean(
          el.closest(
            "header,nav,footer,aside,[role='navigation'],.layout-header,.menu-overlay-wrapper,.shortcuts,.share-list,.headline-container",
          ),
        );
      }

      function scoreAnchor(a, title, url, topY, isBanner) {
        let score = 0;
        if (a.closest(".headline-item-container, .headline-large, .multistoryline__headline")) score += 100;
        if (a.closest("h1,h2,h3")) score += 25;
        if (a.closest("main")) score += 30;
        if (a.getAttribute("tabindex") === "-1") score += 12;
        if (/\/live-blog\//i.test(url)) score += 28;
        if (isArticleLikeUrl(url)) score += 35;
        if (/-rcna\d+/i.test(url)) score += 20;
        if (/\/(us-news|world|politics|news|sports|business|health|science)\//i.test(url)) score += 20;
        if (Number.isFinite(topY)) {
          if (topY < 900) score += 65;
          else if (topY < 1600) score += 30;
        }
        if (title.length >= 20 && title.length <= 220) score += 12;
        if (inBlockedChrome(a)) score -= 150;
        if (isBanner) score -= 170;
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

      // Strategy 1: first full lead headline after top header/nav boundary.
      // NBC frequently shifts modules; this targets the first article lead area below quick-links/header.
      const quickNav = document.querySelector("nav.quick-links, nav[data-activity-map='quick-links'], nav[class*='quickLinks']");
      const headerEnd = document.querySelector("#header-end");
      const firstBoundaryEl = quickNav || headerEnd || document.querySelector("header nav, #globalnav");
      const boundaryRect = firstBoundaryEl?.getBoundingClientRect?.();
      const boundaryY = (Number.isFinite(boundaryRect?.bottom) ? boundaryRect.bottom : 0) + (window.scrollY || 0);

      const leadSelectors = [
        "[data-testid='single-storyline'] .storyline__headline a[href]",
        ".single-storyline .storyline__headline a[href]",
        ".lead-type--Storyline .storyline__headline a[href]",
        ".lead-type--Storyline h2 a[href]",
        "[data-testid='front-container'] h2 a[href]",
        "[data-testid='front-container'] a[href*='/live-blog/']",
        "main a[href*='/live-blog/']",
      ];

      const leadAnchors = [];
      const seenLead = new Set();
      for (const sel of leadSelectors) {
        for (const a of Array.from(document.querySelectorAll(sel))) {
          if (seenLead.has(a)) continue;
          seenLead.add(a);
          leadAnchors.push(a);
        }
      }

      const leadCandidates = leadAnchors
        .map((a) => {
          const url = abs(a.getAttribute("href") || "");
          const title = clean(a.textContent || a.getAttribute("aria-label") || "");
          if (!url || !title || !isStoryUrl(url)) return null;
          const rect = a.getBoundingClientRect();
          const topY = (Number.isFinite(rect?.top) ? rect.top : 0) + (window.scrollY || 0);
          if (topY < boundaryY) return null;
          let score = 0;
          score += 180;
          if (a.closest(".single-storyline, [data-testid='single-storyline']")) score += 110;
          if (a.closest(".lead-type--Storyline")) score += 80;
          if (a.closest("h1,h2")) score += 30;
          score -= Math.min(120, Math.max(0, topY - boundaryY) / 8);
          if (isArticleLikeUrl(url)) score += 35;
          if (/\/live-blog\//i.test(url)) score += 10;
          return { title, url, topY, score };
        })
        .filter(Boolean)
        .sort((a, b) => (b.score - a.score) || (a.topY - b.topY));

      if (leadCandidates.length) {
        const best = leadCandidates[0];
        return { ok: true, title: refineTitleForUrl(best.url, best.title), url: best.url, selector_used: "nbc_post_header_lead" };
      }

      // Strategy 2: NBC quick-links banner often points to the real lead topic.
      // Match any quick-link URL to the nearest full headline below quick-links.
      if (quickNav) {
        const quickCandidates = Array.from(quickNav.querySelectorAll("a[href]"))
          .map((a) => {
            const href = a.getAttribute("href") || "";
            const url = abs(href);
            const icid = String(a.getAttribute("data-icid") || "");
            const title = clean(a.textContent || a.getAttribute("aria-label") || "");
            if (!url || !isStoryUrl(url)) return null;
            if (/\/tips\/?$/i.test(url)) return null;
            return { a, url, icid, title };
          })
          .filter(Boolean);

        if (quickCandidates.length) {
          const navRect = quickNav.getBoundingClientRect();
          const navBottomY = (Number.isFinite(navRect?.bottom) ? navRect.bottom : 0) + (window.scrollY || 0);
          const anchorPool = Array.from(document.querySelectorAll("a[href]"));
          let best = null;
          for (const quick of quickCandidates) {
            const targetUrl = canonicalUrl(quick.url);
            const match = anchorPool
              .map((a) => {
                if (quickNav.contains(a)) return null;
                const href = a.getAttribute("href") || "";
                const url = abs(href);
                if (!url || canonicalUrl(url) !== targetUrl) return null;
                const title = clean(a.textContent || a.getAttribute("aria-label") || "");
                if (!title || title.length < 20) return null;
                const rect = a.getBoundingClientRect();
                const topY = (Number.isFinite(rect?.top) ? rect.top : 0) + (window.scrollY || 0);
                let score = 0;
                if (topY >= navBottomY) score += 95;
                else score -= 25;
                score -= Math.min(300, Math.abs(topY - navBottomY) / 10);
                if (a.closest("main")) score += 40;
                if (a.closest(".headline-item-container, .headline-large, .multistoryline__headline, [data-testid*='storyline'], .single-storyline")) score += 95;
                if (title.length >= 24 && title.length <= 220) score += 20;
                const icidIdx = Number(String(quick.icid || "").split("-").pop());
                if (Number.isFinite(icidIdx)) score += Math.max(0, 15 - icidIdx);
                return { title, url, topY, score, quickTitle: quick.title || null };
              })
              .filter(Boolean)
              .sort((a, b) => (b.score - a.score) || (a.topY - b.topY))[0] || null;
            if (match && (!best || match.score > best.score)) best = match;
          }

          if (best) {
            return {
              ok: true,
              title: refineTitleForUrl(best.url, best.title),
              url: best.url,
              selector_used: "nbc_quick_links_nearest_story",
              quick_link_title: best.quickTitle || null,
            };
          }

          // If no nearby richer headline is present, fall back to first quick-link topic.
          const quickTop =
            quickCandidates.find((x) => /quick-links-0$/i.test(x.icid)) ||
            quickCandidates[0] ||
            null;
          if (quickTop?.title && quickTop.title.length >= 8) {
            return {
              ok: true,
              title: refineTitleForUrl(quickTop.url, quickTop.title),
              url: quickTop.url,
              selector_used: "nbc_quick_links_direct",
              quick_link_title: quickTop.title || null,
            };
          }
        }
      }

      // Strategy 3: parse Next.js payload in DOM order when visible markup is unstable.
      try {
        const nextDataEl = document.querySelector("script#__NEXT_DATA__");
        const raw = nextDataEl?.textContent || "";
        if (raw && raw.length > 5000) {
          const payload = JSON.parse(raw);
          const layouts = payload?.props?.initialState?.front?.curation?.layouts || [];
          const rankedJson = [];
          let order = 0;

          for (const layout of layouts) {
            for (const pkg of (layout?.packages || [])) {
              const pkgType = String(pkg?.type || "").toLowerCase();
              if (pkgType.includes("ad") || pkgType.includes("embed")) continue;
              for (const it of (pkg?.items || [])) {
                order += 1;
                const item = it?.item || {};
                const computed = it?.computedValues || item?.computedValues || {};
                const url = pickUrl(computed?.url) || pickUrl(item?.url) || null;
                const title =
                  pickString(computed?.headline) ||
                  pickString(item?.headline) ||
                  pickString(item?.headlineAlternatives?.[0]) ||
                  "";
                if (!url || !title || !isStoryUrl(url)) continue;
                if (/\/(video|now\/video|video\/shorts)\//i.test(url)) continue;
                let score = 700 - Math.min(500, order * 3);
                if (/\/live-blog\//i.test(url)) score += 90;
                if (isArticleLikeUrl(url)) score += 35;
                if (title.length >= 18 && title.length <= 240) score += 12;
                rankedJson.push({ title, url, score, order });
              }
            }
          }

          rankedJson.sort((a, b) => (b.score - a.score) || (a.order - b.order));
          if (rankedJson.length) {
            const top = rankedJson[0];
            return { ok: true, title: refineTitleForUrl(top.url, top.title), url: top.url, selector_used: "nbc_next_data_ordered" };
          }
        }
      } catch {}

      const ranked = anchors
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          const title = clean(a.textContent || a.getAttribute("aria-label") || "");
          if (!url || !title || !isStoryUrl(url)) return null;
          const rect = a.getBoundingClientRect();
          const topY = (Number.isFinite(rect?.top) ? rect.top : 0) + (window.scrollY || 0);
          const isBanner = isLikelyTopicBanner(a, title, url);
          return { title, url, topY, isBanner, score: scoreAnchor(a, title, url, topY, isBanner) };
        })
        .filter((x) => x && x.score > -10)
        .sort((a, b) => (b.score - a.score) || (a.topY - b.topY));

      const nonBanner = ranked
        .filter((x) => !x.isBanner)
        .sort((a, b) => (b.score - a.score) || (a.topY - b.topY));

      if (nonBanner.length) {
        const top = nonBanner[0];
        return { ok: true, title: refineTitleForUrl(top.url, top.title), url: top.url, selector_used: "nbc_non_banner_ranked" };
      }

      if (ranked.length) {
        const top = ranked[0];
        return { ok: true, title: refineTitleForUrl(top.url, top.title), url: top.url, selector_used: "nbc_ranked_fallback" };
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
          if (isLikelyTopicBanner({ closest: () => null }, title, url) && !isArticleLikeUrl(url)) continue;
          return { ok: true, title: refineTitleForUrl(url, title), url, selector_used: "nbc_json_fallback" };
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

    return {
      ok: Boolean(item),
      error: snapshot.error,
      updatedAt: nowISO(),
      runId,
      archive,
      item,
      shot,
      meta: {
        selector_used: hero?.selector_used || null,
        quick_link_title: hero?.quick_link_title || null,
      },
    };
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
async function scrapeGuardianHero() {
  return await withBrowser(async (page) => {
    const runId = `guardian1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

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

      function isStoryUrl(url) {
        if (!url) return false;
        if (!/^https?:\/\/(www\.)?theguardian\.com\//i.test(url)) return false;
        const path = (() => {
          try { return new URL(url).pathname || ""; } catch { return ""; }
        })();
        if (!path || path === "/") return false;
        if (/^\/(help|about|info|index|email-newsletters|us|world|uk|sport|culture|lifeandstyle|commentisfree)(\/)?$/i.test(path)) return false;
        if (/^\/football\/live(\/|$)/i.test(path)) return false;
        return /\/\d{4}\/[a-z]{3}\/\d{1,2}\//i.test(path) || /\/live\//i.test(path);
      }

      function scoreAnchor(a, title, url) {
        const dl = String(a.getAttribute("data-link-name") || "").toLowerCase();
        const path = (() => {
          try { return new URL(url).pathname || ""; } catch { return ""; }
        })();
        const rect = a.getBoundingClientRect();
        const topY = (Number.isFinite(rect?.top) ? rect.top : 0) + (window.scrollY || 0);
        let score = 0;
        if (a.closest("main")) score += 45;
        if (a.classList.contains("dcr-2yd10d")) score += 30;
        if (/group-0/.test(dl)) score += 120;
        if (dl.includes("news | group")) score += 70;
        if (dl.includes("live | group")) score += 170;
        if (/\/live\//i.test(path)) score += 45;
        if (title.length >= 16 && title.length <= 240) score += 15;
        if (Number.isFinite(topY)) {
          if (topY < 900) score += 50;
          else if (topY < 1700) score += 20;
        }
        if (a.closest("header,nav,footer,[data-component='sub-nav']")) score -= 140;
        return { score, topY };
      }

      const seen = new Set();
      const anchors = [];
      const selectors = [
        'main a[data-link-name*="live | group"][href*="/live/"]',
        'main a[data-link-name*="group-0"][href]',
        'main a[data-link-name*="news | group"][href]',
        'main a.dcr-2yd10d[href]',
        'main .headline-text',
        'main a[href*="/us-news/"], main a[href*="/world/"], main a[href*="/politics/"]',
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
            clean(a.getAttribute("aria-label") || "") ||
            clean(a.querySelector(".headline-text")?.textContent || "") ||
            clean(a.textContent || "");
          if (!url || !title || title.length < 15 || !isStoryUrl(url)) return null;
          const scored = scoreAnchor(a, title, url);
          return { title, url, score: scored.score, topY: scored.topY };
        })
        .filter((x) => x && x.score > -10)
        .sort((a, b) => (b.score - a.score) || (a.topY - b.topY));

      if (ranked.length > 0) {
        const top = ranked[0];
        return { ok: true, title: top.title, url: top.url };
      }

      return { ok: false, error: "Guardian: no headline found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("guardian1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "guardian1", runId, tsIso: fetchedAt, item });
    const snapshot = {
      id: "guardian1",
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

      function isStoryUrl(url) {
        if (!url) return false;
        if (!/^https?:\/\/(www\.)?usatoday\.com\//i.test(url)) return false;
        if (/\/videos?\//i.test(url)) return false;
        return /\/(story|live-story)\//i.test(url);
      }

      function titleFromAnchor(a) {
        const explicit =
          clean(a.querySelector("span.gnt_m_he__lc")?.textContent || "") ||
          clean(a.querySelector("span.gnt_lbl_lc")?.textContent || "") ||
          clean(a.querySelector('span[data-tb-shadow-region-title="0"]')?.textContent || "") ||
          clean(a.querySelector("span[data-tb-title]")?.textContent || "") ||
          clean(a.querySelector("[data-tb-shadow-region-title]")?.textContent || "") ||
          clean(a.querySelector("[data-tb-title]")?.textContent || "") ||
          clean(a.querySelector("span")?.textContent || "");
        return explicit || clean(a.getAttribute("aria-label") || "") || clean(a.textContent || "");
      }

      function scoreAnchor(a, title, url) {
        const rect = a.getBoundingClientRect();
        const topY = (Number.isFinite(rect?.top) ? rect.top : 0) + (window.scrollY || 0);
        let score = 0;
        if (a.classList.contains("gnt_m_he")) score += 160;
        if (/\/live-story\//i.test(url)) score += 70;
        if (a.querySelector("span.gnt_m_he__lc, span.gnt_lbl_lc")) score += 45;
        if (a.querySelector("[data-tb-shadow-region-title], [data-tb-title]")) score += 35;
        if (a.querySelector("img")) score += 20;
        if (a.closest("main")) score += 25;
        if (a.closest("header,nav,footer")) score -= 150;
        if (title.length >= 24 && title.length <= 260) score += 20;
        if (title.length >= 12 && title.length <= 320) score += 10;
        if (Number.isFinite(topY)) {
          if (topY < 900) score += 35;
          else if (topY < 1700) score += 15;
        }
        return { score, topY };
      }

      const seen = new Set();
      const anchors = [];
      const selectors = [
        "a.gnt_m_he[href]",
        "main a[href*='/live-story/']",
        "a[href*='/live-story/']",
        "main a[href*='/story/']",
        "a[data-tb-link][href]",
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
          const url = href ? absUrl(href) : null;
          if (!url || !isStoryUrl(url)) return null;
          const title = titleFromAnchor(a);
          if (!title || title.length < 12) return null;
          const s = scoreAnchor(a, title, url);
          return { a, title, url, score: s.score, topY: s.topY };
        })
        .filter((x) => x && x.score > -20)
        .sort((a, b) => (b.score - a.score) || (a.topY - b.topY));

      const top = ranked[0] || null;
      if (!top) return { ok: false, error: "USAT: hero anchor not found" };

      const a = top.a;
      const href = a.getAttribute("href") || "";
      const url = href ? absUrl(href) : null;
      const title = top.title;

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
      const breakingAnchor =
        document.querySelector('a.gnt_n_bn_hl.gnt_n_bn_ce[data-g-r="base_bnlink"][href]') ||
        document.querySelector("a.gnt_n_bn_hl.gnt_n_bn_ce[href]") ||
        null;
      const breakingHeadline = clean(breakingAnchor?.textContent || "") || null;
      const breakingHref = clean(breakingAnchor?.getAttribute("href") || "");
      const breakingUrl = breakingHref ? absUrl(breakingHref) : null;
      const hasBreakingBanner = Boolean(breakingHeadline);

      return {
        ok: Boolean(title && url),
        title,
        url,
        imgUrl,
        imgAlt,
        dek,
        breakingHeadline,
        breakingUrl,
        hasBreakingBanner,
        debug: {
          href,
          aClass: a.getAttribute("class") || null,
          dataTL: a.getAttribute("data-t-l") || null,
          pickedSpanHasShadow0: Boolean(a.querySelector('span[data-tb-shadow-region-title="0"]')),
          isLiveStory: /\/live-story\//i.test(url || ""),
          hasBreakingBanner,
          rankedCandidates: ranked.length,
        },
      };
    });

    // Optional: og:image fallback if tile doesn't expose image url
    let finalUrl = hero?.url ? normalizeUrl(hero.url) : null;
    let finalTitle = cleanText(hero?.title || "");
    let finalImgUrl = hero?.imgUrl ? normalizeUrl(hero.imgUrl) : null;
    let finalBreakingUrl = hero?.breakingUrl ? normalizeUrl(hero.breakingUrl) : null;
    let finalBreakingHeadline = cleanText(hero?.breakingHeadline || "");

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
          breakingLabel: hero?.hasBreakingBanner ? "Breaking News" : null,
          breakingHeadline: finalBreakingHeadline || null,
          breakingUrl: finalBreakingUrl,
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
        if (!url) return false;
        if (!/^https?:\/\/(www\.)?apnews\.com\//i.test(url)) return false;
        if (/^https?:\/\/(www\.)?apnews\.com\/article\//i.test(url)) return true;
        if (/^https?:\/\/(www\.)?apnews\.com\/live\//i.test(url)) return true;
        return false;
      }

      function scoreAnchor(a, title, url) {
        let score = 0;
        if (a.closest(".PageListStandardE-leadPromo-info")) score += 90;
        if (a.closest(".PagePromo-title, h1, h2, h3")) score += 40;
        if (a.querySelector('span[data-tb-shadow-region-title="0"]')) score += 35;
        if (a.querySelector("span.PagePromoContentIcons-text")) score += 20;
        if (/\/article\//i.test(url)) score += 15;
        if (/\/live\//i.test(url)) score += 36;
        if (a.closest(".PageListStandardE-leadPromo-info")?.querySelector(".PagePromo-byline-liveEvent,.PageListTrending-LiveTag")) score += 24;
        if (title.length >= 24 && title.length <= 240) score += 12;
        if (a.closest(".PagePromo-description, .Trending")) score -= 45;
        if (a.closest("header,nav,footer,.MainNavigation,.Page-header-navigation")) score -= 140;
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

      // Prefer first lead promo below top nav.
      const navBoundaryEl =
        document.querySelector(".Page-header-navigation") ||
        document.querySelector("header nav") ||
        document.querySelector(".MainNavigation");
      const navRect = navBoundaryEl?.getBoundingClientRect?.();
      const navBottomY = (Number.isFinite(navRect?.bottom) ? navRect.bottom : 0) + (window.scrollY || 0);
      const leadCandidates = Array.from(
        document.querySelectorAll(".PageListStandardE-leadPromo-info a.Link[href], .PageListStandardE-leadPromo-info .PagePromo-title a[href]"),
      )
        .map((a) => {
          const url = abs(a.getAttribute("href") || "");
          const title =
            clean(a.querySelector('span[data-tb-shadow-region-title="0"]')?.textContent || "") ||
            clean(a.querySelector("span.PagePromoContentIcons-text")?.textContent || "") ||
            clean(a.getAttribute("aria-label") || "") ||
            clean(a.textContent || "");
          if (!url || !title || !isStoryUrl(url)) return null;
          const rect = a.getBoundingClientRect();
          const topY = (Number.isFinite(rect?.top) ? rect.top : 0) + (window.scrollY || 0);
          if (topY < Math.max(0, navBottomY - 20)) return null;
          let score = 260;
          score += scoreAnchor(a, title, url);
          score -= Math.min(180, Math.max(0, topY - navBottomY) / 6);
          return { title, url, score, topY };
        })
        .filter(Boolean)
        .sort((a, b) => (b.score - a.score) || (a.topY - b.topY));

      if (leadCandidates.length) {
        const top = leadCandidates[0];
        return { ok: true, title: top.title, url: top.url, selector_used: "ap_post_nav_lead" };
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
        const u = (() => {
          try { return new URL(url); } catch { return null; }
        })();
        if (!u) return false;
        const path = String(u.pathname || "");
        const isStory = /\/story\//i.test(path);
        const isLive = /\/live(\/|$)/i.test(path) || /\/live-updates(\/|$)/i.test(path);
        if (!isStory && !isLive) return false;
        if (/\/b2b\//i.test(url)) return false;
        return true;
      }

      const seen = new Set();
      const anchors = [];
      const selectors = [
        "main h1 a.link[href*='/live']",
        "main h1 a[href*='/live']",
        "main .promo-title a.link[href*='/live']",
        "main .promo-title a[href*='/live']",
        "main a.link[href*='/live-updates']",
        "main a[href*='/live-updates']",
        "main h1.promo-title a.link[href*='/story/']",
        "main h1 a.link[href*='/story/']",
        "main .promo-title a.link[href*='/story/']",
        "main a.link[href*='/story/']",
        "h1.promo-title a.link[href*='/story/']",
        "main article h1 a[href]",
        "main article a[href]",
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
          const path = (() => {
            try { return new URL(url).pathname || ""; } catch { return ""; }
          })();
          const isLive = /\/live(\/|$)/i.test(path) || /\/live-updates(\/|$)/i.test(path);
          let score = 0;
          if (a.closest("h1")) score += 80;
          if (a.closest(".promo-title")) score += 40;
          if (a.closest("article")) score += 20;
          if (a.closest("main")) score += 30;
          if (isLive) score += 35;
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
   BBC (single top item)
--------------------------- */
async function scrapeBBCHero() {
  return await withBrowser(async (page) => {
    const runId = `bbc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    const navResp = await page.goto("https://www.bbc.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
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
          return new URL(h, "https://www.bbc.com").toString();
        } catch {
          return null;
        }
      }
      function parsed(url) {
        try {
          return new URL(String(url || ""));
        } catch {
          return null;
        }
      }
      function isBbcNewsHost(url) {
        const u = parsed(url);
        if (!u) return false;
        return /(^|\.)bbc\.com$|(^|\.)bbc\.co\.uk$/i.test(u.hostname);
      }
      function isLiveUrl(url) {
        const p = parsed(url);
        const path = String(p?.pathname || "").toLowerCase();
        return /\/news\/live\//.test(path);
      }
      function isVideoUrl(url) {
        const p = parsed(url);
        const path = String(p?.pathname || "").toLowerCase();
        return /\/news\/(videos|av)\//.test(path);
      }
      function isStoryUrl(url) {
        if (!url || !isBbcNewsHost(url)) return false;
        const p = parsed(url);
        const path = String(p?.pathname || "");
        if (!path.startsWith("/news/")) return false;
        if (/^\/news\/?$/i.test(path)) return false;
        if (/^\/news\/(videos|av|topics|special-reports)(\/|$)/i.test(path)) return false;
        if (/^\/news\/articles\/[a-z0-9]+$/i.test(path)) return true;
        if (/^\/news\/live\/[a-z0-9\/-]+$/i.test(path)) return true;
        if (/^\/news\/[a-z-]+-\d+$/i.test(path)) return true;
        return false;
      }
      function isGenericTitle(title) {
        return /^(live|video|latest|news|bbc news)$/i.test(String(title || "").trim());
      }
      function hasLiveBadge(a) {
        if (!a) return false;
        if (a.querySelector('[data-testid="live-icon-svg-styled"],[data-testid*="live-icon"]')) return true;
        const spans = Array.from(a.querySelectorAll("span"));
        return spans.some((s) => clean(s.textContent || "").toUpperCase() === "LIVE");
      }
      function scoreAnchor(a, title, url, topY) {
        let score = 0;
        const headlineEl = a.querySelector('[data-testid="card-headline"],h1,h2,h3');
        const inMain = Boolean(a.closest("main,[id='main-content'],[data-testid='main-content']"));
        const inHeroish = Boolean(a.closest("article,section,[data-testid*='index-page'],[data-testid*='top-stories'],[data-testid*='top-stories']"));

        if (/\/news\/articles\//i.test(url)) score += 220;
        if (isLiveUrl(url)) score += 120;
        if (hasLiveBadge(a)) score += 140;
        if (/^https?:\/\/(www\.)?bbc\.(com|co\.uk)\/news\/[a-z-]+-\d+$/i.test(url)) score += 80;
        if (headlineEl) score += 60;
        if (inMain) score += 60;
        if (inHeroish) score += 25;
        if (title.length >= 24 && title.length <= 240) score += 16;
        if (Number.isFinite(topY)) {
          if (topY < 900) score += 55;
          else if (topY < 1700) score += 20;
        }
        if (isVideoUrl(url)) score -= 220;
        if (a.closest("header,nav,footer,[role='navigation'],[data-testid*='navigation']")) score -= 280;
        if (a.closest("[aria-label*='Sign in'],[aria-label*='Search']")) score -= 120;
        if (isGenericTitle(title)) score -= 140;
        return score;
      }

      const seen = new Set();
      const anchors = [];
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
      for (const sel of selectors) {
        for (const a of Array.from(document.querySelectorAll(sel))) {
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
            clean(a.querySelector('[data-testid="card-headline"]')?.textContent || "") ||
            clean(a.querySelector("h1,h2,h3")?.textContent || "") ||
            clean(a.getAttribute("aria-label") || "") ||
            clean(a.textContent || "");
          if (!url || !title || !isStoryUrl(url)) return null;
          const rect = a.getBoundingClientRect?.();
          const topY = Number.isFinite(rect?.top) ? rect.top : NaN;
          return {
            title,
            url,
            score: scoreAnchor(a, title, url, topY),
            isLive: isLiveUrl(url),
            hasLiveBadge: hasLiveBadge(a),
          };
        })
        .filter((x) => x && x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (!ranked.length) return { ok: false, error: "BBC: top story not found" };

      const topAny = ranked[0];
      const topArticle = ranked.find((r) => !r.isLive) || null;
      const chosen = topAny.isLive && topAny.hasLiveBadge
        ? topAny
        : (topArticle && topArticle.score >= topAny.score - 25 ? topArticle : topAny);
      return {
        ok: true,
        title: chosen.title,
        url: chosen.url,
        selector_used: chosen.isLive ? "bbc_live_card" : "bbc_ranked_card",
        candidates: ranked.length,
      };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("bbc1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "bbc1", runId, tsIso: fetchedAt, item });
    const pageTitle = await page.title().catch(() => null);
    const snapshot = {
      id: "bbc1",
      fetchedAt,
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "BBC not found"),
      item,
      shot,
      meta: {
        run_kind: "hero",
        profile: "desktop",
        final_url: page.url() || null,
        http_status: navResp?.status?.() ?? null,
        page_title: pageTitle || null,
        selector_used: hero?.selector_used || null,
        candidates: Number.isFinite(Number(hero?.candidates)) ? Number(hero.candidates) : null,
      },
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
      meta: snapshot.meta,
    };
  });
}

/* ---------------------------
   Fox News (single top item)
--------------------------- */
async function scrapeFoxHero() {
  return await withBrowser(async (page) => {
    const runId = `fox1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    const navResp = await page.goto("https://www.foxnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
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
          return new URL(h, "https://www.foxnews.com").toString();
        } catch {
          return null;
        }
      }
      function parsed(url) {
        try {
          return new URL(String(url || ""));
        } catch {
          return null;
        }
      }
      function isFoxHost(url) {
        const u = parsed(url);
        if (!u) return false;
        return /(^|\.)foxnews\.com$/i.test(u.hostname);
      }
      function isVideoUrl(url) {
        return /\/video\//i.test(String(url || ""));
      }
      function isStoryUrl(url) {
        if (!url || !isFoxHost(url)) return false;
        const p = parsed(url);
        const path = String(p?.pathname || "");
        if (!/^\/[a-z0-9-]+\/[a-z0-9-]+/i.test(path)) return false;
        if (/^\/(live|search|category|shows|video|fox-nation|weather|sports\/odds|person|about|newsletter|apps)(\/|$)/i.test(path)) return false;
        return true;
      }
      function cleanTitle(title) {
        return clean(String(title || "").replace(/\s*-\s*Fox News\s*$/i, ""));
      }
      function scoreAnchor(a, title, url, imgSrc, imgDataSrc, topY, navLastIdx, docIdx) {
        let score = 0;
        if (a.closest("main.main-content-primary")) score += 90;
        if (a.closest("article[class*='story-']")) score += 90;
        if (a.closest(".collection")) score += 40;
        if (a.querySelector("img[alt]")) score += 45;
        if ((imgDataSrc || imgSrc) && /\/content\/uploads\//i.test(String(imgDataSrc || imgSrc))) score += 25;
        if ((imgDataSrc || imgSrc) && /\/prod-hp\.foxnews\.com\/images\//i.test(String(imgDataSrc || imgSrc))) score += 35;
        if ((imgDataSrc || imgSrc) && /\/720\/405\//i.test(String(imgDataSrc || imgSrc))) score += 25;
        if (title.length >= 20 && title.length <= 220) score += 15;
        if (Number.isFinite(topY)) {
          if (topY < 900) score += 70;
          else if (topY < 1700) score += 25;
        }
        if (Number.isFinite(navLastIdx) && Number.isFinite(docIdx)) {
          if (docIdx > navLastIdx) {
            const delta = docIdx - navLastIdx;
            score += 220;
            score += Math.max(0, 120 - Math.min(120, delta));
          } else {
            score -= 320;
          }
        }
        if (a.closest("header,nav,footer,.network-wrapper,.watch-live,.top-stories")) score -= 220;
        if (isVideoUrl(url)) score -= 220;
        return score;
      }

      const allHrefAnchors = Array.from(document.querySelectorAll("a[href]"));
      const docIndexByAnchor = new Map(allHrefAnchors.map((el, i) => [el, i]));
      const navAnchors = Array.from(document.querySelectorAll(".nav-row.nav-row-lower a[href]"));
      const navLast = navAnchors.length ? navAnchors[navAnchors.length - 1] : null;
      const navLastIdx = navLast && docIndexByAnchor.has(navLast) ? docIndexByAnchor.get(navLast) : -1;

      const seen = new Set();
      const anchors = [];
      const selectors = [
        "main.main-content-primary article.story-1 a[href]",
        "main.main-content-primary article[class*='story-'] a[href]",
        "main.main-content-primary a[href]",
        "main a[href]",
        "article.story-1 a[href]",
      ];

      for (const sel of selectors) {
        for (const a of Array.from(document.querySelectorAll(sel))) {
          if (!a || seen.has(a)) continue;
          seen.add(a);
          anchors.push(a);
        }
      }

      const ranked = anchors
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          const img = a.querySelector("img[alt]");
          const imgAlt = clean(img?.getAttribute("alt") || "");
          const imgSrc = clean(img?.getAttribute("src") || "");
          const imgDataSrc = clean(img?.getAttribute("data-src") || "");
          if (imgSrc === "//static.foxnews.com/static/orion/img/clear-16x9.gif" && !imgDataSrc) return null;
          const textTitle = clean(
            a.querySelector("h1,h2,h3,.title,.headline")?.textContent ||
            a.getAttribute("title") ||
            a.getAttribute("aria-label") ||
            a.textContent ||
            "",
          );
          const title = cleanTitle(imgAlt || textTitle);
          if (!url || !title || !isStoryUrl(url)) return null;
          const rect = a.getBoundingClientRect?.();
          const topY = Number.isFinite(rect?.top) ? rect.top : NaN;
          const docIdx = docIndexByAnchor.has(a) ? docIndexByAnchor.get(a) : NaN;
          return {
            title,
            url,
            imgSrc,
            imgDataSrc,
            docIdx,
            score: scoreAnchor(a, title, url, imgSrc, imgDataSrc, topY, navLastIdx, docIdx),
          };
        })
        .filter((x) => x && x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (!ranked.length) return { ok: false, error: "Fox News: top story not found" };
      const prodHero = ranked
        .filter((r) => {
          const src = String(r.imgDataSrc || r.imgSrc || "");
          return /\/prod-hp\.foxnews\.com\/images\//i.test(src) &&
                 /\/720\/405\//i.test(src) &&
                 (!Number.isFinite(navLastIdx) || navLastIdx < 0 || (Number.isFinite(r.docIdx) && r.docIdx > navLastIdx));
        })
        .sort((a, b) => (Number(a.docIdx || 0) - Number(b.docIdx || 0)));
      const top = prodHero[0] || ranked[0];
      return {
        ok: true,
        title: top.title,
        url: top.url,
        selector_used: selectors[0],
        candidates: ranked.length,
      };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("fox1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "fox1", runId, tsIso: fetchedAt, item });
    const pageTitle = await page.title().catch(() => null);
    const snapshot = {
      id: "fox1",
      fetchedAt,
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "Fox News not found"),
      item,
      shot,
      meta: {
        run_kind: "hero",
        profile: "desktop",
        final_url: page.url() || null,
        http_status: navResp?.status?.() ?? null,
        page_title: pageTitle || null,
        selector_used: hero?.selector_used || null,
        candidates: Number.isFinite(Number(hero?.candidates)) ? Number(hero.candidates) : null,
      },
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
      meta: snapshot.meta,
    };
  });
}

/* ---------------------------
   Yahoo (single top item)
--------------------------- */
async function scrapeWPHero(opts = {}) {
  const debugMode = Boolean(opts?.debug);
  return await withBrowser(async (page) => {
    const runId = `yahoo1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    const navResp = await page.goto("https://news.yahoo.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2200);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://news.yahoo.com").toString();
        } catch {
          return null;
        }
      }
      function parsed(url) {
        try {
          return new URL(String(url || ""));
        } catch {
          return null;
        }
      }
      function isYahooHost(url) {
        const u = parsed(url);
        if (!u) return false;
        return /(^|\.)yahoo\.com$/i.test(u.hostname);
      }
      function isStoryUrl(url) {
        if (!url || !isYahooHost(url)) return false;
        const u = parsed(url);
        const p = String(u?.pathname || "");
        if (!/^\/[a-z0-9-]+\/[a-z0-9-]+/i.test(p) && !/^\/news\/articles\//i.test(p)) return false;
        if (/^\/(search|news|finance|sports|entertainment|lifestyle|mail|weather|video|autos)\/?$/i.test(p)) return false;
        return true;
      }
      function numFromYlk(ylk, key) {
        const m = String(ylk || "").match(new RegExp(`(?:^|;)${key}:(\\\\d+)`));
        return m ? Number(m[1]) : NaN;
      }
      function hasYlk(ylk, token) {
        return String(ylk || "").includes(token);
      }
      function scoreAnchor(a, title, url, topY, navLastIdx, docIdx, ylk) {
        let score = 0;
        const mpos = numFromYlk(ylk, "mpos");
        const cpos = numFromYlk(ylk, "cpos");
        if (hasYlk(ylk, "sec:strm")) score += 180;
        if (hasYlk(ylk, "ct:story")) score += 120;
        if (hasYlk(ylk, "elm:hdln")) score += 120;
        if (hasYlk(ylk, "subsec:needtoknow")) score += 60;
        if (Number.isFinite(mpos)) score += Math.max(0, 140 - (mpos * 20));
        if (Number.isFinite(cpos)) score += Math.max(0, 70 - (cpos * 8));
        if ((a.getAttribute("class") || "").includes("stretched-box")) score += 25;
        if (title.length >= 20 && title.length <= 220) score += 15;
        if (Number.isFinite(topY)) {
          if (topY < 900) score += 70;
          else if (topY < 1700) score += 25;
        }
        if (Number.isFinite(navLastIdx) && Number.isFinite(docIdx)) {
          if (docIdx > navLastIdx) {
            const delta = docIdx - navLastIdx;
            score += 220;
            score += Math.max(0, 120 - Math.min(120, delta));
          } else {
            score -= 320;
          }
        }
        if (a.closest("nav,header,footer,[role='navigation']")) score -= 260;
        if (/\/(search|account|mail|weather)\b/i.test(url)) score -= 200;
        return score;
      }

      const pageTitle = clean(document.title || "");
      const pageText = clean(document.body?.innerText || "");
      const blockedByText = /verify you are human|captcha|access denied|forbidden|request blocked/i.test(`${pageTitle} ${pageText}`);
      if (blockedByText) {
        return {
          ok: false,
          error: "Yahoo blocked or interstitial challenge",
          debug: {
            page_title: pageTitle,
            page_snippet: pageText.slice(0, 600),
            blocked_signal: "text_match",
          },
        };
      }

      const allHrefAnchors = Array.from(document.querySelectorAll("a[href]"));
      const docIndexByAnchor = new Map(allHrefAnchors.map((el, i) => [el, i]));
      const navAnchors = Array.from(document.querySelectorAll("header a[href], nav a[href]"));
      const navLast = navAnchors.length ? navAnchors[navAnchors.length - 1] : null;
      const navLastIdx = navLast && docIndexByAnchor.has(navLast) ? docIndexByAnchor.get(navLast) : -1;

      const seen = new Set();
      const anchors = [];
      const targetHeroSelector = 'u.StretchedBox.wafer-rapid-module[class*="W(59.6%)"][data-ylk*="elm:img;"][data-wf-rapid-trigger="click"][data-wf-rapid-method="beaconClick"]';
      const targetHeroU = document.querySelector(targetHeroSelector);
      const targetHeroAnchor = targetHeroU ? targetHeroU.closest("a[href]") : null;
      if (targetHeroAnchor) {
        seen.add(targetHeroAnchor);
        anchors.push(targetHeroAnchor);
      }
      const selectors = [
        'a[data-ylk*="sec:strm"][data-ylk*="ct:story"][data-ylk*="elm:hdln"][href]',
        'main a[data-ylk*="ct:story"][href]',
        "main a[href]",
        'a[data-ylk][href]',
      ];
      for (const sel of selectors) {
        for (const a of Array.from(document.querySelectorAll(sel))) {
          if (!a || seen.has(a)) continue;
          seen.add(a);
          anchors.push(a);
        }
      }

      const ranked = anchors
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          const ylk = a.getAttribute("data-ylk") || "";
          const title =
            clean(a.querySelector("span")?.textContent || "") ||
            clean(a.getAttribute("aria-label") || "") ||
            clean(a.textContent || "");
          if (!url || !title || !isStoryUrl(url)) return null;
          const rect = a.getBoundingClientRect?.();
          const topY = Number.isFinite(rect?.top) ? rect.top : NaN;
          const docIdx = docIndexByAnchor.has(a) ? docIndexByAnchor.get(a) : NaN;
          return {
            title,
            url,
            ylk,
            score: scoreAnchor(a, title, url, topY, navLastIdx, docIdx, ylk) + (a === targetHeroAnchor ? 500 : 0),
          };
        })
        .filter((x) => x && x.score > 0)
        .sort((a, b) => b.score - a.score);

      if (!ranked.length) {
        // Fallback: parse Next data payload for ntk stream items.
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        const nextData = scripts
          .map((s) => s.textContent || "")
          .find((txt) => txt.includes("window.__next_f.push") && txt.includes("\"ntk\":"));
        if (nextData) {
          const m = nextData.match(/\"ntk\":\\s*\\[(.*?)\\],\\s*\"spaceId\"/s);
          if (m && m[1]) {
            const tuples = m[1].split("},{").map((x, i, arr) => (i === 0 ? x + "}" : i === arr.length - 1 ? "{" + x : "{" + x + "}"));
            for (const rowRaw of tuples) {
              try {
                const row = JSON.parse(rowRaw);
                const url = abs(row?.url || "");
                const title = clean(row?.title || "");
                if (url && title && isStoryUrl(url)) {
                  return {
                    ok: true,
                    title,
                    url,
                    selector_used: "next_f ntk fallback",
                    candidates: 1,
                    debug: {
                      fallback: "next_f_ntk",
                      page_title: pageTitle,
                      page_snippet: pageText.slice(0, 600),
                    },
                  };
                }
              } catch {}
            }
          }
        }
        return {
          ok: false,
          error: "Yahoo: top story not found",
          debug: {
            page_title: pageTitle,
            page_snippet: pageText.slice(0, 600),
            candidates: [],
          },
        };
      }
      const top = ranked[0];
      const topCandidates = ranked.slice(0, 12).map((x) => ({
        title: x.title,
        url: x.url,
        score: x.score,
        ylk: String(x.ylk || "").slice(0, 220),
      }));
      return {
        ok: true,
        title: top.title,
        url: top.url,
        selector_used: top.url && targetHeroAnchor && abs(targetHeroAnchor.getAttribute("href") || "") === top.url ? targetHeroSelector : selectors[0],
        candidates: ranked.length,
        debug: {
          page_title: pageTitle,
          page_snippet: pageText.slice(0, 600),
          candidates: topCandidates,
        },
      };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("yahoo1|top").slice(0, 12),
        }
      : null;

    const fetchedAt = nowISO();
    const shot = await captureTimelineShot(page, { sourceId: "yahoo1", runId, tsIso: fetchedAt, item });
    const pageTitle = await page.title().catch(() => null);
    const snapshot = {
      id: "yahoo1",
      fetchedAt,
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "Yahoo not found"),
      item,
      shot,
      meta: {
        run_kind: "hero",
        profile: "desktop",
        final_url: page.url() || null,
        http_status: navResp?.status?.() ?? null,
        page_title: pageTitle || null,
        selector_used: hero?.selector_used || null,
        candidates: Number.isFinite(Number(hero?.candidates)) ? Number(hero.candidates) : null,
        debug: debugMode ? (hero?.debug || null) : null,
      },
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
      meta: snapshot.meta,
    };
  });
}

/* ---------------------------
   Refresh / API
--------------------------- */
const HERO_SCRAPERS = {
  abc1: scrapeABCHero,
  cbs1: scrapeCBSHero,
  usat1: scrapeUSATHero,
  nbc1: scrapeNBCHero,
  cnn1: scrapeCNNHero,
  guardian1: scrapeGuardianHero,
  ap1: scrapeAPHero,
  latimes1: scrapeLATimesHero,
  npr1: scrapeNPRHero,
  bbc1: scrapeBBCHero,
  fox1: scrapeFoxHero,
  yahoo1: scrapeWPHero,
};

async function refreshSources({ id = "" } = {}) {
  const cache = ensureCacheShape(readCache());
  const requested = canonicalServerSourceId(id);
  const runList = buildRefreshRunList(id);
  if (id && !runList.length) {
    throw new Error(`Unknown source id: ${id}`);
  }
  const pruneResult = await pruneOldScreenshots({ hours: SCREENSHOT_RETENTION_HOURS });
  if ((pruneResult?.prunedRows || 0) > 0 || (pruneResult?.deletedObjects || 0) > 0) {
    console.log(`Screenshot prune: rows=${pruneResult.prunedRows || 0}, storage_objects=${pruneResult.deletedObjects || 0}`);
  }
  const skipped = SERVER_SOURCE_IDS.filter((sid) => !runList.includes(sid));
  const ran = [];
  const failed = [];
  if (!requested) {
    const notCovered = SERVER_SOURCE_IDS.filter((sid) => !runList.includes(sid));
    if (notCovered.length) {
      console.warn(`[guardrail] full refresh list missing source ids: ${notCovered.join(",")}`);
    }
  }

  for (const sid of runList) {
    let res;
    const prevItem = cache.sources?.[sid]?.item || null;
    const t0 = Date.now();
    try {
      const scraper = HERO_SCRAPERS[sid];
      if (!scraper) throw new Error(`No scraper registered for source id: ${sid}`);
      res = await scraper();
    } catch (err) {
      res = {
        ok: false,
        error: String(err?.message || err),
        updatedAt: nowISO(),
        runId: `${sid}_error_${new Date().toISOString().replace(/[:.]/g, "-")}`,
        item: null,
        shot: null,
      };
      failed.push(sid);
    }
    ran.push(sid);
    const durationMs = Math.max(0, Date.now() - t0);
    const observedAtIso = res?.updatedAt || nowISO();
    if (res?.item) {
      res.item.contentType = inferContentType({ url: res.item.url, title: res.item.title });
    }
    const finalUrl = res?.meta?.final_url || res?.item?.url || null;
    const httpStatus = Number.isFinite(Number(res?.meta?.http_status)) ? Number(res.meta.http_status) : null;
    const blockedInfo = detectBlocked({
      httpStatus,
      finalUrl,
      pageTitle: res?.meta?.page_title || null,
      errorText: res?.error || null,
    });
    const heroHash = res?.meta?.hero_html ? hashString(res.meta.hero_html) : null;

    const heroRaw = {
      source_id: sid,
      run_id: res?.runId || null,
      duration_ms: durationMs,
      final_url: finalUrl,
      http_status: httpStatus,
      blocked: Boolean(blockedInfo.blocked),
      blocked_reason: blockedInfo.blocked_reason || null,
      profile: res?.meta?.profile || "desktop",
      selector_used: res?.meta?.selector_used || null,
      candidates: res?.meta?.candidates || null,
      hero_hash: heroHash,
      run_kind: "hero",
      has_item: Boolean(res?.item),
      has_screenshot: Boolean(res?.shot?.object_path),
      scraper_error: res?.error || null,
      debug: {
        archive: Boolean(res?.archive),
      },
    };

    try {
      await insertHeroRun({
        sourceId: sid,
        observedAtIso,
        runId: res?.runId || null,
        item: res?.item || null,
        ok: Boolean(res?.ok),
        error: res?.error || null,
        raw: heroRaw,
      });
    } catch (err) {
      console.warn(`hero_runs insert failed (${sid}):`, String(err?.message || err));
    }

    if (res?.ok && res?.item) {
      try {
        await insertHeadlineEvent({
          sourceId: sid,
          observedAtIso,
          slotKey: pickHeroSlotKey(res.item),
          item: res.item,
          ok: true,
          error: null,
          raw: {
            run_kind: "hero",
            run_id: res?.runId || null,
            rank: 1,
            fingerprint: res?.item?.fingerprint || hashString(`${canonicalizeUrl(res?.item?.url) || ""}|${cleanText(res?.item?.title || "")}`),
            canonical_url: canonicalizeUrl(res?.item?.url || null),
            module: "homepage_hero",
            content_type: inferContentType({ url: res?.item?.url, title: res?.item?.title }),
            duration_ms: durationMs,
            final_url: finalUrl,
            http_status: httpStatus,
            blocked: Boolean(blockedInfo.blocked),
            blocked_reason: blockedInfo.blocked_reason || null,
            profile: res?.meta?.profile || "desktop",
            selector_used: res?.meta?.selector_used || null,
            candidates: res?.meta?.candidates || null,
            hero_hash: heroHash,
          },
        });
      } catch (err) {
        console.warn(`headline_events insert failed (${sid}):`, String(err?.message || err));
      }
    }

    if (res?.item && res?.shot?.object_path) {
      try {
        const kind = classifyScreenshotKind(prevItem, res.item);
        await recordScreenshotEvent({
          ts: observedAtIso,
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

    const nextItem = res?.item || prevItem || null;

    cache.sources[sid] = {
      ...cache.sources[sid],
      updated_at: observedAtIso,
      ok: Boolean(res.ok),
      stale: !res.ok,
      item: nextItem,
      last: {
        runId: res.runId || null,
        ok: Boolean(res.ok),
        error: res.error || null,
        fetchedAt: observedAtIso,
        shot: res.shot || null,
      },
    };

    if (res.archive) {
      cache.sources[sid].archive = cache.sources[sid].archive || [];
      cache.sources[sid].archive.unshift(res.archive);
      cache.sources[sid].archive = cache.sources[sid].archive.slice(0, 30);
    }
  }
  console.log(`[refresh] requested=${requested || "all"} ran=${ran.join(",")} skipped=${skipped.join(",") || "-"} failed=${failed.join(",") || "-"}`);

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

app.get("/api/debug/wp", async (_req, res) => {
  try {
    const result = await scrapeWPHero({ debug: true });
    const blockedInfo = detectBlocked({
      httpStatus: result?.meta?.http_status || null,
      finalUrl: result?.meta?.final_url || result?.item?.url || null,
      pageTitle: result?.meta?.page_title || null,
      errorText: result?.error || null,
    });
    res.json({
      ok: Boolean(result?.ok),
      source: "yahoo1",
      publisher: "Yahoo News",
      error: result?.error || null,
      item: result?.item || null,
      blocked: blockedInfo,
      runId: result?.runId || null,
      meta: result?.meta || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, source: "yahoo1", error: String(err?.message || err) });
  }
});

app.get("/api/debug/yahoo", async (_req, res) => {
  try {
    const result = await scrapeWPHero({ debug: true });
    const blockedInfo = detectBlocked({
      httpStatus: result?.meta?.http_status || null,
      finalUrl: result?.meta?.final_url || result?.item?.url || null,
      pageTitle: result?.meta?.page_title || null,
      errorText: result?.error || null,
    });
    res.json({
      ok: Boolean(result?.ok),
      source: "yahoo1",
      publisher: "Yahoo News",
      error: result?.error || null,
      item: result?.item || null,
      blocked: blockedInfo,
      runId: result?.runId || null,
      meta: result?.meta || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, source: "yahoo1", publisher: "Yahoo News", error: String(err?.message || err) });
  }
});

// POST /api/top10/refresh?source=abc1
// POST /api/refresh_top10
async function handleTop10Refresh(req, res) {
  try {
    const source = String(req.query?.source || req.body?.source || "abc1").toLowerCase();
    if (source !== "abc1") {
      return res.status(400).json({ ok: false, error: "Only source=abc1 is supported right now." });
    }

    const t0 = Date.now();
    const top10 = await scrapeABCTop10();
    const observedAtIso = top10?.observedAt || nowISO();
    const durationMs = Math.max(0, Date.now() - t0);
    const finalUrl = top10?.meta?.final_url || null;
    const httpStatus = Number.isFinite(Number(top10?.meta?.http_status)) ? Number(top10.meta.http_status) : null;
    const blockedInfo = detectBlocked({
      httpStatus,
      finalUrl,
      pageTitle: top10?.meta?.page_title || null,
      errorText: top10?.error || null,
    });

    let inserted = 0;
    try {
      const result = await insertTop10Snapshot({
        sourceId: "abc1",
        observedAtIso,
        runId: top10?.runId || null,
        items: top10?.items || [],
        raw: {
          source_id: "abc1",
          run_id: top10?.runId || null,
          run_kind: "top10",
          duration_ms: durationMs,
          final_url: finalUrl,
          http_status: httpStatus,
          blocked: Boolean(blockedInfo.blocked),
          blocked_reason: blockedInfo.blocked_reason || null,
          profile: top10?.meta?.profile || "desktop",
          selector_used: top10?.meta?.selector_used || null,
          candidates: top10?.meta?.candidates || null,
          hero_hash: null,
          expected_count: 10,
          observed_count: Array.isArray(top10?.items) ? top10.items.length : 0,
          scrape_ok: Boolean(top10?.ok),
          scrape_error: top10?.error || null,
        },
      });
      inserted = Number(result?.inserted || 0);
    } catch (dbErr) {
      console.warn("top10 headline_events insert failed (abc1):", String(dbErr?.message || dbErr));
    }

    return res.json({
      ok: Boolean(top10?.ok),
      source: "abc1",
      observedAt: observedAtIso,
      runId: top10?.runId || null,
      inserted,
      expected: 10,
      found: Array.isArray(top10?.items) ? top10.items.length : 0,
      error: top10?.error || null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

app.post("/api/top10/refresh", handleTop10Refresh);
app.post("/api/refresh_top10", handleTop10Refresh);

app.get("/api/diff", (req, res) => {
  const cache = ensureCacheShape(readCache());
  res.json({ ok: true, cache });
});

async function main() {
  const args = new Set(process.argv.slice(2));
  logSourceGuardrail();
  const missingScrapers = SERVER_SOURCE_IDS.filter((sid) => typeof HERO_SCRAPERS[sid] !== "function");
  if (missingScrapers.length) {
    console.warn(`[guardrail] missing scraper handlers for source ids: ${missingScrapers.join(",")}`);
  }

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

/*
Sample SQL: Which stories were #1 between 2pm and 4pm?
select observed_at, source_id, title, url
from public.headline_events
where source_id = 'abc1'
  and slot_key = 'top10:1'
  and observed_at >= '2026-02-18 14:00:00-08'
  and observed_at <  '2026-02-18 16:00:00-08'
order by observed_at asc;

Sample SQL: Hero slot in a time window
select observed_at, source_id, title, url, ok, error
from public.headline_events
where slot_key = 'hero:1'
  and observed_at >= now() - interval '6 hours'
order by observed_at desc;

Sample SQL: Source reliability in last 24h
select source_id,
       count(*) as attempts,
       count(*) filter (where ok) as ok_count,
       count(*) filter (where not ok) as fail_count
from public.hero_runs
where observed_at >= now() - interval '24 hours'
group by source_id
order by source_id;

Sample SQL: Blocked rate per source per day
select date_trunc('day', observed_at) as day,
       source_id,
       avg(case when coalesce((raw->>'blocked')::boolean, false) then 1 else 0 end) as blocked_rate
from public.hero_runs
where observed_at >= now() - interval '7 days'
group by 1, 2
order by day desc, source_id;

Sample SQL: Average duration_ms by source in last 24 hours
select source_id,
       avg((raw->>'duration_ms')::numeric) as avg_duration_ms
from public.hero_runs
where observed_at >= now() - interval '24 hours'
  and raw ? 'duration_ms'
group by source_id
order by avg_duration_ms desc;
*/

export {
  SOURCE_REGISTRY,
  SERVER_SOURCE_IDS,
  scrapeABCHero,
  scrapeABCTop10,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  scrapeCNNHero,
  scrapeGuardianHero,
  scrapeAPHero,
  scrapeLATimesHero,
  scrapeNPRHero,
  scrapeBBCHero,
  scrapeFoxHero,
  scrapeWPHero,
  refreshSources,
};
