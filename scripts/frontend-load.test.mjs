import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../docs/js/app.js", import.meta.url), "utf8");

test("secondary startup requests run concurrently after the initial overview paint", () => {
  const initialRender = source.indexOf("renderOverview(sources, preliminary.indicators, {});");
  const paintYield = source.indexOf("requestAnimationFrame", initialRender);
  const parallelHydration = source.indexOf("await Promise.all([", paintYield);
  const collectionHealth = source.indexOf("const operationalHealthPromise", paintYield);
  const timeline = source.indexOf("const timelinePromise", paintYield);
  const storyBadges = source.indexOf("const storyBadgesPromise", paintYield);
  const recentStories = source.indexOf("const recentStoriesPromise", paintYield);
  const deepDive = source.indexOf("const deepDivePromise", paintYield);

  assert.ok(initialRender >= 0, "initial overview should render as soon as the live snapshot is ready");
  assert.ok(paintYield > initialRender, "the browser should get a paint opportunity before hydration");
  for (const request of [collectionHealth, timeline, storyBadges, recentStories, deepDive]) {
    assert.ok(request > paintYield && request < parallelHydration, "secondary requests should start before the shared await");
  }
});

test("Top 10 startup data is scoped to the selected timeline window", () => {
  assert.match(source, /async function loadDeepDiveData\(hours = deepDiveState\.windowHours\)/);
  assert.match(source, /NewsboardData\.getTop10\(Number\(hours \|\| DEEP_DIVE_DEFAULT_HOURS\)\)/);
  assert.match(source, /await loadDeepDiveData\(deepDiveState\.windowHours\)/);
});
