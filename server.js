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

  page.on("pageerror", (err) => {
    const msg = String(err || "");
    // Reuters (and some others) can throw benign analytics errors like ".track" being undefined.
    // Filter those to keep logs actionable.
    if (/reading 'track'|\.track\b/i.test(msg)) return;
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

  try {
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
  } catch {}

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(snapshotObj, null, 2), "utf8");
  } catch {}

  return { htmlPath, jsonPath };
}

/* ---------------------------
   ABC (single top item)
--------------------------- */
async function scrapeABCHero() {
  return await withBrowser(async (page) => {
    const runId = `abc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://abcnews.go.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("main", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\s+/g, " ")
          .trim();
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

      const scope = first.closest('[data-testid="prism-card"]') || first.closest("article") || main;
      const img = scope.querySelector("img[src]");
      const imgUrl = img?.getAttribute("src") ? abs(img.getAttribute("src")) : null;

      return { ok: true, url, title, imgUrl };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
          slotKey: sha1("abc1|top").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "abc1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "ABC not found"),
      item,
    };

    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   CBS (single top item)
--------------------------- */
async function scrapeCBSHero() {
  return await withBrowser(async (page) => {
    const runId = `cbs1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cbsnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("main", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1400);

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

      const candidates = Array.from(main.querySelectorAll('article, a[href*="/news/"], a[href^="/"]'))
        .map((el) => {
          const a = el.tagName === "A" ? el : el.querySelector("a[href]");
          if (!a) return null;

          const href = a.getAttribute("href") || "";
          const url = abs(href);

          const title =
            clean(a.getAttribute("aria-label") || "") ||
            clean(el.querySelector("h1,h2,h3")?.textContent || "") ||
            clean(a.textContent || "");

          if (!url || !title || title.length < 8) return null;

          const scope = a.closest("article") || el;
          const img = scope.querySelector("img[src], img[srcset]");
          const imgUrl = img?.getAttribute("src") ? abs(img.getAttribute("src")) : null;

          let score = 0;
          if (scope.querySelector("h1")) score += 200;
          if (scope.querySelector("h2")) score += 140;
          if (scope.querySelector("h3")) score += 80;
          if (imgUrl) score += 20;
          if (/\/video\//i.test(url)) score -= 100;
          if (/\/photos\//i.test(url)) score -= 80;

          return { title, url, imgUrl, score };
        })
        .filter(Boolean);

      if (!candidates.length) return { ok: false, error: "CBS: no candidates found" };

      candidates.sort((a, b) => b.score - a.score);
      return { ok: true, ...candidates[0] };
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
   USA Today (single top item)
--------------------------- */
async function scrapeUSATHero() {
  return await withBrowser(async (page) => {
    const runId = `usat1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.usatoday.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("main", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
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
        .map((a) => {
          const href = a.getAttribute("href") || "";
          if (!href) return null;

          const url = abs(href);
          const title = clean(a.getAttribute("aria-label") || a.textContent || "");

          if (!url || !title || title.length < 8) return null;

          const scope = a.closest("article") || a.parentElement;
          const img = scope?.querySelector?.("img[src], img[srcset]") || null;
          const imgUrl = img?.getAttribute("src") ? abs(img.getAttribute("src")) : null;

          let score = 0;
          if (scope?.querySelector?.("h1")) score += 200;
          if (scope?.querySelector?.("h2")) score += 120;
          if (imgUrl) score += 20;
          if (/\/video\//i.test(url)) score -= 80;

          return { title, url, imgUrl, score };
        })
        .filter(Boolean);

      if (!candidates.length) return { ok: false, error: "USAT: no candidates found" };

      candidates.sort((a, b) => b.score - a.score);
      return { ok: true, ...candidates[0] };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
          slotKey: sha1("usat1|top").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "usat1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "USA Today not found"),
      item,
    };

    const archive = await archiveRun(page, runId, snapshot);
    return { ok: Boolean(item), error: snapshot.error, updatedAt: nowISO(), runId, archive, item };
  });
}

/* ---------------------------
   NBC (single top item)
--------------------------- */
async function scrapeNBCHero() {
  return await withBrowser(async (page) => {
    const runId = `nbc1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.nbcnews.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("main", { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1600);

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

      const main = document.querySelector("main") || document.body;

      const articles = Array.from(main.querySelectorAll("article"))
        .map((article, idx) => {
          const h = article.querySelector("h1,h2,h3");
          const a = article.querySelector("a[href]");
          const title = clean(h?.textContent || "");
          const url = a ? abs(a.getAttribute("href")) : null;

          if (!title || !url || title.length < 8) return null;

          const img = article.querySelector("img[src], img[srcset]");
          const imgUrl = img?.getAttribute("src") ? abs(img.getAttribute("src")) : null;

          let score = 0;
          if (article.querySelector("h1")) score += 220;
          else if (article.querySelector("h2")) score += 150;
          else if (article.querySelector("h3")) score += 90;
          if (imgUrl) score += 20;
          score += Math.max(0, 50 - idx);

          return { title, url, imgUrl, score, idx };
        })
        .filter(Boolean);

      if (!articles.length) return { ok: false, error: "NBC: no article candidates found" };

      articles.sort((a, b) => b.score - a.score || a.idx - b.idx);
      return { ok: true, ...articles[0] };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
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
  });
}

/* ---------------------------
   CNN (single top item) - lead-package container + selected card URL + smart image override
--------------------------- */
async function scrapeCNNHero() {
  return await withBrowser(async (page) => {
    const runId = `cnn1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cnn.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
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

      function bestFromSrcset(srcset) {
        if (!srcset) return null;
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        if (!parts.length) return null;

        let best = null;
        for (const p of parts) {
          const [u, w] = p.split(/\s+/);
          const width = w && w.endsWith("w") ? Number(w.slice(0, -1)) : 0;
          if (!best || width > best.width) best = { url: u, width };
        }
        return best?.url || parts[parts.length - 1].split(/\s+/)[0] || null;
      }

      const heroMedia = document.querySelector(".container_lead-package__item-media, .container__item-media");
      const heroTitle =
        document.querySelector(".container_lead-package__title_url-text, .container__title_url-text") ||
        document.querySelector("h1, h2");

      if (!heroTitle) return { ok: false, error: "CNN: hero title not found" };

      const title = clean(heroTitle.textContent || "");
      if (!title || title.length < 8) return { ok: false, error: "CNN: empty title" };

      let url = null;
      const a =
        heroTitle.closest("a[href]") ||
        heroTitle.parentElement?.querySelector?.("a[href]") ||
        heroTitle.querySelector?.("a[href]") ||
        null;
      if (a) url = abs(a.getAttribute("href"));

      if (!url) {
        const maybe = heroTitle.closest("article")?.querySelector?.("a[href]") || null;
        if (maybe) url = abs(maybe.getAttribute("href"));
      }

      if (!url) return { ok: false, error: "CNN: hero URL not found" };

      // Try to find best hero image
      let imgUrl = null;
      const img = heroMedia?.querySelector?.("img[src], img[srcset]") || null;
      if (img?.getAttribute("src")) imgUrl = abs(img.getAttribute("src"));
      else if (img?.getAttribute("srcset")) imgUrl = abs(bestFromSrcset(img.getAttribute("srcset")));

      // CNN sometimes uses data-url on a container div; prefer it if present
      const dataUrl = heroMedia?.querySelector?.("[data-url]")?.getAttribute?.("data-url") || null;
      if (dataUrl) imgUrl = abs(dataUrl);

      return { ok: true, title, url, imgUrl };
    });

    let finalTitle = hero?.title || "";
    let finalUrl = hero?.url || "";
    let finalImgUrl = hero?.imgUrl || null;

    // If URL is missing but title exists, try fallback scan
    if (!finalUrl && finalTitle) {
      const alt = await page.evaluate(() => {
        function clean(s) {
          return String(s || "")
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

        const titleEl =
          document.querySelector(".container_lead-package__title_url-text, .container__title_url-text") ||
          document.querySelector("h1, h2");
        if (!titleEl) return null;

        const title = clean(titleEl.textContent || "");
        const link = titleEl.closest("a[href]") || titleEl.parentElement?.querySelector?.("a[href]") || null;
        const url = link ? abs(link.getAttribute("href")) : null;

        if (!title || !url) return null;
        return { title, url };
      });

      if (alt?.url) {
        finalTitle = alt.title;
        finalUrl = alt.url;
      }
    }

    const item = hero?.ok
      ? {
          title: cleanText(finalTitle),
          url: normalizeUrl(finalUrl),
          imgUrl: finalImgUrl ? normalizeUrl(finalImgUrl) : null,
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
   Reuters (single top item) - prefer tpl-hero StoryCard with TitleHeading + TitleLink + hero media
--------------------------- */
async function scrapeReutersHero() {
  return await withBrowser(async (page) => {
    const runId = `reuters1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.reuters.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    // Reuters often renders quickly, but story cards can settle a beat later.
    await page
      .waitForSelector('main [data-testid="StoryCard"] [data-testid="TitleHeading"]', { timeout: 25000 })
      .catch(() => {});
    await page.waitForTimeout(1200);

    const hero = await page.evaluate(() => {
      function clean(s) {
        return String(s || "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      function abs(h) {
        try {
          return new URL(h, "https://www.reuters.com").toString();
        } catch {
          return null;
        }
      }

      function bestFromSrcset(srcset) {
        if (!srcset) return null;
        const parts = srcset
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        if (!parts.length) return null;

        let best = null;
        for (const p of parts) {
          const [u, w] = p.split(/\s+/);
          const width = w && w.endsWith("w") ? Number(w.slice(0, -1)) : 0;
          if (!best || width > best.width) best = { url: u, width };
        }
        return best?.url || parts[parts.length - 1].split(/\s+/)[0] || null;
      }

      // Prefer explicit main-content if present
      const main = document.querySelector("main#main-content") || document.querySelector("main") || document.body;

      const cards = Array.from(main.querySelectorAll('[data-testid="StoryCard"]'));
      if (!cards.length) {
        return {
          ok: false,
          error: "Reuters: story cards not found",
          debug: {
            hasMain: Boolean(document.querySelector("main")),
            hasMainContent: Boolean(document.querySelector("main#main-content")),
            storyCardCount: 0,
          },
        };
      }

      function pickImageUrl(card) {
        // Common patterns: eager img, lazy img with srcset, or <source srcset> in <picture>
        const img =
          card.querySelector('img[data-testid="EagerImage"][src], img[data-testid="EagerImage"][srcset]') ||
          card.querySelector("img[src], img[srcset]") ||
          null;

        if (img) {
          const src = img.getAttribute("src") || "";
          const srcset = img.getAttribute("srcset") || "";
          let u = src || bestFromSrcset(srcset);
          return u ? abs(u) : null;
        }

        const source = card.querySelector("picture source[srcset]");
        if (source) {
          const u = bestFromSrcset(source.getAttribute("srcset") || "");
          return u ? abs(u) : null;
        }

        return null;
      }

      const ranked = cards
        .map((card, idx) => {
          const titleEl = card.querySelector('[data-testid="TitleHeading"]');
          const linkEl =
            card.querySelector('a[data-testid="TitleLink"][href]') ||
            card.querySelector('a[href*="/article/"], a[href^="/"]') ||
            card.querySelector("a[href]");

          const title = clean(titleEl?.textContent || "");
          const relHref = linkEl?.getAttribute("href") || null;
          const url = relHref ? abs(relHref) : null;

          if (!title || !url) return null;

          const cls = String(card.className || "");
          const titleCls = String(titleEl?.className || "");
          const linkCls = String(linkEl?.className || "");

          // Reuters hero card uses story-card-module__tpl-hero__... (substring match is key)
          const isHeroTpl = cls.includes("__tpl-hero__") || cls.includes("tpl-hero");
          const isHeadline =
            titleCls.includes("heading_4") ||
            titleCls.includes("heading_5") ||
            titleCls.includes("heading_6") ||
            titleCls.includes("heading-module__heading_4") ||
            titleCls.includes("heading-module__heading_5") ||
            titleCls.includes("heading-module__heading_6");

          const hasDateLine = Boolean(card.querySelector('[data-testid="DateLineText"]'));

          const hasDescription = Boolean(card.querySelector('[data-testid="Description"]'));
          const hasMedia = Boolean(
            card.querySelector('[data-testid*="Media"], picture, img[src], img[srcset], source[srcset]')
          );

          const imgUrl = pickImageUrl(card);

          let score = 0;
          if (isHeroTpl) score += 500;
          if (isHeadline) score += 250;
          if (hasDateLine) score += 40;
          if (hasDescription) score += 90;
          if (hasMedia) score += 60;
          if (imgUrl) score += 30;

          // De-prioritize non-news content types
          if (/\/video\//i.test(url)) score -= 120;
          if (/\/pictures\//i.test(url)) score -= 80;
          if (/\/podcasts?\//i.test(url)) score -= 200;
          if (/\/graphics?\//i.test(url)) score -= 80;

          return {
            title,
            url,
            imgUrl,
            score,
            idx,
            debug: {
              cardClass: cls || null,
              titleClass: titleCls || null,
              linkClass: linkCls || null,
              isHeroTpl,
              isHeadline,
              hasDateLine,
              hasDescription,
              hasMedia,
            },
          };
        })
        .filter(Boolean);

      if (!ranked.length) {
        return {
          ok: false,
          error: "Reuters: title/url not found in story cards",
          debug: {
            storyCardCount: cards.length,
          },
        };
      }

      ranked.sort((a, b) => b.score - a.score || a.idx - b.idx);
      const best = ranked[0];

      return { ok: true, title: best.title, url: best.url, imgUrl: best.imgUrl || null, debug: best.debug };
    });

    const item = hero?.ok
      ? {
          title: cleanText(hero.title),
          url: normalizeUrl(hero.url),
          imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
          slotKey: sha1("reuters1|top").slice(0, 12),
        }
      : null;

    const snapshot = {
      id: "reuters1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "Reuters not found"),
      item,
      debug: hero?.debug || null,
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
  const cache = ensureCacheShape(readCache());
  res.json({ ok: true, cache });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

if (process.argv.includes("--refresh")) {
  // CLI refresh mode: run scrapes and write cache.json then exit.
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
  app.listen(PORT, () => {
    console.log(`Newsboard server listening on http://localhost:${PORT}`);
  });
}

export {
  scrapeABCHero,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  scrapeCNNHero,
  scrapeReutersHero,
};