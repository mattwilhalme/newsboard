import { MOBILE_ADAPTERS } from './mobileHero.js';

const interstitialTitle = /just a moment|checking your browser|verify.*human|access denied|robot check/i;

// A managed interstitial may return 403 before its own JavaScript navigates to
// the homepage. Let ordinary rendering finish once; never interact with a
// challenge, reuse clearance tokens, or retry a denied request.
export async function loadAPHomepage(page, { navigationTimeout = 45000, renderTimeout = 15000, interstitialTimeout = 10000 } = {}) {
  let httpStatus = null, initialStatus = null, initialTitle = '', waited = false;
  const responses = [];
  const recordResponse = response => {
    const request = response.request();
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    httpStatus = response.status();
    responses.push({ status: httpStatus, url: response.url() });
  };
  page.on('response', recordResponse);
  const metadata = () => ({
    http_status: httpStatus, initial_http_status: initialStatus,
    initial_page_title: initialTitle, waited_for_interstitial: waited,
    document_responses: responses,
  });
  try {
    const response = await page.goto(MOBILE_ADAPTERS.ap1.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
    initialStatus = response?.status() ?? null;
    httpStatus ??= initialStatus;
    initialTitle = await page.title();
    const interstitial = interstitialTitle.test(initialTitle);
    // Rate limits and definitive denials should retain the existing backoff.
    if (initialStatus >= 400 && !(initialStatus === 403 && interstitial)) {
      return { ok: false, error: `Mobile homepage HTTP ${initialStatus}`, ...metadata(), access_blocked: [403, 429].includes(initialStatus) };
    }
    waited = interstitial;
    await page.locator(MOBILE_ADAPTERS.ap1.modules).first().waitFor({ state: 'visible', timeout: interstitial ? interstitialTimeout : renderTimeout });
    if (httpStatus >= 400 || interstitialTitle.test(await page.title())) {
      return { ok: false, error: `AP access interstitial did not clear (HTTP ${httpStatus})`, ...metadata(), access_blocked: true };
    }
    return { ok: true, ...metadata(), access_blocked: false };
  } catch (error) {
    const blocked = [403, 429].includes(httpStatus) || waited || interstitialTitle.test(await page.title().catch(() => ''));
    return { ok: false, error: blocked ? `AP access interstitial did not clear (HTTP ${httpStatus ?? 'unknown'}); ${error.message}` : error.message, ...metadata(), access_blocked: blocked };
  } finally {
    page.off('response', recordResponse);
  }
}
