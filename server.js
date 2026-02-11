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

function ensureCacheShape(raw) {
  const baseSource = (id, name, homeUrl) => ({
    id,
    name,
    homeUrl,
    updatedAt: null,
    ok: false,
    error: "Not refreshed yet",
    runId: null,
    archive: null,
    item: null,
  });

  const base = {
    generatedAt: null,
    sources: {
      abc1: baseSource("abc1", "ABC News", "https://abcnews.go.com/"),
      cbs1: baseSource("cbs1", "CBS News", "https://www.cbsnews.com/"),
      usat1: baseSource("usat1", "USA Today", "https://www.usatoday.com/"),
      nbc1: baseSource("nbc1", "NBC News", "https://www.nbcnews.com/"),
      cnn1: baseSource("cnn1", "CNN", "https://www.cnn.com/"),
      reuters1: baseSource("reuters1", "Reuters", "https://www.reuters.com/"),
    },
  };

  if (!raw || typeof raw !== "object") return base;

  const merged = {
    ...base,
    ...raw,
    sources: { ...base.sources, ...(raw.sources || {}) },
  };

  for (const k of Object.keys(base.sources)) {
    merged.sources[k] = { ...base.sources[k], ...(merged.sources[k] || {}) };
  }

  return merged;
}

function shouldAbortRequest(req) {
  const rt = req.resourceType();
  if (rt === "image" || rt === "media" || rt === "font") return true;

  const url = req.url();

  // Ad/analytics/video infra that causes most of your noise + load time
  if (
    /optimizely|doubleclick|googlesyndication|google-analytics|googletagmanager|gpt|adsystem|adservice/i.test(url) ||
    /taboola|outbrain|scorecardresearch|chartbeat|parsely|segment|quantserve/i.test(url) ||
    /imasdk|pubads|moatads|krxd|rubiconproject|openx|adsafeprotected/i.test(url)
  ) {
    return true;
  }

  return false;
}

function shouldIgnorePageError(msg) {
  // Common benign noise from publisher homepages
  return (
    /Script error/i.test(msg) ||
    /PlayerError|Stream initialization failed/i.test(msg) ||
    /reading 'track'|\.track\b/i.test(msg) ||
    /\bd is not a function\b/i.test(msg) ||
    /optimizely/i.test(msg)
  );
}

async function withBrowser(fn) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  // PRE-SCRAPER: block heavy/noisy requests
  await page.route("**/*", (route) => {
    const req = route.request();
    if (shouldAbortRequest(req)) return route.abort();
    return route.continue();
  });

  page.on("pageerror", (err) => {
    const msg = String(err || "");
    if (shouldIgnorePageError(msg)) return;
    console.log("[PW pageerror]", msg.slice(0, 900));
  });

  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function withBrowser(fn, opts = {}) {
  const mobile = Boolean(opts.mobile);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: "en-US",
    userAgent: mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  await page.route("**/*", (route) => {
    const req = route.request();
    if (shouldAbortRequest(req)) return route.abort();
    return route.continue();
  });

  page.on("pageerror", (err) => {
    const msg = String(err || "");
    if (shouldIgnorePageError(msg)) return;
    console.log("[PW pageerror]", msg.slice(0, 900));
  });

  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function archiveRun(page, runId, snapshotObj) {
  const htmlPath = path.join(ARCHIVE_DIR, `${runId}.html`);
  const jsonPath = path.join(ARCHIVE_DIR, `${runId}.json`);

  // Only archive HTML when explicitly enabled
  try {
    if (process.env.ARCHIVE_HTML === "1") {
      fs.writeFileSync(htmlPath, await page.content(), "utf8");
    }
  } catch {}

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(snapshotObj, null, 2), "utf8");
  } catch {}

  return { htmlPath, jsonPath };
}

/* ---------------------------
   ABC (headline-only)
--------------------------- */
async function scrapeABCHero() {
  return await withBrowser(async (page) => {
    const runId = `abc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://abcnews.go.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector("main", { timeout: 6000 }).catch(() => {});

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
      }
      function abs(h) {
        try {
          return new URL(h, location.origin).toString();
        } catch {
          return null;
        }
      }

      const main = document.querySelector("main") || document.body;
      const first =
        main.querySelector('a[data-testid="prism-linkbase"][href]') ||
        main.querySelector('a[href*="/"]');

      if (!first) return { ok: false, error: "ABC: no link found" };

      const url = abs(first.getAttribute("href"));
      const title = clean(first.getAttribute("aria-label") || first.textContent || "");
      if (!url || !title || title.length < 8) return { ok: false, error: "ABC: missing url/title" };

      return { ok: true, url, title };
    });

    const item = hero?.ok
      ? { title: cleanText(hero.title), url: normalizeUrl(hero.url), imgUrl: null, slotKey: sha1("abc1|top").slice(0, 12) }
      : null;

    const snapshot = { id: "abc1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "ABC not found"), item };
    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   CBS (headline-only)
--------------------------- */
async function scrapeCBSHero() {
  return await withBrowser(async (page) => {
    const runId = `cbs1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cbsnews.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector("main", { timeout: 6000 }).catch(() => {});

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.cbsnews.com").toString();
        } catch {
          return null;
        }
      }

      const main = document.querySelector("main") || document.body;
      const candidates = Array.from(main.querySelectorAll("article"))
        .map((article, idx) => {
          const a = article.querySelector("a[href]");
          const h = article.querySelector("h1,h2,h3");
          const title = clean(h?.textContent || a?.getAttribute("aria-label") || "");
          const href = a?.getAttribute("href") || null;
          const url = href ? abs(href) : null;
          if (!title || !url || title.length < 8) return null;

          let score = 0;
          if (article.querySelector("h1")) score += 220;
          if (article.querySelector("h2")) score += 150;
          if (article.querySelector("h3")) score += 90;
          score += Math.max(0, 40 - idx);

          if (/\/video\//i.test(url)) score -= 120;
          if (/\/photos\//i.test(url)) score -= 80;

          return { title, url, score, idx };
        })
        .filter(Boolean);

      if (!candidates.length) return { ok: false, error: "CBS: no candidates found" };
      candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
      return { ok: true, ...candidates[0] };
    });

    const item = hero?.ok
      ? { title: cleanText(hero.title), url: normalizeUrl(hero.url), imgUrl: null, slotKey: sha1("cbs1|top").slice(0, 12) }
      : null;

    const snapshot = { id: "cbs1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "CBS not found"), item };
    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   USA Today (headline-only)
--------------------------- */
async function scrapeUSATHero() {
  return await withBrowser(async (page) => {
    const runId = `usat1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.usatoday.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector("main", { timeout: 6000 }).catch(() => {});

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.usatoday.com").toString();
        } catch {
          return null;
        }
      }

      const main = document.querySelector("main") || document.body;
      const candidates = Array.from(main.querySelectorAll("a[href]"))
        .map((a, idx) => {
          const href = a.getAttribute("href") || "";
          const url = href ? abs(href) : null;
          const title = clean(a.getAttribute("aria-label") || a.textContent || "");
          if (!url || !title || title.length < 8) return null;

          let score = 0;
          const scope = a.closest("article") || a.parentElement;
          if (scope?.querySelector?.("h1")) score += 220;
          if (scope?.querySelector?.("h2")) score += 150;
          score += Math.max(0, 20 - idx);

          if (/\/video\//i.test(url)) score -= 80;
          return { title, url, score, idx };
        })
        .filter(Boolean);

      if (!candidates.length) return { ok: false, error: "USAT: no candidates found" };
      candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
      return { ok: true, ...candidates[0] };
    });

    const item = hero?.ok
      ? { title: cleanText(hero.title), url: normalizeUrl(hero.url), imgUrl: null, slotKey: sha1("usat1|top").slice(0, 12) }
      : null;

    const snapshot = { id: "usat1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "USA Today not found"), item };
    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   NBC (headline-only) - MOBILE rendering for durability
--------------------------- */
async function scrapeNBCHero() {
  return await withBrowser(
    async (page) => {
      const runId = `nbc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

      await page.goto("https://www.nbcnews.com/", { waitUntil: "domcontentloaded", timeout: 15000 });

      // On mobile layout, headings/links hydrate quickly; keep the wait cheap.
      await page.waitForSelector("main", { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(150);

      const hero = await page.evaluate(() => {
        function clean(s) {
          return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
        }
        function abs(h) {
          try {
            return new URL(h, "https://www.nbcnews.com").toString();
          } catch {
            return null;
          }
        }

        const main = document.querySelector("main") || document.body;

        // Strategy A: find first decent heading with a link
        const headings = Array.from(main.querySelectorAll("h1, h2, h3"));
        for (const h of headings) {
          const a = h.closest("a[href]") || h.querySelector("a[href]") || h.parentElement?.querySelector?.("a[href]");
          const title = clean(h.textContent || "");
          const href = a?.getAttribute("href") || null;
          const url = href ? abs(href) : null;

          // Filter obvious junk
          if (!title || title.length < 12) continue;
          if (!url) continue;
          if (/\/video\//i.test(url)) continue;

          return { ok: true, title, url };
        }

        // Strategy B: fallback to first “card” link with meaningful aria-label/text
        const links = Array.from(main.querySelectorAll("a[href]"))
          .map((a) => {
            const href = a.getAttribute("href") || "";
            const url = abs(href);
            const title = clean(a.getAttribute("aria-label") || a.textContent || "");
            if (!url || !title || title.length < 12) return null;
            if (/\/video\//i.test(url)) return null;
            return { title, url };
          })
          .filter(Boolean);

        if (!links.length) return { ok: false, error: "NBC mobile: no candidates found" };
        return { ok: true, ...links[0] };
      });

      const item = hero?.ok
        ? {
            title: cleanText(hero.title),
            url: normalizeUrl(hero.url),
            imgUrl: null,
            slotKey: sha1("nbc1|top").slice(0, 12),
          }
        : null;

      const snapshot = {
        id: "nbc1",
        fetchedAt: nowISO(),
        runId,
        ok: Boolean(item),
        error: item ? null : (hero?.error || "NBC not found"),
        item,
      };

      const archive = await archiveRun(page, runId, snapshot);
      return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
    },
    { mobile: true }
  );
}

/* ---------------------------
   Refresh / API
--------------------------- */
async function refreshSources({ id = "" } = {}) {
  const cache = ensureCacheShape(readCache());
  const which = String(id || "").toLowerCase();
  const runList = which ? [which] : ["abc1", "cbs1", "usat1", "nbc1", "cnn1", "reuters1"];

  for (const sid of runList) {
    let res;

    if (sid === "abc1") res = await scrapeABCHero();
    else if (sid === "cbs1") res = await scrapeCBSHero();
    else if (sid === "usat1") res = await scrapeUSATHero();
    else if (sid === "nbc1") res = await scrapeNBCHero();
    else if (sid === "cnn1") res = await scrapeCNNHero();
    else if (sid === "reuters1") res = await scrapeReutersHero();
    else throw new Error(`Unknown source id: ${sid}`);

    cache.sources[sid] = {
      ...cache.sources[sid],
      ok: res.ok,
      error: res.error || null,
      updatedAt: res.updatedAt || nowISO(),
      runId: res.runId || null,
      archive: res.archive || null,
      item: res.item || null,
    };
  }

  cache.generatedAt = nowISO();
  writeCache(cache);
  return cache;
}

app.get("/api/cache", (req, res) => {
  res.json(ensureCacheShape(readCache()));
});

app.post("/api/refresh", async (req, res) => {
  try {
    const cache = await refreshSources(req.body || {});
    res.json({ ok: true, cache });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/refresh", async (req, res) => {
  try {
    const cache = await refreshSources({ id: req.query.id || "" });
    res.json({ ok: true, cache });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/diff", (req, res) => {
  res.json({ ok: true, cache: ensureCacheShape(readCache()) });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

if (process.argv.includes("--refresh")) {
  refreshSources()
    .then((cache) => {
      console.log(`Refreshed cache.json at ${cache.generatedAt}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Refresh error:", err);
      process.exit(1);
    });
} else {
  app.listen(PORT, () => console.log(`Newsboard server listening on http://localhost:${PORT}`));
}

export {
  scrapeABCHero,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  scrapeCNNHero,
  scrapeReutersHero,
};