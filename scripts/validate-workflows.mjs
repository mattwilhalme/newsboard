import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const directory = new URL("../.github/workflows/", import.meta.url);
const files = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name));
assert.ok(files.length > 0, "no GitHub Actions workflows found");

for (const file of files) {
  const source = await readFile(new URL(file, directory), "utf8");
  for (const key of ["name:", "on:", "permissions:", "jobs:"]) assert.ok(source.includes(key), `${file} is missing ${key}`);
  assert.match(source, /permissions:\s*\n\s+contents:\s*read\b/, `${file} must use read-only repository contents permission`);
  assert.doesNotMatch(source, /contents:\s*write\b|git\s+push\b/, `${file} must not write to the repository`);
  for (const line of source.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line))) {
    assert.match(line, /@[A-Za-z0-9._-]+\s*$/, `${file} has an unpinned action reference: ${line.trim()}`);
  }
}

const gapFill = await readFile(new URL("browser-gap-fill.yml", directory), "utf8");
assert.match(gapFill, /scripts\/crawl\/github-browser-gap-fill\.mjs/);
const apValidation = gapFill.split('- name: Validate AP without database writes')[1]?.split('- name: Save browser diagnostics')[0];
assert.ok(apValidation, 'read-only AP validation step is required');
assert.doesNotMatch(apValidation, /SUPABASE_|SERVICE_ROLE/, 'AP validation must not receive database credentials');
const scrape = await readFile(new URL("scrape.yml", directory), "utf8");
assert.match(scrape, /scripts\/crawl\/github-backup\.mjs/);
assert.doesNotMatch(gapFill + scrape, /BROWSERBASE|browserbase/, 'removed Browserbase integration must not receive credentials or run');
const ci = await readFile(new URL("ci.yml", directory), "utf8");
assert.match(ci, /\bpush:\s*\n/, 'CI must run for pushes');
assert.match(ci, /\bpull_request:\s*\n/, 'CI must run for pull requests');
assert.match(ci, /node-version:\s*24\b/, 'CI must use the production Node.js major version');
assert.match(ci, /npm ci\b/, 'CI must install the committed dependency lockfile');
assert.match(ci, /npm run verify\b/, 'CI must run the complete deterministic regression contract');
assert.doesNotMatch(ci, /SUPABASE_|SERVICE_ROLE|scripts\/crawl\/validate-|scripts\/test-/, 'CI must not receive database credentials or invoke live publisher checks');
const drift = await readFile(new URL("live-crawler-drift.yml", directory), "utf8");
assert.match(drift, /schedule:\s*\n\s+- cron:/, 'live drift detection must remain scheduled');
assert.match(drift, /npm run test:crawler-drift\b/, 'live drift workflow must run the read-only canary');
assert.match(drift, /if:\s*always\(\)/, 'live drift diagnostics must upload after failures');
assert.doesNotMatch(drift, /SUPABASE_|SERVICE_ROLE|NEWSBOARD_TOKEN|git\s+push\b/, 'live drift detection must not receive persistence credentials or push');
console.log(`Validated ${files.length} workflow action contracts.`);
