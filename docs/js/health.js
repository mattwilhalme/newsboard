(function installNewsboardHealth(global) {
  // The primary crawl runs every five minutes and browser observations become due
  // after seven minutes. Fifteen minutes allows one slow/missed cycle without
  // describing a normally collected observation as delayed.
  const COLLECTION_FRESHNESS_MS = 15 * 60 * 1000;

  function derivePublisherHealth(source, now = Date.now()) {
    const timestamp = source?.health?.lastSuccessfulCrawlAt || source?.updatedAt || source?.updated_at || null;
    const observedMs = Date.parse(String(timestamp || ""));
    const hasObservation = source?.ok !== false && Boolean(source?.item?.title && source?.item?.url) && Number.isFinite(observedMs);
    const crawlStatus = String(source?.health?.crawlStatus || "").toLowerCase();
    const explicitFailure = crawlStatus === "failed" || source?.health?.definitiveFailure === true || source?.health?.lastAttemptSuccess === false;
    const ageMs = hasObservation ? Math.max(0, Number(now) - observedMs) : null;
    const method = typeof source?.health?.method === "string" && source.health.method.trim()
      ? source.health.method.trim()
      : null;
    const error = typeof source?.health?.latestError === "string" && source.health.latestError.trim()
      ? source.health.latestError.trim()
      : null;

    let state = "Unknown";
    if (hasObservation && explicitFailure) state = "Issue";
    else if (hasObservation) state = ageMs <= COLLECTION_FRESHNESS_MS ? "Current" : "Delayed";
    return Object.freeze({ state, timestamp: hasObservation ? timestamp : null, ageMs, method, error });
  }

  global.NewsboardHealth = Object.freeze({ COLLECTION_FRESHNESS_MS, derivePublisherHealth });
})(globalThis);
