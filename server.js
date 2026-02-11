// server.js
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { chromium } from "playwright";

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

  if (!c.sources.abc1) c.sources.abc1 = baseSource("abc1", "ABC News", "https://abcnews.go.com/", "hero");
  if (!c.sources.cbs1) c.sources.cbs1 = baseSource("cbs1", "CBS News", "https://www.cbsnews.com/", "hero");
  if (!c.sources.usat1) c.sources.usat1 = baseSource("usat1", "USA Today", "https://www.usatoday.com/", "hero");
  if (!c.sources.nbc1) c.sources.nbc1 = baseSource("nbc1", "NBC News", "https://www.nbcnews.com/", "hero");
  if (!c.sources.cnn1) c.sources.cnn1 = baseSource("cnn1", "CNN", "https://www.cnn.com/", "hero");
  if (!c.sources.reuters1) c.sources.reuters1 = baseSource("reuters1", "Reuters", "https://www.reuters.com/", "hero");
  if (!c.sources.ap1) c.sources.ap1 = baseSource("ap1", "Associated Press", "https://apnews.com/", "hero");

  return c;
}

async function withBrowser(fn, opts = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
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

    await page.goto("https://abcnews.go.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
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
          return new URL(h, "https://abcnews.go.com").toString();
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

    const snapshot = { id: "abc1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "ABC not found"), item };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
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

    const snapshot = { id: "cbs1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "CBS not found"), item };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
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

      // Your target: a plain <a> containing the headline text
      const links = Array.from(document.querySelectorAll('a[href*="/news/"], a[href*="/us-news/"], a[href*="/world/"], a[href*="/politics/"]'));
      for (const a of links) {
        const title = clean(a.textContent || "");
        const href = a.getAttribute("href") || "";
        const url = href ? abs(href) : null;

        if (!title || title.length < 12) continue;
        if (!url) continue;

        // Avoid "More From NBC" style nav links
        if (/nbc\.com\/?$/i.test(url)) continue;

        return { ok: true, title, url };
      }

      // Fallback: first decent headline-ish link on page
      const all = Array.from(document.querySelectorAll("a[href]"));
      for (const a of all) {
        const title = clean(a.textContent || "");
        const href = a.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        if (!title || title.length < 12) continue;
        if (!url) continue;
        if (!/nbcnews\.com/i.test(url)) continue;
        return { ok: true, title, url };
      }

      return { ok: false, error: "NBC not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("nbc1|top").slice(0, 12),
        }
      : null;

    const snapshot = { id: "nbc1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "NBC not found"), item };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   CNN (single top item) - lead-plus-headlines title
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

      const h2 = document.querySelector("h2.container__title_url-text.container_lead-plus-headlines__title_url-text");
      if (h2) {
        const a = h2.closest("a[href]");
        const title = clean(h2.textContent || "");
        const href = a?.getAttribute("href") || "";
        const url = href ? abs(href) : null;
        if (title && url) return { ok: true, title, url };
      }

      // Fallback: the "collapsed text" / title attributes on the lead container
      const lead = document.querySelector(".container.container_lead-plus-headlines");
      if (lead) {
        const title = clean(lead.getAttribute("data-title") || lead.getAttribute("data-collapsed-text") || "");
        const a = lead.querySelector('a.container__title-url[href]');
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

    const snapshot = { id: "cnn1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "CNN not found"), item };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   Reuters (single top item) - JSON-LD ItemList
--------------------------- */
async function scrapeReutersHero() {
  return await withBrowser(async (page) => {
    const runId = `reuters1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.reuters.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const parsed = [];

      for (const s of scripts) {
        try {
          const txt = s.textContent || "";
          if (!txt.trim()) continue;
          parsed.push(JSON.parse(txt));
        } catch {}
      }

      // Find ItemList under CollectionPage.mainEntity OR direct ItemList
      let itemList = null;

      for (const obj of parsed) {
        if (!obj) continue;

        if (obj["@type"] === "CollectionPage" && obj.mainEntity && obj.mainEntity["@type"] === "ItemList") {
          itemList = obj.mainEntity;
          break;
        }

        if (obj["@type"] === "ItemList" && Array.isArray(obj.itemListElement)) {
          itemList = obj;
          break;
        }
      }

      if (!itemList || !Array.isArray(itemList.itemListElement)) {
        return { ok: false, error: "Reuters: JSON-LD ItemList not found" };
      }

      // Get first valid ListItem with a url
      const first = itemList.itemListElement.find((x) => x && typeof x === "object" && typeof x.url === "string" && x.url.length > 10);
      if (!first) return { ok: false, error: "Reuters: could not extract a story URL from JSON-LD" };

      return {
        ok: true,
        title: clean(first.name || first.headline || "") || null,
        url: first.url,
      };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title || "Top story"),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("reuters1|top").slice(0, 12),
        }
      : null;

    // Debug signals (useful when anti-bot pages strip JSON-LD)
    const debug = {
      title: await page.title().catch(() => null),
      ldCount: await page
        .evaluate(() => (document.querySelectorAll('script[type="application/ld+json"]').length || 0))
        .catch(() => null),
      hasConsent: await page.evaluate(() => /consent|privacy|cookie/i.test(document.body?.innerText || "")).catch(() => null),
      hasChallenge: await page.evaluate(() => /captcha|robot|challenge|cloudflare|akamai|datadome/i.test(document.documentElement?.innerHTML || "")).catch(() => null),
    };

    const snapshot = {
      id: "reuters1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "Reuters not found"),
      item,
      debug,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
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

    const snapshot = {
      id: "usat1",
      fetchedAt: nowISO(),
      runId,
      item,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "USAT not found"),
      debug: hero?.debug || null,
    };

    const archive = await archiveRun(page, runId, snapshot);

    return {
      ok: Boolean(item),
      error: snapshot.error,
      updatedAt: nowISO(),
      runId,
      archive,
      item,
    };
  });
}

/* ---------------------------
   AP (single top item) - lead promo
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

      // Prefer the lead promo block used on the homepage
      const lead = document.querySelector(".PageListStandardE-leadPromo-info");
      if (lead) {
        const a = lead.querySelector("h3.PagePromo-title a[href]");
        const title = clean(a?.querySelector(".PagePromoContentIcons-text")?.textContent || a?.textContent || "");
        const url = a ? abs(a.getAttribute("href") || "") : null;
        if (title && url) return { ok: true, title, url };
      }

      // Fallback: first title link in main content (avoid nav + descriptions)
      const main = document.querySelector("main") || document.body;
      const links = Array.from(main.querySelectorAll("h3.PagePromo-title a[href]"));
      for (const a of links) {
        const title = clean(a.querySelector(".PagePromoContentIcons-text")?.textContent || a.textContent || "");
        const url = abs(a.getAttribute("href") || "");
        if (title && url) return { ok: true, title, url };
      }

      return { ok: false, error: "AP: headline not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("ap1|top").slice(0, 12),
        }
      : null;

    const snapshot = { id: "ap1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "AP not found"), item };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   Refresh / API
--------------------------- */
async function refreshSources({ id = "" } = {}) {
  const cache = ensureCacheShape(readCache());
  const which = String(id || "").toLowerCase();
  const runList = which ? [which] : ["abc1", "cbs1", "usat1", "nbc1", "cnn1", "reuters1", "ap1"];

  for (const sid of runList) {
    let res;

    if (sid === "abc1") res = await scrapeABCHero();
    else if (sid === "cbs1") res = await scrapeCBSHero();
    else if (sid === "usat1") res = await scrapeUSATHero();
    else if (sid === "nbc1") res = await scrapeNBCHero();
    else if (sid === "cnn1") res = await scrapeCNNHero();
    else if (sid === "reuters1") res = await scrapeReutersHero();
    else if (sid === "ap1") res = await scrapeAPHero();
    else throw new Error(`Unknown source id: ${sid}`);

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
  refreshSources,
};