import {
  getSupabaseAdmin,
  hasSupabaseAdmin,
  SUPABASE_SCREENSHOT_BUCKET,
  SUPABASE_SCREENSHOT_PUBLIC,
} from "./supabaseClient.js";
import { captureScreenshot } from "./captureScreenshot.js";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function buildObjectPath({ sourceId, runId, tsIso, ext = "jpg" }) {
  const dt = new Date(tsIso);
  if (!Number.isFinite(dt.getTime())) throw new Error("Invalid tsIso");
  const yyyy = dt.getUTCFullYear();
  const mm = pad2(dt.getUTCMonth() + 1);
  const dd = pad2(dt.getUTCDate());
  return `screenshots/${sourceId}/${yyyy}/${mm}/${dd}/${runId}.${ext}`;
}

export async function captureAndUploadScreenshot({ page, sourceId, runId, tsIso, profile }) {
  if (!hasSupabaseAdmin()) return null;
  const sb = getSupabaseAdmin();

  const buffer = await captureScreenshot(page, { ...(profile || {}), sourceId });

  const object_path = buildObjectPath({ sourceId, runId, tsIso, ext: "jpg" });

  const { error } = await sb.storage.from(SUPABASE_SCREENSHOT_BUCKET).upload(object_path, buffer, {
    contentType: "image/jpeg",
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw error;

  let shot_url = null;
  if (SUPABASE_SCREENSHOT_PUBLIC) {
    const pub = sb.storage.from(SUPABASE_SCREENSHOT_BUCKET).getPublicUrl(object_path);
    shot_url = pub?.data?.publicUrl || null;
  }

  return { object_path, shot_url };
}

export async function recordScreenshotEvent({
  ts,
  sourceId,
  runId,
  kind,
  title,
  url,
  object_path,
  shot_url,
  raw,
}) {
  if (!hasSupabaseAdmin()) return null;
  const sb = getSupabaseAdmin();

  const row = {
    ts,
    source_id: sourceId,
    run_id: runId,
    kind,
    title: title || null,
    url: url || null,
    object_path,
    shot_url: shot_url || null,
    raw: raw && typeof raw === "object" ? raw : {},
  };

  let result = await sb.from("screenshot_events").insert(row).select("id").limit(1);
  if (result?.error && /column\s+"?raw"?\s+does not exist/i.test(String(result.error?.message || ""))) {
    const fallback = { ...row };
    delete fallback.raw;
    result = await sb.from("screenshot_events").insert(fallback).select("id").limit(1);
  }
  if (result?.error) throw result.error;
  return result?.data?.[0] || null;
}

export async function pruneOldScreenshots({ hours = 12 }) {
  if (!hasSupabaseAdmin()) return { prunedRows: 0, deletedObjects: 0 };
  const sb = getSupabaseAdmin();

  const cutoffMs = Date.now() - (Number(hours) * 60 * 60 * 1000);
  const cutoffIso = new Date(cutoffMs).toISOString();

  let prunedRows = 0;
  let deletedObjects = 0;

  for (;;) {
    const { data: oldRows, error: qErr } = await sb
      .from("screenshot_events")
      .select("id,object_path")
      .lt("ts", cutoffIso)
      .order("ts", { ascending: true })
      .limit(500);

    if (qErr) {
      console.warn("screenshot prune query failed:", qErr.message || qErr);
      break;
    }
    if (!Array.isArray(oldRows) || !oldRows.length) break;

    const ids = oldRows.map((r) => r.id).filter(Boolean);
    const objectPaths = oldRows.map((r) => r.object_path).filter(Boolean);

    let storageDeleteOk = true;
    for (let i = 0; i < objectPaths.length; i += 1000) {
      const batch = objectPaths.slice(i, i + 1000);
      const { error: rmErr } = await sb.storage.from(SUPABASE_SCREENSHOT_BUCKET).remove(batch);
      if (rmErr) {
        storageDeleteOk = false;
        console.warn("screenshot prune storage remove failed:", rmErr.message || rmErr);
        break;
      }
      deletedObjects += batch.length;
    }

    if (!storageDeleteOk) break;

    const { error: delErr } = await sb.from("screenshot_events").delete().in("id", ids);
    if (delErr) {
      console.warn("screenshot prune row delete failed:", delErr.message || delErr);
      break;
    }
    prunedRows += ids.length;
  }

  return { prunedRows, deletedObjects };
}
