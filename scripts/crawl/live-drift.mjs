// Read-only live canary. It calls publisher pages and never receives database credentials.
import { mkdir, writeFile } from 'node:fs/promises';
import * as scrapers from '../../server.js';
import { evaluateLiveDrift, LIVE_DRIFT_CONTRACTS } from '../../lib/crawlerDrift.js';
import { collectPublisher, publishers } from '../../supabase/functions/newsboard-crawl/collectors.js';

const httpCollector = sourceId => () => collectPublisher(publishers.find(publisher => publisher.id === sourceId));
export const liveCollectors = {
  abc1: httpCollector('abc1'),
  cbs1: httpCollector('cbs1'),
  usat1: scrapers.scrapeUSATHero,
  nbc1: scrapers.scrapeNBCHero,
  cnn1: scrapers.scrapeCNNHero,
  guardian1: scrapers.scrapeGuardianHero,
  apgoogle1: httpCollector('apgoogle1'),
  latimes1: httpCollector('latimes1'),
  npr1: httpCollector('npr1'),
  bbc1: httpCollector('bbc1'),
  fox1: httpCollector('fox1'),
  yahoo1: scrapers.scrapeWPHero,
};

// USA Today returns a publisher-generated HTTP 402 to GitHub-hosted browser
// traffic. Keep its contract and explicit CLI check, but do not turn a known
// runner access restriction into permanent scheduled drift noise.
export const SCHEDULED_LIVE_DRIFT_SOURCE_IDS = Object.freeze(
  Object.keys(LIVE_DRIFT_CONTRACTS).filter(sourceId => sourceId !== 'usat1'),
);
export const SCHEDULED_LIVE_DRIFT_SKIPS = Object.freeze({
  usat1: 'publisher returns HTTP 402 to GitHub-hosted browser traffic',
});

export async function main() {
  const requested = process.argv.slice(2);
  const sourceIds = requested.length ? requested : SCHEDULED_LIVE_DRIFT_SOURCE_IDS;
  const unknown = sourceIds.filter(sourceId => !liveCollectors[sourceId]);
  if (unknown.length) throw new Error(`Unknown source ids: ${unknown.join(', ')}`);

  const startedAt = new Date().toISOString();
  const results = [];
  for (const sourceId of sourceIds) {
    const started = Date.now();
    let assessed;
    let attemptCount = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      attemptCount = attempt;
      let output = null;
      let failure = null;
      try { output = await liveCollectors[sourceId](); } catch (error) { failure = error; }
      assessed = evaluateLiveDrift(sourceId, output, failure);
      if (assessed.ok || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    results.push({ ...assessed, attempt_count: attemptCount, duration_ms: Date.now() - started });
    console.log(JSON.stringify(results.at(-1)));
  }

  const report = {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    read_only: true,
    skipped: requested.length ? {} : SCHEDULED_LIVE_DRIFT_SKIPS,
    ok: results.every(result => result.ok),
    results,
  };
  await mkdir('archive', { recursive: true });
  await writeFile('archive/live-crawler-drift.json', `${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
