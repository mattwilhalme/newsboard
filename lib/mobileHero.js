import { devices } from 'playwright';

// Chromium's matching Android profile enables mobile viewport semantics and touch.
export const MOBILE_CONTEXT = {
  ...devices['Pixel 7'], viewport: { width: 390, height: 844 },
  screen: { width: 390, height: 844 }, deviceScaleFactor: 1,
};

export const MOBILE_ADAPTERS = {
  ap1: {
    url: 'https://apnews.com/', host: 'apnews.com', article: '^/(article|live)/',
    // AP's first StandardE module owns the lead; trending strips are outside it.
    modules: 'main .PageListStandardE',
    primary: '.PageListStandardE-leadPromo-info .PagePromo-title a[href]',
    fallback: '.PageListStandardE-leadPromo .PagePromo-title a[href], h2.PagePromo-title a[href]',
  },
  usat1: {
    url: 'https://www.usatoday.com/', host: 'usatoday.com', article: '^/(story|live-story)/',
    // The mobile hero is a direct child of main, before the smaller story list.
    breaking: 'a.gnt_n_bn_hl.gnt_n_bn_ce[href]',
    modules: 'main', primary: 'a.gnt_m_hm[data-t-l*="hero"][href]',
    fallback: 'a[data-t-l*="hero"][data-tb-region="Top Table"][href], a.gnt_m_he[href]',
  },
  nbc1: {
    url: 'https://www.nbcnews.com/', host: 'nbcnews.com', article: '(/live-blog/|-rcna[0-9]+)',
    // Storyline packages exclude the marquee/ticker and navigation. The heading
    // remains authoritative even when the lead module also embeds a video.
    breaking: '[data-testid="breaking-content"] a[href], [data-icid="body-top-marquee"] a[href], a[data-icid="body-top-marquee"][href]',
    modules: 'section[data-activity-map="storyline-package"], section.pkg.storyline, section.pkg.multistoryline, section.pkg.multi-storyline',
    primary: '.storyline__headline a[href], .multistoryline__headline a[href]',
    fallback: '[data-testid="storyline-headline"] a[href], [data-testid="multistoryline-headline"] a[href], h1 a[href], h2 a[href]',
  },
  yahoo1: {
    url: 'https://www.yahoo.com/news/', host: 'yahoo.com', article: '\\.html$',
    // Only the editorial Top stories carousel, never the personalized feed.
    modules: '#top-stories',
    primary: 'article[aria-roledescription="slide"][aria-label^="Slide 1 "] a[data-ylk*="elm:hdln"][href]',
    fallback: 'a[data-ylk*="cpos:1;"][data-ylk*="elm:hdln"][href]',
  },
  guardian1: {
    url: 'https://www.theguardian.com/', host: 'theguardian.com', article: '/[0-9]{4}/[a-z]{3}/[0-9]{1,2}/',
    // The News container excludes the promotional cards above the masthead.
    // Each card uses an overlay link; match its aria-label to the visible headline.
    modules: 'main #container-news > ul > li', primary: '.card-headline .headline-text',
    fallback: '.card-headline',
  },
};

// Runs inside the rendered page. Publisher-specific module/heading selectors are
// deliberately separate; shared code only validates links and rendered geometry.
export function extractMobileHero(config) {
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  const excluded = 'nav,header,footer,aside,[role="navigation"],[aria-hidden="true"],.PageListTrending,[data-testid="breaking-content"],[data-component="sub-nav"]';
  const visible = el => {
    if (!el || el.closest(excluded)) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth &&
      style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 &&
      Math.min(r.right, innerWidth) - Math.max(r.left, 0) >= Math.min(r.width * .5, 100);
  };
  const fail = reason => ({ ok: false, error: `Mobile lead unavailable: ${reason}` });
  if (/access denied|just a moment|verify.*human|robot check/i.test(document.title)) return fail('blocked/interstitial page');
  const modules = [...document.querySelectorAll(config.modules)].filter(visible)
    .sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const module = modules[0];
  if (!module) return fail('primary editorial module missing');
  for (const [tier, selector] of [['primary', config.primary], ['fallback', config.fallback]]) {
    const candidates = [...module.querySelectorAll(selector)].filter(visible).map(el => {
      let title = clean(el.innerText);
      let anchor = el.matches('a[href]') ? el : el.closest('a[href]');
      if (config.host === 'theguardian.com') {
        title = clean(el.querySelector('.headline-text')?.innerText || el.innerText);
        anchor = [...module.querySelectorAll('a[href][aria-label]')].find(a => clean(a.getAttribute('aria-label')) === title);
      }
      if (!anchor || !title || title.length < 12 || title.length > 350) return null;
      if (/^(watch live|live tv|latest|sign up|subscribe|newsletter)$/i.test(title)) return null;
      let url;
      try { url = new URL(anchor.getAttribute('href'), location.href); } catch { return null; }
      if (!/^https?:$/.test(url.protocol) || !(url.hostname === config.host || url.hostname.endsWith('.' + config.host)) || !new RegExp(config.article, 'i').test(url.pathname)) return null;
      // Tracking does not change the editorial article identity.
      url.hash = ''; url.search = '';
      const rect = el.getBoundingClientRect();
      const image = [...anchor.querySelectorAll('img'), ...module.querySelectorAll('img')].find(img => {
        const r = img.getBoundingClientRect();
        return visible(img) && r.width >= 120 && r.height >= 60 && /^https?:/.test(img.currentSrc);
      });
      return { title, url: url.href, imgUrl: image?.currentSrc || null, top: rect.top + scrollY, left: rect.left, width: rect.width, height: rect.height };
    }).filter(Boolean).sort((a,b) => a.top - b.top || a.left - b.left);
    if (candidates.length) {
      // Preserve the existing optional breaking banner independently of CP choice.
      const banner = config.breaking ? document.querySelector(config.breaking) : null;
      let breakingUrl = null;
      try {
        const u = new URL(banner?.getAttribute('href'), location.href);
        if (banner && /^https?:$/.test(u.protocol) && (u.hostname === config.host || u.hostname.endsWith('.' + config.host))) breakingUrl = u.href;
      } catch {}
      return { ok: true, ...candidates[0],
        breakingHeadline: breakingUrl ? clean(banner?.innerText) || null : null, breakingUrl, selector_used: selector, selector_tier: tier, module_selector: config.modules, page_url: location.href };
    }
  }
  return fail('no validated headline inside the first editorial module');
}
