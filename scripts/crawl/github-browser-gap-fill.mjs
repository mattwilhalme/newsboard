// Targeted browser collection; persistence is shared with the Edge and manual crawlers.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as scrapers from '../../server.js';

export const collectors = {
  cnn1: scrapers.scrapeCNNHero,
  nbc1: scrapers.scrapeNBCHero,
  guardian1: scrapers.scrapeGuardianHero,
  usat1: scrapers.scrapeUSATHero,
  yahoo1: scrapers.scrapeWPHero,
  abc1: scrapers.scrapeABCHero, cbs1: scrapers.scrapeCBSHero,
  latimes1: scrapers.scrapeLATimesHero, npr1: scrapers.scrapeNPRHero,
  bbc1: scrapers.scrapeBBCHero, fox1: scrapers.scrapeFoxHero,
};
const trigger = 'github_browser_gap_fill';

export function classifyCrawlResult(result, error = null) {
  const candidateStatus = result?.meta?.http_status == null ? NaN : Number(result.meta.http_status);
  const httpStatus = Number.isInteger(candidateStatus) ? candidateStatus : null;
  const message = error?.message || result?.error || 'No usable CP';
  if ([403, 429].includes(httpStatus) || result?.meta?.access_blocked === true) return { status: 'blocked', http_status: httpStatus, error: message };
  if (error && /browserType\.launch|executable doesn't exist|failed to launch|playwright/i.test(message)) {
    return { status: 'infrastructure_error', http_status: httpStatus, error: message };
  }
  return { status: 'crawl_failed', http_status: httpStatus, error: message };
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
  let blocked = 0;
  let crawlFailed = 0;
  let infrastructureErrors = 0;
  const publishers = {};
  try {
    // The database atomically assigns only due/requested publishers to this run.
    const work = check(await db.rpc('newsboard_browser_sources', {p_run: runId}));
    for (const {source_id} of work) {
      const collect = collectors[source_id];
      if (!collect) throw new Error(`No configured browser collector for ${source_id}`);
      attempted++;
      const started_at = new Date().toISOString();
      let output = null;
      let error = null;
      let outcome = 'success';
      let httpStatus = null;
      try {
        const result = await collect();
        const candidateStatus = result?.meta?.http_status == null ? NaN : Number(result.meta.http_status);
        httpStatus = Number.isInteger(candidateStatus) ? candidateStatus : null;
        if (result.ok !== true || !result.item?.title?.trim() || !result.item?.url?.trim()) {
          const failure = classifyCrawlResult(result);
          outcome = failure.status; error = failure.error; httpStatus = failure.http_status;
        } else {
          const item = result.item;
          output = {
            source_id,
            observed_at: result.updatedAt || new Date().toISOString(),
            item,
            top10: result.top10, top10_quality: result.top10_quality, top10_diagnostics: result.top10_diagnostics,
            items: [{ ...item, rank: 1, slot_key: 'hero:1',
              fingerprint: createHash('sha1').update(`${item.url}|${item.title}`).digest('hex') }],
            http_status: httpStatus,
          };
        }
      } catch (e) {
        const failure = classifyCrawlResult(null, e);
        outcome = failure.status; error = failure.error; httpStatus = failure.http_status;
      }
      const { error: saveError } = await db.rpc('newsboard_save_source', { p: {
        run_id: runId, source_id, started_at, completed_at: new Date().toISOString(),
        method: 'browser', success: outcome === 'success', outcome, error, http_status: httpStatus, output,
      } });
      if (saveError) throw new Error(`Persistence failed for ${source_id}: ${saveError.message}`);
      if (outcome === 'success') succeeded++;
      else if (outcome === 'blocked') blocked++;
      else if (outcome === 'crawl_failed') crawlFailed++;
      else infrastructureErrors++;
      publishers[source_id] = { status: outcome, http_status: httpStatus };
      if (error) publishers[source_id].error = error;
      console.log(`${source_id}: ${outcome.toUpperCase()}${error ? ' — ' + error : ''}`);
    }
  } catch (e) { fatal = e.message; }
  check(await db.rpc('newsboard_finish_run', { p_run: runId, p_error: fatal }));
  // A freshness-only invocation did execute successfully, but performed no collection.
  if (!fatal && attempted === 0) {
    check(await db.from('crawler_runs').update({ status: 'skipped', error_summary: 'No due browser jobs' }).eq('id', runId));
  }
  if (dispatchId) check(await db.rpc('newsboard_browser_complete', { p_attempt: dispatchId }));
  console.log(JSON.stringify({ run_id: runId, dispatch_id: dispatchId || null,
    github_run_id: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : null,
    trigger, attempted, succeeded, blocked,
    crawl_failed: crawlFailed, infrastructure_errors: infrastructureErrors, publishers, error: fatal }, null, 2));
  if (fatal || infrastructureErrors > 0) process.exitCode = 1;

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
