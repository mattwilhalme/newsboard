// Read-only live collection. Archive JSON/HTML and screenshots for visual review;
// database persistence is verified separately through the existing workflow.
import fs from 'node:fs';
import * as scrapers from '../../server.js';
const collectors = {
  ap1: scrapers.scrapeAPHero, usat1: scrapers.scrapeUSATHero,
  nbc1: scrapers.scrapeNBCHero, yahoo1: scrapers.scrapeWPHero,
  guardian1: scrapers.scrapeGuardianHero,
};
process.env.NEWSBOARD_MOBILE_SCREENSHOTS = '1';
const results = [];
for (const [source_id, collect] of Object.entries(collectors)) {
  if (process.argv[2] && process.argv[2] !== source_id) continue;
  console.log(`Collecting ${source_id} in a rendered mobile browser`);
  try {
    const result = await collect();
    results.push({ source_id, ...result });
    console.log(JSON.stringify({ source_id, ...result }));
  } catch (error) { results.push({ source_id, ok: false, error: error.message }); }
}
fs.writeFileSync(`archive/mobile-validation${process.argv[2] ? '-' + process.argv[2] : ''}.json`, JSON.stringify(results, null, 2));
if (results.some(r => !r.ok)) process.exitCode = 1;
