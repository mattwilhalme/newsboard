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
   CBS (single top item)
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

      const main = document.querySelector("main") || document.body;

      // Prefer the first headline link
      const a = main.querySelector('a[href*="/news/"] h3, a[href*="/news/"] h2')?.closest("a[href]");
      if (a) {
        const title = clean(a.textContent || "");
        const url = abs(a.getAttribute("href") || "");
        if (title && url) return { ok: true, title, url };
      }

      // fallback: first anchor with meaningful text
      const links = Array.from(main.querySelectorAll("a[href]"))
        .map((a2) => {
          const url = abs(a2.getAttribute("href") || "");
          const title = clean(a2.getAttribute("aria-label") || a2.textContent || "");
          if (!url || !title || title.length < 12) return null;
          return { title, url };
        })
        .filter(Boolean);

      if (!links.length) return { ok: false, error: "CBS not found" };
      return { ok: true, ...links[0] };
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
   USA Today (single top item)
--------------------------- */
async function scrapeUSATHero() {
  return await withBrowser(async (page) => {
    const runId = `usat_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.usatoday.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.usatoday.com").toString();
        } catch {
          return null;
        }
      }

      const main = document.querySelector("main") || document.body;

      // Try: first h2/h3 with a link in it
      const h = main.querySelector("h1 a[href], h2 a[href], h3 a[href]");
      if (h) {
        const a = h.closest("a[href]");
        const title = clean(h.textContent || "");
        const url = abs(a?.getAttribute("href") || "");
        if (title && url) return { ok: true, title, url };
      }

      // Fallback: first "a" with aria-label
      const a2 = main.querySelector("a[aria-label][href]");
      if (a2) {
        const title = clean(a2.getAttribute("aria-label") || "");
        const url = abs(a2.getAttribute("href") || "");
        if (title && url) return { ok: true, title, url };
      }

      return { ok: false, error: "USA Today not found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: null,
          slotKey: sha1("usat1|top").slice(0, 12),
        }
      : null;

    const snapshot = { id: "usat1", fetchedAt: nowISO(), runId, ok: Boolean(item), error: item ? null : (hero?.error || "USA Today not found"), item };
    const archive = await archiveRun(page, runId, snapshot);

    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   NBC News (mobile) - single top item
--------------------------- */
async function scrapeNBCHero() {
  return await withBrowser(
    async (page) => {
      const runId = `nbc_${new Date().toISOString().replace(/[:.]/g, "-")}`;

      await page.goto("https://www.nbcnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1800);

      const hero = await page.evaluate(() => {
        function clean(s) {
          return String(s || "").replace(/\s+/g, " ").trim();
        }
        function abs(h) {
          try {
            return new URL(h, "https://www.nbcnews.com").toString();
          } catch {
            return null;
          }
        }

        const main = document.querySelector("main") || document.body;

        function isGoodNBCUrl(u) {
          if (!u) return false;
          try {
            const url = new URL(u);
            if (!/\.nbcnews\.com$/i.test(url.hostname)) return false; // avoid nbc.com, today.com, etc.
            const p = url.pathname || "";
            if (/^\/watch\b/i.test(p)) return false;
            if (/^\/podcasts?\b/i.test(p)) return false;
            if (/^\/now\b/i.test(p)) return false;
            return true;
          } catch {
            return false;
          }
        }

        // Prefer the storyline headline anchors (this is where the real top story lives).
        const preferredAnchors = Array.from(
          main.querySelectorAll(
            "h2.storyline__headline a[href], h2[class*='storyline__headline'] a[href], h2.styles_headline__Gk6tj a[href], h2.styles_headline__ a[href]"
          )
        );

        for (const a of preferredAnchors) {
          const title = clean(a.textContent || "");
          const url = abs(a.getAttribute("href") || "");
          if (!title || title.length < 12) continue;
          if (!url) continue;
          if (!isGoodNBCUrl(url)) continue;
          if (/\/video\//i.test(url)) continue;
          return { ok: true, title, url };
        }

        // Fallback: any meaningful link inside main that points to nbcnews.com.
        const links = Array.from(main.querySelectorAll("a[href]"))
          .map((a) => {
            // Avoid header/nav menus where “More From NBC” lives.
            if (a.closest("nav") || a.closest("header") || a.closest(".menu-section")) return null;
            const title = clean(a.getAttribute("aria-label") || a.textContent || "");
            const url = abs(a.getAttribute("href") || "");
            if (!title || title.length < 12) return null;
            if (!url || !isGoodNBCUrl(url)) return null;
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
   CNN (single top item) - lead-package container
--------------------------- */
async function scrapeCNNHero() {
  return await withBrowser(async (page) => {
    const runId = `cnn1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cnn.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
      }
      function abs(h) {
        try {
          return new URL(h, "https://www.cnn.com").toString();
        } catch {
          return null;
        }
      }
      function pickImg(el) {
        if (!el) return null;

        // CNN often stores the canonical image URL on a div.image[data-url]
        const dataUrl =
          el.querySelector?.("div.image[data-url]")?.getAttribute("data-url") ||
          el.querySelector?.("[data-url]")?.getAttribute?.("data-url");
        if (dataUrl) return dataUrl;

        // Or a normal img/picture
        const img = el.querySelector?.("img");
        const src = img?.getAttribute?.("src") || img?.src;
        if (src) return src;

        const source = el.querySelector?.("source[srcset]");
        const srcset = source?.getAttribute?.("srcset") || "";
        if (srcset) {
          const first = srcset.split(",")[0]?.trim()?.split(" ")[0];
          if (first) return first;
        }

        return null;
      }

      const main = document.querySelector("main") || document.body;

      // Primary: lead package container
      const lead =
        main.querySelector(".container_lead-package") ||
        main.querySelector("[class*='lead-package']") ||
        main.querySelector("[data-zone-label='lead-package']");

      const scope = lead || main;

      // CNN headline in lead package is often an h2 with text, link is on surrounding <a>
      const h2 =
        scope.querySelector("h2.container__title_url-text") ||
        scope.querySelector("h2[class*='container__title']") ||
        scope.querySelector("h1, h2");

      const title = clean(h2?.textContent || "");
      if (!title || title.length < 8) return { ok: false, error: "CNN: headline not found" };

      const a =
        h2?.closest?.("a[href]") ||
        h2?.querySelector?.("a[href]") ||
        scope.querySelector("a.container__link[href]") ||
        scope.querySelector("a[href]");

      const href = a?.getAttribute?.("href") || "";
      const url = href ? abs(href) : null;
      if (!url) return { ok: false, error: "CNN: URL not found" };

      // Skip video pages when possible
      if (/\/videos?\//i.test(url)) return { ok: false, error: "CNN: lead appears to be video" };

      const imgUrl = pickImg(lead) || pickImg(a) || pickImg(h2);

      return { ok: true, title, url, imgUrl: imgUrl || null };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
          slotKey: sha1("cnn1|top").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "cnn1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "CNN not found"),
      item,
    };

    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   Reuters (single top item) - JSON-LD ItemList -> open story -> grab H1
--------------------------- */
async function scrapeReutersHero() {
  return await withBrowser(async (page) => {
    const runId = `reuters1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    // 1) Go to homepage
    await page.goto("https://www.reuters.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1200);

    // 2) Pull top URL from JSON-LD (ItemList)
    const topUrl = await page.evaluate(() => {
      function safeJsonParse(s) {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      }

      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of scripts) {
        const txt = s.textContent || "";
        const data = safeJsonParse(txt);
        if (!data) continue;

        // Reuters sometimes has multiple JSON-LD scripts; we want the CollectionPage -> ItemList
        const mainEntity = data.mainEntity;
        if (!mainEntity) continue;

        const list = mainEntity.itemListElement;
        if (!Array.isArray(list) || !list.length) continue;

        // position 1 preferred; otherwise first entry
        const pos1 = list.find((x) => String(x?.position) === "1" && x?.url);
        const first = pos1?.url || list[0]?.url;
        if (typeof first === "string" && first.startsWith("http")) return first;
      }

      return null;
    });

    if (!topUrl) {
      const snapshot = {
        id: "reuters1",
        fetchedAt: nowISO(),
        runId,
        ok: false,
        error: "Reuters: JSON-LD ItemList not found",
        item: null,
      };
      const archive = await archiveRun(page, runId, snapshot);
      return { ok: false, error: snapshot.error, updatedAt: nowISO(), runId, archive, item: null };
    }

    // 3) Open the story URL and scrape the real headline
    await page.goto(topUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1200);

    const story = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
      }

      const h1 =
        document.querySelector("h1") ||
        document.querySelector('[data-testid="Heading"]') ||
        document.querySelector('[class*="headline"] h1, [class*="headline"] h2');

      const title = clean(h1?.textContent || "");
      const canonical =
        document.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
        location.href;

      const ogImg =
        document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
        document.querySelector('meta[name="twitter:image"]')?.getAttribute("content") ||
        null;

      return {
        ok: Boolean(title && canonical),
        title: title || null,
        url: canonical || null,
        imgUrl: ogImg || null,
      };
    });

    const item =
      story?.ok
        ? {
            title: cleanText(story.title),
            url: normalizeUrl(story.url),
            imgUrl: story.imgUrl ? normalizeUrl(story.imgUrl) : null,
            slotKey: sha1("reuters1|top").slice(0, 12),
          }
        : null;

    const snapshot = {
      id: "reuters1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : "Reuters: story page missing headline/url",
      item,
    };

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
  refreshSources,
};