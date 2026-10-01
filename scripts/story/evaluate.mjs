import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const limit = Math.min(5000, Math.max(1, Number(process.argv[2]) || 1000));
const { data, error } = await db.rpc('newsboard_story_match_evaluation', { p_limit: limit });
if (error) throw error;
const rows = Array.isArray(data) ? data : [];
const decisions = ['merge', 'skip'].map((decision) => {
  const subset = rows.filter((row) => row.decision === decision);
  const scores = subset.map((row) => Number(row.score)).filter(Number.isFinite);
  return { decision, count: subset.length, average_score: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)) : null };
});
const versionGroups = new Map();
for (const row of rows) {
  const version = row.matcher_version || 'unknown';
  versionGroups.set(version, [...(versionGroups.get(version) || []), row]);
}
const byVersion = [...versionGroups].map(([version, items]) => ({ version, count: items.length, merges: items.filter((row) => row.decision === 'merge').length, skips: items.filter((row) => row.decision === 'skip').length }));
console.log(JSON.stringify({ reviewed_pairs: rows.length, decisions, by_version: byVersion }, null, 2));
