// Targeted browser collection; persistence is shared with the Edge and manual crawlers.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as scrapers from '../../server.js';

export const collectors = {
  ap1: scrapers.scrapeAPHero,
  cnn1: scrapers.scrapeCNNHero,
  nbc1: scrapers.scrapeNBCHero,
  guardian1: scrapers.scrapeGuardianHero,
  usat1: scrapers.scrapeUSATHero,
  yahoo1: scrapers.scrapeWPHero,
};
const trigger = 'github_browser_gap_fill';
export function shouldCollect(health) {
  return !health?.last_success_at || health.last_attempt_success === false ||
    health.age_seconds == null || !Number.isFinite(Number(health.age_seconds)) ||
    Number(health.age_seconds) >= 420;
}

export async function main() {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const check = ({ data, error }) => { if (error) throw error; return data; };
  const dispatchId = process.env.NEWSBOARD_DISPATCH_ID || '';
  const runId = dispatchId
    ? check(await db.rpc('newsboard_browser_start', {
        p_attempt: dispatchId, p_github_run_id: Number(process.env.GITHUB_RUN_ID),
        p_runner_started_at: process.env.NEWSBOARD_RUNNER_STARTED_AT || new Date().toISOString(),
      }))
    : check(await db.rpc('newsboard_start_run', { p_trigger: trigger }));
  if (!runId) {
    console.log('SKIPPED — crawl lease busy or dispatch attempt expired/already claimed');
    return;
  }

  let fatal = null;
  let attempted = 0;
  let succeeded = 0;
  try {
    // Check after acquiring the lease so a completed manual recovery is respected.
    const health = check(await db.from('v_crawler_health')
      .select('source_id,last_success_at,age_seconds,last_attempt_success').in('source_id', Object.keys(collectors)));
    const bySource = new Map(health.map(row => [row.source_id, row]));
    for (const [source_id, collect] of Object.entries(collectors)) {
      const previous = bySource.get(source_id);
      if (!shouldCollect(previous)) {
        console.log(`${source_id}: SKIPPED — last success ${previous.age_seconds}s ago`);
        continue;
      }
      attempted++;
      const started_at = new Date().toISOString();
      let output = null;
      let error = null;
      try {
        const result = await collect();
        if (result.ok !== true || !result.item?.title?.trim() || !result.item?.url?.trim()) {
          throw new Error(result.error || 'No usable CP');
        }
        const item = result.item;
        output = {
          source_id,
          observed_at: result.updatedAt || new Date().toISOString(),
          item,
          items: [{ ...item, rank: 1, slot_key: 'hero:1',
            fingerprint: createHash('sha1').update(`${item.url}|${item.title}`).digest('hex') }],
          http_status: result.meta?.http_status ?? null,
        };
      } catch (e) { error = e.message; }
      const { error: saveError } = await db.rpc('newsboard_save_source', { p: {
        run_id: runId, source_id, started_at, completed_at: new Date().toISOString(),
        method: 'browser', success: !error, error, http_status: output?.http_status ?? null, output,
      } });
      if (saveError) throw new Error(`Persistence failed for ${source_id}: ${saveError.message}`);
      if (!error) succeeded++;
      console.log(`${source_id}: ${error ? 'FAILED — ' + error : 'SUCCESS'}`);
    }
  } catch (e) { fatal = e.message; }
  check(await db.rpc('newsboard_finish_run', { p_run: runId, p_error: fatal }));
  // A freshness-only invocation did execute successfully, but performed no collection.
  if (!fatal && attempted === 0) {
    check(await db.from('crawler_runs').update({ status: 'skipped', error_summary: 'All browser sources are fresh (<420 seconds) and latest attempts have not failed' }).eq('id', runId));
  }
  if (dispatchId) check(await db.rpc('newsboard_browser_complete', { p_attempt: dispatchId }));
  console.log(JSON.stringify({ run_id: runId, trigger, attempted, succeeded, error: fatal }));
  if (fatal || (attempted > 0 && succeeded === 0)) process.exitCode = 1;

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
