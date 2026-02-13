function mkLogger(debug) {
  if (!debug) return () => {};
  return (...args) => console.log("[overlays]", ...args);
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function clickRoleButtons(scope, scopeName, log) {
  const patterns = [
    /^accept$/i,
    /^accept all$/i,
    /^i agree$/i,
    /^agree$/i,
    /^continue$/i,
    /^got it$/i,
    /^ok$/i,
    /^okay$/i,
  ];

  for (const pat of patterns) {
    try {
      const btn = scope.getByRole("button", { name: pat }).first();
      const count = await btn.count().catch(() => 0);
      if (!count) continue;
      const visible = await btn.isVisible({ timeout: 250 }).catch(() => false);
      if (!visible) continue;
      await btn.click({ timeout: 1200 });
      log(`clicked consent button in ${scopeName}: ${String(pat)}`);
      return true;
    } catch {}
  }
  return false;
}

async function clickCommonSelectors(scope, scopeName, log) {
  const selectors = [
    'button[aria-label*="close" i]',
    '[data-testid*="close" i]',
    'button:has-text("Close")',
    'button:has-text("Not now")',
    'button:has-text("No thanks")',
    'button:has-text("×")',
    'button:has-text("✕")',
  ];

  for (const sel of selectors) {
    try {
      const node = scope.locator(sel).first();
      const count = await node.count().catch(() => 0);
      if (!count) continue;
      const visible = await node.isVisible({ timeout: 250 }).catch(() => false);
      if (!visible) continue;
      await node.click({ timeout: 1200 });
      log(`clicked close selector in ${scopeName}: ${sel}`);
      return true;
    } catch {}
  }
  return false;
}

async function cleanupDomOverlays(page, log) {
  try {
    const removedCount = await page.evaluate(() => {
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      const minArea = vw * vh * 0.4;
      const doomed = [];

      const nodes = Array.from(document.querySelectorAll("body *"));
      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;

        const style = window.getComputedStyle(el);
        const pos = style.position;
        if (pos !== "fixed" && pos !== "sticky") continue;

        const z = Number.parseInt(style.zIndex || "0", 10);
        if (!Number.isFinite(z) || z < 1000) continue;

        const rect = el.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (area < minArea) continue;

        const role = (el.getAttribute("role") || "").toLowerCase();
        const cls = String(el.className || "").toLowerCase();
        const id = String(el.id || "").toLowerCase();
        const txt = (el.textContent || "").slice(0, 200).toLowerCase();
        const hasSignal =
          role === "dialog" ||
          /(modal|overlay|paywall|subscribe|consent|cookie|gdpr|privacy)/i.test(cls) ||
          /(modal|overlay|paywall|subscribe|consent|cookie|gdpr|privacy)/i.test(id) ||
          /(cookie|privacy|consent|subscribe|sign in|continue reading)/i.test(txt);
        if (!hasSignal) continue;

        doomed.push(el);
      }

      for (const el of doomed) el.remove();
      document.documentElement.style.overflow = "auto";
      document.body.style.overflow = "auto";
      return doomed.length;
    });

    if (removedCount > 0) log(`removed overlay nodes: ${removedCount}`);
    return removedCount;
  } catch {
    return 0;
  }
}

export async function dismissOverlays(page, { debug = false } = {}) {
  const log = mkLogger(debug);
  const cmpFrameRe = /(consent|onetrust|quantcast|trustarc|sourcepoint|didomi|cmp|privacy)/i;

  try {
    await page.waitForTimeout(600);
  } catch {}

  try {
    await page.keyboard.press("Escape");
    log("pressed Escape");
  } catch {}

  try {
    await clickRoleButtons(page, "main", log);
    await clickCommonSelectors(page, "main", log);
  } catch {}

  try {
    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      const url = normalizeText(frame.url());
      if (!cmpFrameRe.test(url)) continue;

      const frameName = `frame:${url.slice(0, 120)}`;
      try {
        const clickedConsent = await clickRoleButtons(frame, frameName, log);
        const clickedClose = await clickCommonSelectors(frame, frameName, log);
        if (clickedConsent || clickedClose) {
          log(`clicked in consent iframe ${frameName}`);
        }
      } catch {}
    }
  } catch {}

  await cleanupDomOverlays(page, log);
}
