(function installNewsboardData(global) {
  const rpcCache = new Map();
  let configPromise = null;
  const configUrl = "./supabase.json";

  function normalizeError(error, fallback = "Live data request failed") {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") return new Error(`${fallback}: timed out`);
    const message = String(error?.message || error || "").replace(/\s+/g, " ").trim();
    return new Error(message || fallback);
  }

  async function requestJson(url, options = {}) {
    const timeoutMs = Number(options.timeoutMs || 12000);
    const init = { ...options };
    delete init.timeoutMs;
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs), ...init });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      return body;
    } catch (error) { throw normalizeError(error); }
  }

  async function getConfig() {
    if (!configPromise) {
      configPromise = requestJson(`${configUrl}?ts=${Date.now()}`).then((config) => {
        if (!config?.url || !config?.anonKey) throw new Error("Supabase is not configured");
        return Object.freeze({ url: String(config.url), anonKey: String(config.anonKey) });
      }).catch((error) => { configPromise = null; throw normalizeError(error, "Supabase configuration failed"); });
    }
    return configPromise;
  }

  function cacheKey(name, args) { return `${name}${JSON.stringify(args || {})}`; }

  async function rpc(name, args = {}, options = {}) {
    const key = cacheKey(name, args);
    const ttlMs = Number(options.cacheTtlMs ?? 30000);
    const cached = rpcCache.get(key);
    if (cached && Date.now() - cached.at < ttlMs) return cached.promise;
    const promise = (async () => {
      const config = await getConfig();
      return requestJson(`${config.url}/rest/v1/rpc/${name}`, {
        method: "POST",
        timeoutMs: Number(options.timeoutMs || 12000),
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      });
    })();
    rpcCache.set(key, { at: Date.now(), promise });
    try { return await promise; }
    catch (error) { rpcCache.delete(key); throw normalizeError(error); }
  }

  function invalidate(name, args = {}) { rpcCache.delete(cacheKey(name, args)); }
  function clearCache() { rpcCache.clear(); }

  const api = {
    clearCache,
    getConfig,
    getCurrentObservations: () => rpc("newsboard_snapshot"),
    getCollectionHealth: () => rpc("newsboard_collection_health", {}, { timeoutMs: 5000 }),
    getTimeline: (hours = 12) => rpc("newsboard_timeline", { p_hours: Number(hours) }),
    getTop10: (hours = 168) => rpc("newsboard_top10", { p_hours: Number(hours) }),
    getStoryBadges: () => rpc("newsboard_story_badges", {}, { timeoutMs: 3500 }),
    getStoryHistory: (storyId) => rpc("newsboard_story_history", { p_story: storyId }, { timeoutMs: 5000 }),
    invalidateCurrentObservations: () => invalidate("newsboard_snapshot"),
    requestJson,
    normalizeError,
  };
  global.NewsboardData = Object.freeze(api);
})(globalThis);
