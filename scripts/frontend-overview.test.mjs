import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../docs/js/views/overview-cards.js", import.meta.url), "utf8");
const context = { window: {} };
vm.runInNewContext(source, context, { filename: "overview-cards.js" });

function createOverview(expectedSourceIds = ["abc1", "cbs1", "apgoogle1"]) {
  return context.window.NewsboardOverview.createOverviewCards({
    expectedSourceIds,
    isDiscoverySource: (id) => id === "apgoogle1",
    sourceHomeUrl: () => "",
    sourceLabel: (id) => id,
    ago: () => "now",
    fmtDurationSeconds: String,
    storyBadge: () => null,
    openGdeltCoverage: () => {},
  });
}

test("overview source selection preserves configured placeholders and retires the AP homepage card", () => {
  const overview = createOverview();
  assert.deepEqual(
    [...overview.pickCardSourceIds({ abc1: {}, ap1: {}, custom1: {} })],
    ["abc1", "cbs1", "apgoogle1", "custom1"],
  );
});

test("overview ordering prioritizes URL changes, then headline changes, then recency", () => {
  const overview = createOverview(["abc1", "cbs1", "nbc1", "cnn1"]);
  const sources = {
    abc1: { updatedAt: "2026-10-02T10:00:00Z" },
    cbs1: { updatedAt: "2026-10-02T12:00:00Z" },
    nbc1: { updatedAt: "2026-10-02T11:00:00Z" },
    cnn1: { updatedAt: "2026-10-02T13:00:00Z" },
  };
  const indicators = {
    abc1: { changeType: "url", currentSinceAt: Date.parse("2026-10-02T09:00:00Z") },
    cbs1: { changeType: "headline", headlineSinceAt: Date.parse("2026-10-02T12:00:00Z") },
    nbc1: { changeType: "url", currentSinceAt: Date.parse("2026-10-02T11:00:00Z") },
    cnn1: { changeType: null },
  };
  assert.deepEqual([...overview.sortedOverviewIds(sources, indicators)], ["nbc1", "abc1", "cbs1", "cnn1"]);
});
