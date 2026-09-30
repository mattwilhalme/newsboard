import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { PUBLISHER_IDS } from "../../lib/publisherRegistry.js";
import { parsePublisher, publishers } from "../../supabase/functions/newsboard-crawl/collectors.js";

const fixtureUrl = (id) => new URL(`../../test/fixtures/publishers/${id}/centerpiece.html`, import.meta.url);

test("each publisher has a small sanitized centerpiece fixture", async () => {
  for (const id of [...PUBLISHER_IDS.filter(id => id !== 'apgoogle1'), 'ap1']) {
    const fixture = fixtureUrl(id);
    assert.ok((await stat(fixture)).size < 10_000, `${id} fixture should remain minimal`);
    const html = await readFile(fixture, "utf8");
    assert.doesNotMatch(html, /<(script|img)\b/i, `${id} fixture contains unnecessary page content`);
  }
});

test("HTTP centerpiece fixtures exercise the real Edge parsers", async () => {
  for (const id of ["abc1", "cbs1", "latimes1", "npr1", "bbc1", "fox1"]) {
    const publisher = publishers.find((entry) => entry.id === id);
    const result = parsePublisher(publisher, await readFile(fixtureUrl(id), "utf8"));
    assert.equal(result.ok, true, id);
    assert.equal(result.item.title, "Officials announce a significant example development", id);
    assert.match(result.item.url, /^https:/, id);
  }
});
