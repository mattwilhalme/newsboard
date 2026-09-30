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
console.log(`Validated ${files.length} workflow action contracts.`);
