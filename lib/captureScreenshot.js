import { dismissOverlays } from "./dismissOverlays.js";

const DEFAULT_PROFILE = {
  viewportWidth: 1280,
  viewportHeight: 720,
  scrollY: 0,
  settleMs: 700,
};

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProfile(profile = {}) {
  const p = { ...DEFAULT_PROFILE, ...(profile || {}) };
  return {
    viewportWidth: Math.max(320, Math.floor(toNum(p.viewportWidth, DEFAULT_PROFILE.viewportWidth))),
    viewportHeight: Math.max(320, Math.floor(toNum(p.viewportHeight, DEFAULT_PROFILE.viewportHeight))),
    scrollY: Math.max(0, Math.floor(toNum(p.scrollY, DEFAULT_PROFILE.scrollY))),
    settleMs: Math.max(0, Math.floor(toNum(p.settleMs, DEFAULT_PROFILE.settleMs))),
    debug: Boolean(p.debug),
    sourceId: p.sourceId || "",
  };
}

export async function captureScreenshot(page, profile) {
  const p = normalizeProfile(profile);
  const log = p.debug ? (...args) => console.log("[screenshot]", ...args) : () => {};

  await page.setViewportSize({ width: p.viewportWidth, height: p.viewportHeight });
  await page.waitForTimeout(300);

  await dismissOverlays(page, { debug: p.debug });

  if (p.scrollY > 0) {
    try {
      await page.evaluate((y) => window.scrollTo(0, y), p.scrollY);
    } catch {}
    await page.waitForTimeout(p.settleMs);
    await dismissOverlays(page, { debug: p.debug });
  }

  let finalScrollY = 0;
  try {
    finalScrollY = await page.evaluate(() => window.scrollY || window.pageYOffset || 0);
  } catch {}

  log(
    `source=${p.sourceId || "unknown"} profile=${JSON.stringify({
      viewportWidth: p.viewportWidth,
      viewportHeight: p.viewportHeight,
      scrollY: p.scrollY,
      settleMs: p.settleMs,
    })} finalScrollY=${finalScrollY}`,
  );

  // Let screenshot errors surface to caller.
  return await page.screenshot({
    type: "jpeg",
    quality: 70,
    fullPage: false,
  });
}
