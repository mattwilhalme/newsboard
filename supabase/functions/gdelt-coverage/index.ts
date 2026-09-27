import { fetchGdeltCoverage } from '../../../lib/gdeltCoverage.js';

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'GET, OPTIONS', 'content-type': 'application/json' };
const cache = new Map<string, { expires: number, data: unknown }>();
const json = (data: unknown, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...cors, ...extra } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'GET required' }, 405);
  const params = new URL(req.url).searchParams;
  const story = { title: params.get('headline') || '', url: params.get('url') || '', source: params.get('source') || '', observed_at: params.get('observed_at') || '' };
  if (!story.title || !story.observed_at) return json({ error: 'headline and observed_at are required' }, 400);
  const trackedDomains = (params.get('tracked_domains') || '').split(',').map(v => v.trim()).filter(Boolean).slice(0, 50);
  const key = `${story.title}|${story.url}|${story.observed_at}|${trackedDomains.join(',')}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return json(hit.data, 200, { 'x-newsboard-cache': 'HIT' });
  try {
    const data = await fetchGdeltCoverage(story, { trackedDomains });
    cache.set(key, { expires: Date.now() + 15 * 60 * 1000, data });
    return json(data, 200, { 'cache-control': 'public, max-age=900', 'x-newsboard-cache': 'MISS' });
  } catch (error) {
    const status = Number(error?.status) || (/timed out/.test(String(error?.message)) ? 504 : 502);
    return json({ error: String(error?.message || error) }, status);
  }
});
