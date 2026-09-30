import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PUBLISHERS, PUBLISHER_IDS } from "../../lib/publisherRegistry.js";
import { SOURCE_REGISTRY } from "../../server.js";
import { publishers } from "../../supabase/functions/newsboard-crawl/collectors.js";
import { MOBILE_ADAPTERS } from "../../lib/mobileHero.js";
import { BROWSER_TOP10 } from "../../lib/top10Browser.js";
import { collectors } from "./github-browser-gap-fill.mjs";

const sorted = (values) => [...values].sort();

test("publisher metadata registry is complete and internally valid", () => {
  assert.equal(PUBLISHERS.length, 12);
  assert.equal(new Set(PUBLISHER_IDS).size, 12);
  for (const publisher of PUBLISHERS) {
    assert.equal(new URL(publisher.homeUrl).protocol, "https:");
    assert.match(publisher.primaryMethod, /^(http|browser)$/);
    assert.match(publisher.top10, /^(complete|partial-capable|none)$/);
    assert.equal(publisher.browserFallback, publisher.kind !== 'discovery');
    assert.equal(publisher.browserAdapterAvailable, publisher.kind !== 'discovery');
    assert.equal(publisher.httpAdapterAvailable, publisher.id !== "cnn1");
    assert.equal(publisher.rankingAdapterAvailable, publisher.top10 !== "none");
  }
});

test("server, Edge HTTP, browser and UI publisher lists stay in parity", async () => {
  assert.deepEqual(SOURCE_REGISTRY.map(({ id }) => id), PUBLISHER_IDS);
  assert.deepEqual(sorted(publishers.map(({ id }) => id)), sorted(PUBLISHER_IDS.filter((id) => id !== "cnn1")));
  assert.deepEqual(sorted(Object.keys(MOBILE_ADAPTERS)), sorted(["ap1", "usat1", "nbc1", "guardian1", "yahoo1"]));
  // AP homepage adapters/fixtures remain for historical diagnostics, not scheduling.
  assert.deepEqual(sorted(Object.keys(BROWSER_TOP10)), sorted([...PUBLISHER_IDS.filter(id => !["abc1","cbs1","apgoogle1"].includes(id)), 'ap1']));
  assert.deepEqual(sorted(Object.keys(collectors)), sorted(PUBLISHER_IDS.filter(id => id !== 'apgoogle1')));

  const html = await readFile(new URL("../../docs/index.html", import.meta.url), "utf8");
  const match = html.match(/const EXPECTED_SOURCE_IDS = (\[[^;]+\]);/);
  assert.ok(match, "frontend expected-source registry is present");
  assert.deepEqual(JSON.parse(match[1]), PUBLISHER_IDS);
});
