import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../docs/js/views/history-data.js", import.meta.url), "utf8");
const context = { URL, window: {} };
vm.runInNewContext(source, context, { filename: "history-data.js" });

const now = Date.parse("2026-10-02T12:00:00Z");
const hoursFor = (value) => [6, 24, 168].includes(Number(value)) ? Number(value) : 24;
const historyData = context.window.NewsboardHistoryData.createHistoryData({
  parseHoursSpec: hoursFor,
  windowStartMs: (value) => now - hoursFor(value) * 60 * 60 * 1000,
  now: () => now,
});

test("history metrics distinguish URL changes from headline rewrites", () => {
  const entries = [
    { title: "Original headline", url: "https://example.com/story?utm_source=test", firstSeenAt: "2026-10-01T13:00:00Z", lastSeenAt: "2026-10-01T14:00:00Z" },
    { title: "Rewritten headline", url: "https://example.com/story", firstSeenAt: "2026-10-01T15:00:00Z", lastSeenAt: "2026-10-01T16:00:00Z" },
    { title: "Breaking: live event", url: "https://example.com/live/event", contentType: "live", breakingLabel: "Breaking News", firstSeenAt: "2026-10-01T17:00:00Z", lastSeenAt: "2026-10-01T18:00:00Z" },
  ];
  const metrics = historyData.computeSourceDataMetrics(entries, 24);
  assert.equal(metrics.urlChanges, 1);
  assert.equal(metrics.headlineOnlyChanges, 1);
  assert.equal(metrics.uniqueStories, 2);
  assert.equal(metrics.longestRunMs, 3 * 60 * 60 * 1000);
  assert.equal(metrics.liveBlogs, 1);
  assert.equal(metrics.breakingNews, 1);
  assert.equal(metrics.buckets.reduce((sum, bucket) => sum + bucket.url, 0), 1);
  assert.equal(metrics.buckets.reduce((sum, bucket) => sum + bucket.headline, 0), 1);
});

test("seven-day metrics expose per-day display values and canonicalize tracking URLs", () => {
  const entries = [
    { title: "One", url: "https://example.com/story?utm_campaign=a#top", firstSeenAt: "2026-09-29T12:00:00Z", lastSeenAt: "2026-09-29T13:00:00Z" },
    { title: "Two", url: "https://example.com/story", firstSeenAt: "2026-09-30T12:00:00Z", lastSeenAt: "2026-09-30T13:00:00Z" },
  ];
  const metrics = historyData.computeSourceDataMetrics(entries, 168);
  assert.equal(metrics.uniqueStories, 1);
  assert.equal(metrics.urlChanges, 0);
  assert.equal(metrics.headlineOnlyChanges, 1);
  assert.equal(metrics.perDay, true);
  assert.equal(historyData.fmtMetricValue(metrics.headlineOnlyChangesDisplay, true), "0.1/day");
});
