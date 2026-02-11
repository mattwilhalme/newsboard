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

      function bestFromSrcset(srcset) {
        // CBS srcset here is often "url 1x, url 2x"
        if (!srcset) return null;
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            const [u, scale] = p.split(/\s+/);
            let score = 0;
            if (scale && scale.endsWith("x")) score = parseFloat(scale) || 0;
            return { u, score };
          })
          .filter((x) => x.u);

        if (!parts.length) return null;
        parts.sort((a, b) => (b.score || 0) - (a.score || 0));
        return parts[0].u || null;
      }

      function pickImg(container) {
        if (!container) return null;
        const img = container.querySelector("img");
        if (!img) return null;

        const srcset = img.getAttribute("srcset") || "";
        const best = bestFromSrcset(srcset);
        const src = img.getAttribute("src") || img.src || null;

        return best || src || null;
      }

      function isStoryUrl(u) {
        if (!u) return false;
        try {
          const url = new URL(u);
          // We want actual CBS News story URLs (not empty hrefs, not generic pages)
          if (!/(\.|^)cbsnews\.com$/i.test(url.hostname)) return false;
          if (!/^\/news\//i.test(url.pathname || "")) return false;
          return true;
        } catch {
          return false;
        }
      }

      // Prefer the "Latest news" component where your target <h4.item__hed> lives.
      // In the HTML, it's:
      // <section ... id="component-latest-news" ...> ... <article class="item ... item--type-article ..."><a class="item__anchor" href=...><h4 class="item__hed">...</h4>
      const latest = document.querySelector("#component-latest-news");
      const scope = latest || document;

      // 1) First real article inside the Latest module
      // Avoid videos/live blocks that also contain h4.item__hed
      const candidates = Array.from(
        scope.querySelectorAll('article.item a.item__anchor[href]') // anchor inside article
      )
        .map((a) => {
          const article = a.closest("article");
          if (!article) return null;

          const cls = article.className || "";
          // Keep “type-article” only (skip video/live placeholders)
          if (!cls.includes("item--type-article")) return null;

          const hed = article.querySelector("h4.item__hed");
          const title = clean(hed?.textContent || "");
          const url = abs(a.getAttribute("href") || "");
          if (!title || !url || !isStoryUrl(url)) return null;

          const imgUrl = pickImg(article);
          return { title, url, imgUrl: imgUrl ? abs(imgUrl) : null };
        })
        .filter(Boolean);

      if (candidates.length) return { ok: true, ...candidates[0] };

      // 2) Fallback: first h4.item__hed whose parent anchor is a /news/ story and not inside “CBS News Live”
      const heds = Array.from(scope.querySelectorAll("h4.item__hed"));
      for (const h of heds) {
        const title = clean(h.textContent || "");
        if (!title) continue;

        const a = h.closest("a[href]");
        const url = abs(a?.getAttribute("href") || "");
        if (!url || !isStoryUrl(url)) continue;

        // Avoid the always-on “CBS News 24/7” live module
        const componentHeadline = h.closest("a")?.querySelector("h4.item__component-headline");
        const compText = clean(componentHeadline?.textContent || "");
        if (/cbs news live/i.test(compText)) continue;

        const article = h.closest("article");
        const imgUrl = pickImg(article);
        return { ok: true, title, url, imgUrl: imgUrl ? abs(imgUrl) : null };
      }

      return { ok: false, error: "CBS: no candidates found" };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
          slotKey: sha1("cbs1|top").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "cbs1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "CBS not found"),
      item,
    };

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
   CNN (single top item) - robust lead-plus-headlines (center hero) + image preference
--------------------------- */
async function scrapeCNNHero() {
  return await withBrowser(async (page) => {
    const runId = `cnn1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cnn.com/", { waitUntil: "domcontentloaded", timeout: 45000 });

    // CNN can hydrate late; wait for the hero headline class to appear
    await page.waitForTimeout(1200);
    await page
      .waitForSelector("h2.container__title_url-text", { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(900);

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

        // CNN canonical image URL is often on a div.image[data-url]
        const dataUrl =
          el.querySelector?.("div.image[data-url]")?.getAttribute("data-url") ||
          el.querySelector?.("[data-url]")?.getAttribute?.("data-url");
        if (dataUrl) return dataUrl;

        const img = el.querySelector?.("img");
        const src = img?.getAttribute?.("src") || img?.src;
        if (src) return src;

        const source = el.querySelector?.("source[srcset]");
        const srcset = source?.getAttribute?.("srcset") || "";
        if (srcset) {
          // take first candidate
          const first = srcset.split(",")[0]?.trim()?.split(" ")[0];
          if (first) return first;
        }
        return null;
      }

      function isBadUrl(u) {
        if (!u) return true;
        return /\/videos?\//i.test(u) || /\/video\//i.test(u);
      }

      const main = document.querySelector("main") || document.body;

      // --- 1) Preferred: lead-plus-headlines (your “big image in middle” block) ---
      const lph =
        main.querySelector(".container.container_lead-plus-headlines") ||
        main.querySelector("[class*='container_lead-plus-headlines']");

      if (lph) {
        // Candidate headline nodes: your target class first
        const h2s = Array.from(
          lph.querySelectorAll(
            "h2.container__title_url-text.container_lead-plus-headlines__title_url-text, h2.container__title_url-text"
          )
        );

        const scored = h2s
          .map((h2) => {
            const title = clean(h2.textContent || "");
            if (!title || title.length < 8) return null;

            const a =
              h2.closest("a[href]") ||
              h2.parentElement?.closest?.("a[href]") ||
              lph.querySelector("a.container__link[href]") ||
              lph.querySelector("a[href]");

            const href = a?.getAttribute?.("href") || "";
            const url = href ? abs(href) : null;
            if (!url || isBadUrl(url)) return null;

            // Prefer the selected/primary tile if present
            const li = h2.closest("li");
            const isSelected =
              li?.classList?.contains("container_lead-plus-headlines__selected") ||
              Boolean(li?.querySelector?.(".container_lead-plus-headlines__selected"));

            // Prefer the one with a real image (big hero usually has one)
            const imgUrl =
              pickImg(li) || pickImg(a) || pickImg(h2) || pickImg(h2.closest("div"));

            const hasImg = Boolean(imgUrl);

            // scoring: selected > has image > first found
            const score = (isSelected ? 100 : 0) + (hasImg ? 10 : 0);

            return { title, url, imgUrl: imgUrl || null, score };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);

        if (scored.length) return { ok: true, ...scored[0] };
      }

      // --- 2) Fallback: lead-package layout ---
      const lead =
        main.querySelector(".container_lead-package") ||
        main.querySelector("[class*='lead-package']") ||
        main.querySelector("[data-zone-label='lead-package']");

      const scope = lead || main;

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
      if (isBadUrl(url)) return { ok: false, error: "CNN: lead appears to be video" };

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
   Reuters (single top item) - /home + wait for ld+json + strong debug on failure
--------------------------- */
async function scrapeReutersHero() {
  return await withBrowser(async (page) => {
    const runId = `reuters1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.reuters.com/home/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Give it time to inject JSON-LD
    await page.waitForTimeout(1200);
    await page
      .waitForSelector('script[type="application/ld+json"]', { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(800);

    const extracted = await page.evaluate(() => {
      function safeParse(s) {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      }

      function pickFromItemList(obj) {
        const list = obj?.itemListElement;
        if (!Array.isArray(list) || !list.length) return null;
        const pos1 = list.find((x) => String(x?.position) === "1" && x?.url);
        return (pos1?.url || list[0]?.url) || null;
      }

      const html = document.documentElement?.innerHTML || "";
      const title = document.title || "";
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const texts = scripts.map((s) => s.textContent || "").filter(Boolean);

      // parse all scripts (some may be arrays)
      const nodes = [];
      for (const t of texts) {
        const p = safeParse(t);
        if (!p) continue;
        if (Array.isArray(p)) nodes.push(...p.filter(Boolean));
        else nodes.push(p);
      }

      // Try: CollectionPage -> mainEntity(ItemList)
      let topUrl = null;
      for (const n of nodes) {
        const me = n?.mainEntity;
        if (!me) continue;
        const t = me?.["@type"];
        const isItemList = t === "ItemList" || (Array.isArray(t) && t.includes("ItemList"));
        if (!isItemList) continue;
        topUrl = pickFromItemList(me);
        if (topUrl) break;
      }

      // Try: standalone ItemList
      if (!topUrl) {
        for (const n of nodes) {
          const t = n?.["@type"];
          const isItemList = t === "ItemList" || (Array.isArray(t) && t.includes("ItemList"));
          if (!isItemList) continue;
          topUrl = pickFromItemList(n);
          if (topUrl) break;
        }
      }

      return {
        topUrl,
        debug: {
          title,
          ldCount: scripts.length,
          hasConsent: /consent|privacy|cookie/i.test(html),
          hasChallenge: /captcha|robot|challenge|cloudflare|akamai/i.test(html),
          // just enough to confirm structure without dumping megabytes
          ldPreview0: texts[0]?.slice(0, 900) || null,
        },
      };
    });

    if (!extracted?.topUrl) {
      const snapshot = {
        id: "reuters1",
        fetchedAt: nowISO(),
        runId,
        ok: false,
        error: "Reuters: could not extract a story URL from JSON-LD",
        item: null,
        debug: extracted?.debug || null,
      };
      const archive = await archiveRun(page, runId, snapshot);
      return { ok: false, error: snapshot.error, updatedAt: nowISO(), runId, archive, item: null };
    }

    // Open story page and scrape headline
    await page.goto(extracted.topUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(900);

    const story = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
      }
      const h1 = document.querySelector("h1") || document.querySelector('[data-testid="Heading"]');
      const title = clean(h1?.textContent || "");
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || location.href;
      const ogImg =
        document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
        document.querySelector('meta[name="twitter:image"]')?.getAttribute("content") ||
        null;
      return { ok: Boolean(title && canonical), title, url: canonical, imgUrl: ogImg };
    });

    const item = story?.ok
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
      debug: { ...(extracted?.debug || {}), topUrl: extracted.topUrl },
    };

    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   USA Today (single top item) - hero anchor + tb-title span (incl shadow-region)
--------------------------- */
async function scrapeUSATHero() {
  return await withBrowser(async (page) => {
    const runId = `usat1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.usatoday.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Hydration can be late on USAT
    await page.waitForTimeout(1200);
    await page
      .waitForSelector('a.gnt_m_he[href][data-t-l*="|hero"]', { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(600);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "").replace(/\s+/g, " ").trim();
      }
      function absUrl(href) {
        try {
          return new URL(href, window.location.origin).toString();
        } catch {
          return null;
        }
      }
      function pickFromSrcset(srcset) {
        if (!srcset) return null;
        const parts = srcset.split(",").map((p) => p.trim()).filter(Boolean);
        if (!parts.length) return null;

        // Prefer 2x if present, else highest multiplier, else last.
        let best = null;
        for (const p of parts) {
          const [u, dpr] = p.split(/\s+/);
          const mult = dpr && dpr.endsWith("x") ? Number(dpr.slice(0, -1)) : 0;
          if (!best || mult > best.mult) best = { url: u, mult };
        }
        return best?.url || parts[parts.length - 1]?.split(/\s+/)?.[0] || null;
      }

      // Anchor-first: hero is an <a class="gnt_m_he ..." data-t-l="...|hero">
      const a =
        document.querySelector('a.gnt_m_he[href][data-t-l*="|hero"]') ||
        document.querySelector("a.gnt_m_he.gnt_m_he__br[href]") ||
        document.querySelector("a.gnt_m_he[href]");

      if (!a) {
        return {
          ok: false,
          error: "USAT: hero anchor not found (a.gnt_m_he).",
          debug: {
            hasAnyGntHero: Boolean(document.querySelector("a.gnt_m_he")),
            hasAnyHeroTL: Boolean(document.querySelector('a.gnt_m_he[data-t-l*="|hero"]')),
          },
        };
      }

      const href = a.getAttribute("href") || "";
      const url = absUrl(href);

      // Your new selector form + standard tb-title form
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