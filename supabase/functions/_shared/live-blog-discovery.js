const DISCOVERY_URL = 'https://oujussbkfvmgudfnakbx.supabase.co/functions/v1/discover-live-blogs';
const SUPPORTED_SOURCES = new Set(['abc1', 'cbs1', 'cnn1', 'nbc1']);
const LIVE_PATHS = {
  abc1: /^\/(?:[a-z0-9_-]+\/)*live-updates\/[a-z0-9_-]+\/?$/i,
  cbs1: /^\/(?:[a-z0-9_-]+\/)*live-updates\/[a-z0-9_-]+\/?$/i,
  cnn1: /^\/(?:[a-z0-9_-]+\/)*live-news\/[a-z0-9_-]+\/?$/i,
  nbc1: /^\/(?:[a-z0-9_-]+\/)*live-blog\/[a-z0-9_-]+-rcna\d+\/?$/i,
};
const HOSTS = {
  abc1: new Set(['abcnews.com', 'www.abcnews.com', 'abcnews.go.com', 'www.abcnews.go.com']),
  cbs1: new Set(['cbsnews.com', 'www.cbsnews.com']),
  cnn1: new Set(['cnn.com', 'www.cnn.com']),
  nbc1: new Set(['nbcnews.com', 'www.nbcnews.com']),
};

export function isLiveBlogUrl(sourceId, rawUrl) {
  if (!SUPPORTED_SOURCES.has(sourceId)) return false;
  try {
    const url = new URL(String(rawUrl || ''));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && HOSTS[sourceId].has(url.hostname.toLowerCase()) && LIVE_PATHS[sourceId].test(url.pathname);
  } catch { return false; }
}

export function buildLiveBlogDiscoveryPayload({ channel, sourceId, observedAt, runId, items }) {
  if (!['top10', 'feed'].includes(channel) || !SUPPORTED_SOURCES.has(sourceId)) return null;
  const candidates = (Array.isArray(items) ? items : []).flatMap((item, index) => {
    const url = item?.url || item?.canonical_url;
    const title = item?.title || item?.headline;
    if (!isLiveBlogUrl(sourceId, url) || !String(title || '').trim()) return [];
    return [{
      source_id: sourceId,
      title: String(title).trim(),
      url,
      ...(channel === 'top10' ? { rank: Number(item.rank) || index + 1 } : {}),
      fingerprint: item.fingerprint || null,
      description: item.description || null,
      published_at: item.published_at || null,
    }];
  });
  if (!candidates.length) return null;
  return { schema_version: 1, channel, observed_at: observedAt || new Date().toISOString(), run_id: runId || null, items: candidates.slice(0, 50) };
}

export async function notifyLiveBlogDiscovery(input, { secret = '', fetchImpl = fetch } = {}) {
  const payload = buildLiveBlogDiscoveryPayload(input);
  if (!payload) return { status: 'skipped', reason: 'no_live_blog_candidates' };
  if (!secret) return { status: 'skipped', reason: 'missing_discovery_secret' };
  const response = await fetchImpl(DISCOVERY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-newsboard-secret': secret },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Live Reader discovery HTTP ${response.status}`);
  return { status: 'delivered', response: await response.json() };
}
