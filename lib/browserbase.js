import { chromium } from 'playwright';
import { MOBILE_CONTEXT } from './mobileHero.js';

const apiOrigin = 'https://api.browserbase.com/v1';

export class BrowserInfrastructureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserInfrastructureError';
    this.code = 'NEWSBOARD_BROWSER_INFRASTRUCTURE';
  }
}

export function apBrowserProvider(env = process.env, override) {
  const provider = String(override ?? env.NEWSBOARD_AP_BROWSER_PROVIDER ?? 'local').trim();
  if (!['local', 'browserbase'].includes(provider)) {
    throw new BrowserInfrastructureError('NEWSBOARD_AP_BROWSER_PROVIDER must be local or browserbase');
  }
  return provider;
}

export function browserbaseConfig(env = process.env) {
  const apiKey = String(env.BROWSERBASE_API_KEY || '').trim();
  if (!apiKey) throw new BrowserInfrastructureError('Browserbase requires the BROWSERBASE_API_KEY server-side secret');
  const proxy = String(env.NEWSBOARD_AP_BROWSERBASE_PROXY || 'false').trim();
  if (!['true', 'false'].includes(proxy)) throw new BrowserInfrastructureError('NEWSBOARD_AP_BROWSERBASE_PROXY must be true or false');
  return {
    apiKey,
    projectId: String(env.BROWSERBASE_PROJECT_ID || '').trim(),
    contextId: String(env.BROWSERBASE_CONTEXT_ID || '').trim(),
    proxy: proxy === 'true',
  };
}

// Browserbase owns the browser; use its default context so an optional persisted
// profile survives. A new incognito context would discard that profile.
export async function withBrowserbaseAPPage(fn, {
  env = process.env, fetchImpl = globalThis.fetch,
  connect = (url, options) => chromium.connectOverCDP(url, options),
} = {}) {
  const config = browserbaseConfig(env);
  const request = async (route, body) => {
    let response;
    try {
      response = await fetchImpl(`${apiOrigin}/${route}`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-BB-API-Key': config.apiKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
    } catch {
      // Never include provider response bodies or connection URLs in logs: they
      // can contain credentials. One bounded request, with no automatic retries.
      throw new BrowserInfrastructureError('Browserbase API request failed or timed out');
    }
    if (!response.ok) throw new BrowserInfrastructureError(`Browserbase API HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw new BrowserInfrastructureError('Browserbase API returned invalid JSON'); }
  };
  const browserSettings = {
    viewport: MOBILE_CONTEXT.viewport,
    solveCaptchas: false, advancedStealth: false,
    ...(config.contextId ? { context: { id: config.contextId, persist: true } } : {}),
  };
  const session = await request('sessions', {
    ...(config.projectId ? { projectId: config.projectId } : {}),
    browserSettings, region: 'us-west-2', timeout: 180, keepAlive: false,
    proxies: config.proxy ? [{ type: 'browserbase', geolocation: { country: 'US' } }] : false,
    userMetadata: { application: 'newsboard', source: 'ap1' },
  });
  let browser;
  const meta = {
    browser_provider: 'browserbase', browserbase_session_id: session.id,
    browserbase_region: session.region || 'us-west-2', browserbase_proxy: config.proxy,
    browserbase_persistent_context: Boolean(config.contextId),
  };
  try {
    if (!session.id || !session.connectUrl) throw new BrowserInfrastructureError('Browserbase returned an incomplete session');
    try {
      browser = await connect(session.connectUrl, { timeout: 30000 });
    } catch {
      throw new BrowserInfrastructureError('Browserbase browser connection failed or timed out');
    }
    let page;
    try {
      const context = browser.contexts()[0];
      if (!context) throw new Error('No default browser context');
      page = context.pages()[0] || await context.newPage();
      await page.setViewportSize(MOBILE_CONTEXT.viewport);
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          ...MOBILE_CONTEXT.viewport, deviceScaleFactor: MOBILE_CONTEXT.deviceScaleFactor,
          mobile: true, screenWidth: MOBILE_CONTEXT.screen.width, screenHeight: MOBILE_CONTEXT.screen.height,
        });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_CONTEXT.userAgent, platform: 'Android' });
      } finally { await cdp.detach(); }
    } catch {
      throw new BrowserInfrastructureError('Browserbase mobile browser setup failed');
    }
    return await fn(page, meta);
  } finally {
    // Explicitly release even when CDP connection/setup failed. The short remote
    // timeout is a second bound on usage if release itself fails.
    if (session.id) {
      await request(`sessions/${encodeURIComponent(session.id)}`, { status: 'REQUEST_RELEASE' })
        .catch(error => console.warn(`Browserbase session release failed: ${error.message}`));
    }
    await browser?.close().catch(() => {});
  }
}
