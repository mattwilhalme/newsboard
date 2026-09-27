import assert from 'node:assert/strict';
import { buildGdeltQuery, buildGdeltUrl, canonicalCoverageUrl, normalizeGdeltResponse } from '../lib/gdeltCoverage.js';

const story = { title: 'Live updates: Hurricane Imogen hits North Carolina coast | CNN', url: 'https://www.cnn.com/weather/imogen?utm_source=x', source: 'CNN', observed_at: '2026-09-26T16:00:00Z' };
const query = buildGdeltQuery(story.title);
assert.match(query, /Hurricane Imogen|hurricane/);
assert.match(query, /sourcelang:english/);
assert.ok(!query.toLowerCase().includes('live updates'));
const built = buildGdeltUrl(story);
assert.equal(built.window.start.toISOString(), '2026-09-25T16:00:00.000Z');
assert.equal(built.window.end.toISOString(), '2026-09-26T22:00:00.000Z');
assert.equal(canonicalCoverageUrl('https://www.cnn.com/a/?utm_source=x#top'), 'https://cnn.com/a');
const normalized = normalizeGdeltResponse({ articles: [
  { title: 'Hurricane Imogen hits North Carolina coast', url: 'https://cnn.com/weather/imogen', domain: 'cnn.com', seendate: '20260926160000' },
  { title: 'Hurricane Imogen hits North Carolina coast', url: 'https://www.cnn.com/weather/imogen?utm_medium=social', domain: 'cnn.com', seendate: '20260926160100' },
  { title: 'Football results from North Carolina', url: 'https://example.com/sports', domain: 'example.com', seendate: '20260926150000' },
] }, story, { trackedDomains: ['cnn.com'] });
assert.equal(normalized.raw_result_count, 3);
assert.equal(normalized.results.length, 1);
assert.equal(normalized.results[0].tracked_by_newsboard, true);
assert.equal(normalized.results[0].is_newsboard_article, true);
console.log('gdelt coverage tests passed');
