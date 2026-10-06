import { getSupabaseAdmin, hasSupabaseAdmin } from "./supabaseClient.js";

function isLoopbackAddress(address) {
  const value = String(address || "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function requireLocalStoryReview(req, res, next) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return res.status(403).json({ ok: false, error: "Story Review is available only from this computer." });
  }
  const origin = String(req.get("origin") || "");
  if (origin) {
    try {
      const hostname = new URL(origin).hostname;
      if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
        return res.status(403).json({ ok: false, error: "Cross-origin Story Review requests are not allowed." });
      }
    } catch {
      return res.status(403).json({ ok: false, error: "Invalid request origin." });
    }
  }
  if (!hasSupabaseAdmin()) {
    return res.status(503).json({ ok: false, error: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before launching Story Review." });
  }
  next();
}

function storyReviewError(res, error) {
  const message = String(error?.message || error || "Story Review request failed");
  const status = /required|invalid|does not exist|non-empty/i.test(message) ? 400 : 500;
  return res.status(status).json({ ok: false, error: message });
}

export function registerStoryReviewRoutes(app, { nowISO = () => new Date().toISOString() } = {}) {
  app.get("/api/story-review/board", requireLocalStoryReview, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, Math.floor(Number(req.query?.hours) || 24)));
      const limit = Math.max(20, Math.min(500, Math.floor(Number(req.query?.limit) || 250)));
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const db = getSupabaseAdmin();
      const { data: stories, error: storiesError } = await db.from("stories")
        .select("id,canonical_label,manual_label,first_detected_at,first_source_id,last_seen_at,active")
        .gte("last_seen_at", cutoff).order("last_seen_at", { ascending: false }).limit(200);
      if (storiesError) throw storiesError;
      const storyRows = Array.isArray(stories) ? stories : [];
      const storyIds = storyRows.map((story) => story.id);
      let members = [], assignmentRows = [], pendingSuggestions = [], corrections = [];
      if (storyIds.length) {
        const [memberResult, assignmentResult, suggestionResult, correctionResult] = await Promise.all([
          db.from("story_members").select("story_id,source_id,latest_headline,url,last_seen_at,active,current_rank").in("story_id", storyIds).order("last_seen_at", { ascending: false }),
          db.from("story_assignments").select("story_id,batch_key,source_id,observed_at,headline,url,rank,metadata").in("story_id", storyIds).gte("observed_at", cutoff).order("observed_at", { ascending: false }).limit(limit),
          db.rpc("newsboard_story_pending_suggestions", { p_limit: 30 }),
          db.rpc("newsboard_story_corrections", { p_limit: 500 }),
        ]);
        if (memberResult.error) throw memberResult.error;
        if (assignmentResult.error) throw assignmentResult.error;
        if (suggestionResult.error) throw suggestionResult.error;
        if (correctionResult.error) throw correctionResult.error;
        members = Array.isArray(memberResult.data) ? memberResult.data : [];
        assignmentRows = Array.isArray(assignmentResult.data) ? assignmentResult.data : [];
        pendingSuggestions = Array.isArray(suggestionResult.data) ? suggestionResult.data : [];
        corrections = Array.isArray(correctionResult.data) ? correctionResult.data : [];
      }
      const membersByStory = new Map();
      for (const member of members) {
        const rows = membersByStory.get(member.story_id) || [];
        rows.push(member);
        membersByStory.set(member.story_id, rows);
      }
      const latestAssignmentByStorySource = new Map();
      for (const item of assignmentRows) {
        const key = `${item.story_id}|${item.source_id}`;
        if (!latestAssignmentByStorySource.has(key)) latestAssignmentByStorySource.set(key, item);
      }
      const allGroups = storyRows.map((story) => ({
        story_id: story.id,
        label: story.manual_label || story.canonical_label,
        canonical_label: story.canonical_label,
        manually_labeled: Boolean(story.manual_label),
        first_detected_at: story.first_detected_at,
        first_source_id: story.first_source_id,
        last_seen_at: story.last_seen_at,
        active: story.active,
        members: (membersByStory.get(story.id) || []).map((member) => {
          const assignment = latestAssignmentByStorySource.get(`${story.id}|${member.source_id}`);
          return { ...member, assignment: assignment ? {
            batch_key: assignment.batch_key, rank: assignment.rank, story_id: assignment.story_id,
            source_id: assignment.source_id, observed_at: assignment.observed_at,
            headline: assignment.headline, url: assignment.url, match_evidence: assignment.metadata || {},
          } : null };
        }),
      }));
      const seen = new Set();
      const allGroupsById = new Map(allGroups.map((group) => [group.story_id, group]));
      const assignments = assignmentRows
        .filter((item) => (membersByStory.get(item.story_id) || []).length === 1)
        .filter((item) => { const key = `${item.source_id}|${item.url}`; if (seen.has(key)) return false; seen.add(key); return true; })
        .map(({ metadata, ...item }) => ({ ...item, group_label: allGroupsById.get(item.story_id)?.label || null, match_evidence: metadata || {} }));
      const draftStoryIds = new Set(corrections
        .filter((correction) => correction.active && correction.action === "create" && !/^(Removed from grouped identity|Dissolved group:)/.test(String(correction.notes || "")))
        .map((correction) => correction.target_story_id));
      res.set("Cache-Control", "no-store").json({
        ok: true, generated_at: nowISO(), hours, assignments,
        groups: allGroups.filter((group) => group.members.length >= 2),
        drafts: allGroups.filter((group) => group.members.length === 1 && draftStoryIds.has(group.story_id)),
        suggestions: pendingSuggestions, health: {},
      });
    } catch (error) { storyReviewError(res, error); }
  });

  app.get("/api/story-review/groups/:storyId", requireLocalStoryReview, async (req, res) => {
    try {
      const { data, error } = await getSupabaseAdmin().rpc("newsboard_story_history", { p_story: req.params.storyId });
      if (error) throw error;
      if (!data?.story) return res.status(404).json({ ok: false, error: "Story group not found." });
      res.set("Cache-Control", "no-store").json({ ok: true, history: data });
    } catch (error) { storyReviewError(res, error); }
  });

  app.post("/api/story-review/corrections", requireLocalStoryReview, async (req, res) => {
    try {
      const batchKey = String(req.body?.batch_key || "").trim();
      const rank = Number(req.body?.rank);
      const targetStory = String(req.body?.target_story_id || "").trim() || null;
      const newLabel = String(req.body?.new_label || "").trim() || null;
      if (!batchKey || !Number.isInteger(rank)) return res.status(400).json({ ok: false, error: "batch_key and an integer rank are required." });
      if (!targetStory && !newLabel) return res.status(400).json({ ok: false, error: "Choose a target group or provide a new group label." });
      const { data, error } = await getSupabaseAdmin().rpc("newsboard_story_correct_article", {
        p_batch_key: batchKey, p_rank: rank, p_target_story: targetStory, p_new_label: targetStory ? null : newLabel,
        p_notes: String(req.body?.notes || "").trim() || null,
        p_reviewer: String(req.body?.reviewer || "").trim() || "local-review-console",
      });
      if (error) throw error;
      res.json({ ok: true, correction: data });
    } catch (error) { storyReviewError(res, error); }
  });

  app.post("/api/story-review/groups/merge", requireLocalStoryReview, async (req, res) => {
    try {
      const sourceStory = String(req.body?.source_story_id || "").trim();
      const targetStory = String(req.body?.target_story_id || "").trim();
      if (!sourceStory || !targetStory || sourceStory === targetStory) return res.status(400).json({ ok: false, error: "Choose two different story groups to merge." });
      const reviewer = String(req.body?.reviewer || "").trim() || "local-review-console";
      const evidence = req.body?.evidence && typeof req.body.evidence === "object" ? req.body.evidence : null;
      const call = evidence
        ? ["newsboard_story_merge_reviewed", { p_source_story: sourceStory, p_target_story: targetStory, p_evidence: evidence, p_reviewer: reviewer }]
        : ["newsboard_story_merge", { p_source_story: sourceStory, p_target_story: targetStory, p_notes: String(req.body?.notes || "").trim() || null, p_reviewer: reviewer }];
      const { data, error } = await getSupabaseAdmin().rpc(call[0], call[1]);
      if (error) throw error;
      res.json({ ok: true, merge: data });
    } catch (error) { storyReviewError(res, error); }
  });

  app.post("/api/story-review/groups/:storyId/dissolve", requireLocalStoryReview, async (req, res) => {
    try {
      const { data, error } = await getSupabaseAdmin().rpc("newsboard_story_dissolve", {
        p_story: req.params.storyId, p_notes: String(req.body?.notes || "").trim() || "Removed grouping in local review console",
        p_reviewer: String(req.body?.reviewer || "").trim() || "local-review-console",
      });
      if (error) throw error;
      res.json({ ok: true, dissolution: data });
    } catch (error) { storyReviewError(res, error); }
  });

  app.post("/api/story-review/suggestions/skip", requireLocalStoryReview, async (req, res) => {
    try {
      const storyA = String(req.body?.story_a || "").trim();
      const storyB = String(req.body?.story_b || "").trim();
      if (!storyA || !storyB || storyA === storyB) return res.status(400).json({ ok: false, error: "Choose two different suggested groups." });
      const evidence = req.body?.evidence && typeof req.body.evidence === "object" ? req.body.evidence : {
        matcher_version: String(req.body?.matcher_version || "").trim() || "unknown",
        score: Number.isFinite(Number(req.body?.score)) ? Number(req.body.score) : null,
      };
      const { data, error } = await getSupabaseAdmin().rpc("newsboard_story_skip_suggestion_reviewed", {
        p_story_a: storyA, p_story_b: storyB, p_evidence: evidence,
        p_reviewer: String(req.body?.reviewer || "").trim() || "local-review-console",
      });
      if (error) throw error;
      res.json({ ok: true, skip: data });
    } catch (error) { storyReviewError(res, error); }
  });

  app.patch("/api/story-review/groups/:storyId", requireLocalStoryReview, async (req, res) => {
    try {
      const label = String(req.body?.label || "").trim();
      if (!label) return res.status(400).json({ ok: false, error: "A non-empty label is required." });
      const { data, error } = await getSupabaseAdmin().rpc("newsboard_story_set_label", {
        p_story: req.params.storyId, p_label: label, p_notes: String(req.body?.notes || "").trim() || null,
        p_reviewer: String(req.body?.reviewer || "").trim() || "local-review-console",
      });
      if (error) throw error;
      res.json({ ok: true, update: data });
    } catch (error) { storyReviewError(res, error); }
  });
}
