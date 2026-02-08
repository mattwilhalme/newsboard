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
    },
  };

  if (!raw || typeof raw !== "object") return base;
  const merged = {
    ...base,
    ...raw,
    sources: { ...base.sources, ...(raw.sources || {}) },
  };

  // Hard-enforce known keys
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

  // Lightweight diagnostics
  page.on("pageerror", (err) => console.log("[PW pageerror]", String(err).slice(0, 900)));

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

  try { fs.writeFileSync(htmlPath, await page.content(), "utf8"); } catch {}
  try { fs.writeFileSync(jsonPath, JSON.stringify(snapshotObj, null, 2), "utf8"); } catch {}

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
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){ try{ return new URL(h, location.origin).toString(); } catch { return null; } }

      const main = document.querySelector("main") || document.body;

      const first =
        main.querySelector('a[data-testid="prism-linkbase"][href]') ||
        main.querySelector('a[href*="/"]');

      if (!first) return { ok:false, error:"ABC: no link found" };

      const url = abs(first.getAttribute("href"));
      const title = clean(first.getAttribute("aria-label") || first.textContent || "");

      if (!url || !title || title.length < 8) return { ok:false, error:"ABC: missing url/title" };

      // Try nearby image
      const scope = first.closest('[data-testid="prism-card"]') || first.closest("article") || main;
      const img = scope.querySelector("img[src]");

      const imgUrl = img?.getAttribute("src") ? abs(img.getAttribute("src")) : null;

      return { ok:true, url, title, imgUrl };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("abc1|top").slice(0, 12),
    } : null;

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
    await page.waitForTimeout(1400);

    const hero = await page.evaluate(() => {
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){ try{ return new URL(h, location.origin).toString(); } catch { return null; } }

      const a =
        document.querySelector('a[href][data-testid="component-card-link"]') ||
        document.querySelector("main a[href]") ||
        document.querySelector('a[href^="/"]');

      if (!a) return { ok:false, error:"CBS: no link found" };

      const url = abs(a.getAttribute("href"));
      const title = clean(a.textContent || a.getAttribute("aria-label") || "");

      if (!url || !title || title.length < 8) return { ok:false, error:"CBS: missing url/title" };

      const scope = a.closest("article") || a.parentElement || document.body;
      const img = scope.querySelector("img[src]") || document.querySelector("main img[src]");

      const imgUrl = img ? abs(img.getAttribute("src")) : null;
      return { ok:true, url, title, imgUrl };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("cbs1|top").slice(0, 12),
    } : null;

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
/* ---------------------------
   USA Today (single top item) - target tb headline span
--------------------------- */
async function scrapeUSATHero() {
  return await withBrowser(async (page) => {
    const runId = `usat1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.usatoday.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    const hero = await page.evaluate(() => {
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){ try{ return new URL(h, location.origin).toString(); } catch { return null; } }
      function isVisible(el){
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width < 2 || r.height < 2) return false;
        // Prefer stuff actually in the viewport region near top
        return r.bottom > 0 && r.top < window.innerHeight * 1.25;
      }

      const main = document.querySelector("main") || document.body;

      // 1) Prefer the exact headline span structure you referenced
      const spans = Array.from(
        main.querySelectorAll('span[data-tb-shadow-region-title], span[data-tb-title]')
      )
        .map(sp => {
          const text = clean(sp.textContent || "");
          const r = sp.getBoundingClientRect();
          return { sp, text, top: r?.top ?? 1e9, left: r?.left ?? 1e9, ok: text.length >= 15 };
        })
        .filter(x => x.ok && isVisible(x.sp));

      if (!spans.length) return { ok:false, error:"USAT: no tb headline span found" };

      // Choose the most "hero-like" span: closest to top-left
      spans.sort((a,b) => (a.top - b.top) || (a.left - b.left));
      const bestSpan = spans[0].sp;
      const title = clean(bestSpan.textContent || "");

      // 2) Find the nearest anchor that actually navigates to the story
      const a =
        bestSpan.closest("a[href]") ||
        bestSpan.parentElement?.closest("a[href]") ||
        null;

      if (!a) return { ok:false, error:"USAT: headline span has no enclosing link" };

      const url = abs(a.getAttribute("href"));

      if (!url || !title || title.length < 8) {
        return { ok:false, error:"USAT: missing url/title" };
      }

      // 3) Image: keep it from the same card/article/container as the headline
      const scope =
        a.closest("article") ||
        a.closest('section') ||
        a.closest('div') ||
        main;

      // Prefer images that look like the hero image (wide-ish)
      const imgs = Array.from(scope.querySelectorAll("img"))
        .map(img => {
          const src = img.getAttribute("src") || "";
          const r = img.getBoundingClientRect();
          return {
            img,
            src,
            w: r?.width ?? 0,
            h: r?.height ?? 0,
            area: (r?.width ?? 0) * (r?.height ?? 0),
          };
        })
        .filter(x => x.src && x.area > 3000);

      imgs.sort((a,b) => b.area - a.area);
      const imgUrl = imgs[0]?.src ? abs(imgs[0].src) : null;

      return { ok:true, url, title, imgUrl };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("usat1|top").slice(0, 12),
    } : null;

    const snapshot = {
      id: "usat1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "USAT not found"),
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
    await page.waitForTimeout(1400);

    const hero = await page.evaluate(() => {
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){ try{ return new URL(h, location.origin).toString(); } catch { return null; } }

      const main = document.querySelector("main") || document.body;

      // Try known headline patterns first, then fall back to a reasonable first story link in main
      const a =
        main.querySelector('h2.multistoryline__headline a[href]') ||
        main.querySelector('h2 a[href]') ||
        main.querySelector('a[href^="/"]');

      if (!a) return { ok:false, error:"NBC: no link found" };

      const url = abs(a.getAttribute("href"));
      const title = clean(a.textContent || a.getAttribute("aria-label") || "");

      if (!url || !title || title.length < 8) return { ok:false, error:"NBC: missing url/title" };

      const scope =
        a.closest(".story-item") ||
        a.closest("article") ||
        a.parentElement ||
        main;

      const img =
        scope.querySelector("picture img[src]") ||
        scope.querySelector("img[src]") ||
        main.querySelector("picture img[src]") ||
        main.querySelector("img[src]") ||
        null;

      const imgUrl = img?.getAttribute("src") ? abs(img.getAttribute("src")) : null;

      return { ok:true, url, title, imgUrl };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("nbc1|top").slice(0, 12),
    } : null;

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
   CNN (single top item)
   Uses your provided structure:
   - <a class="container__link ..."> ... <span class="container__headline-text" data-editable="headline">...</span>
   - image in nearby .container__item-media; prefer img.image__dam-img src; fallback data-url on .image
--------------------------- */
async function scrapeCNNHero() {
  return await withBrowser(async (page) => {
    const runId = `cnn1_${new Date().toISOString().replace(/[:.]/g, "-")}`;

    await page.goto("https://www.cnn.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);

    const hero = await page.evaluate(() => {
      function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }
      function abs(h){
        try { return new URL(h, "https://www.cnn.com").toString(); }
        catch { return null; }
      }
      function bestFromSrcset(srcset){
        if (!srcset) return null;
        const parts = srcset.split(",").map(p => p.trim()).filter(Boolean);
        if (!parts.length) return null;
        // prefer largest "w" if present
        let best = null;
        for (const p of parts) {
          const [u, w] = p.split(/\s+/);
          const width = w && w.endsWith("w") ? Number(w.slice(0, -1)) : 0;
          if (!best || width > best.width) best = { url: u, width };
        }
        return best?.url || parts[parts.length - 1].split(/\s+/)[0] || null;
      }

      // The lead package often contains a selected <li> with the lead link.
      const leadLink =
        document.querySelector('a.container__link.container_lead-package__link[href]') ||
        document.querySelector('a.container__link[href][data-link-type="live-story"]') ||
        document.querySelector('a.container__link[href]');

      if (!leadLink) return { ok:false, error:"CNN: no lead link found" };

      const headlineSpan =
        leadLink.querySelector('span.container__headline-text[data-editable="headline"]') ||
        leadLink.querySelector("span.container__headline-text");

      const title = clean(headlineSpan?.textContent || leadLink.textContent || "");
      const url = abs(leadLink.getAttribute("href"));

      if (!url || !title || title.length < 8) {
        return { ok:false, error:"CNN: missing url/title", debug:{ hasLink:Boolean(leadLink), titleLen:title.length } };
      }

      // Image can be adjacent in a sibling/nearby container.
      // Try closest LI/card/container then find .container__item-media image.
      const host =
        leadLink.closest("li") ||
        leadLink.closest(".container__item") ||
        leadLink.parentElement ||
        document.body;

      let imgUrl = null;

      const img =
        host.querySelector(".container__item-media img.image__dam-img[src]") ||
        host.querySelector(".container__item-media img[src]") ||
        host.querySelector("img.image__dam-img[src]") ||
        null;

      if (img?.getAttribute("src")) {
        imgUrl = img.getAttribute("src");
      } else if (img?.getAttribute("srcset")) {
        imgUrl = bestFromSrcset(img.getAttribute("srcset"));
      }

      // Fallback: CNN image component sometimes has data-url with original
      if (!imgUrl) {
        const comp = host.querySelector('.container__item-media .image[data-url]') || host.querySelector('.image[data-url]');
        if (comp) imgUrl = comp.getAttribute("data-url");
      }

      imgUrl = imgUrl ? abs(imgUrl) : null;

      return { ok:true, url, title, imgUrl };
    });

    const item = hero?.ok ? {
      title: cleanText(hero.title),
      url: normalizeUrl(hero.url),
      imgUrl: hero.imgUrl ? normalizeUrl(hero.imgUrl) : null,
      slotKey: sha1("cnn1|top").slice(0, 12),
    } : null;

    const snapshot = {
      id: "cnn1",
      fetchedAt: nowISO(),
      runId,
      ok: Boolean(item),
      error: item ? null : (hero?.error || "CNN not found"),
      debug: hero?.debug || null,
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

  const runList = which ? [which] : ["abc1","cbs1","usat1","nbc1","cnn1"];

  for (const sid of runList) {
    let res;

    if (sid === "abc1") res = await scrapeABCHero();
    else if (sid === "cbs1") res = await scrapeCBSHero();
    else if (sid === "usat1") res = await scrapeUSATHero();
    else if (sid === "nbc1") res = await scrapeNBCHero();
    else if (sid === "cnn1") res = await scrapeCNNHero();
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: nowISO() });
});

app.post("/api/refresh", async (req, res) => {
  try {
    const id = req.body?.id || "";
    const out = await refreshSources({ id });
    res.json({ ok: true, cache: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/cache", (req, res) => {
  const cache = ensureCacheShape(readCache());
  res.json(cache);
});

// -------- Entrypoints --------

const isDirectRun = Boolean(process.argv[1] && process.argv[1].endsWith("server.js"));
const wantsRefresh = process.argv.includes("--refresh");

async function main() {
  if (!isDirectRun) return; // imported by another module

  if (wantsRefresh) {
    const idIdx = process.argv.indexOf("--id");
    const id = idIdx >= 0 ? String(process.argv[idIdx + 1] || "") : "";

    await refreshSources({ id });
    console.log(`Wrote ${CACHE_FILE}`);
    process.exit(0); // critical: prevent fall-through to app.listen
  }

  app.listen(PORT, () => console.log(`Newsboard server on http://localhost:${PORT}`));
}

main().catch((e) => {
  console.error("Entrypoint failed:", String(e));
  process.exit(1);
});


export {
  scrapeABCHero,
  scrapeCBSHero,
  scrapeUSATHero,
  scrapeNBCHero,
  scrapeCNNHero,
  refreshSources,
};
