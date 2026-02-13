import { createClient } from "@supabase/supabase-js";

const DEFAULT_BUCKET = process.env.SUPABASE_SCREENSHOT_BUCKET || "screenshots";
const SIGNED_URL_TTL_SECONDS = 12 * 60 * 60;

let _adminClient = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function resolveBucket(bucket) {
  return String(bucket || DEFAULT_BUCKET);
}

function getAdminClient() {
  if (_adminClient) return _adminClient;

  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  _adminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _adminClient;
}

function inferTimestampMsFromPath(objectPath) {
  const m = String(objectPath || "").match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return Date.UTC(y, mo, d, 0, 0, 0, 0);
}

async function listBucketObjectsRecursive(storage, bucketName) {
  const allFiles = [];
  const queue = [""];

  while (queue.length) {
    const prefix = queue.shift();
    let offset = 0;

    for (;;) {
      const { data, error } = await storage.from(bucketName).list(prefix, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

      if (error) throw error;
      if (!Array.isArray(data) || data.length === 0) break;

      for (const item of data) {
        const name = String(item?.name || "");
        if (!name) continue;
        const objectPath = prefix ? `${prefix}/${name}` : name;
        if (item?.id) allFiles.push({ ...item, objectPath });
        else queue.push(objectPath);
      }

      if (data.length < 100) break;
      offset += data.length;
    }
  }

  return allFiles;
}

async function deleteInBatches(storage, bucketName, paths) {
  let deletedCount = 0;
  const chunkSize = 100;

  for (let i = 0; i < paths.length; i += chunkSize) {
    const batch = paths.slice(i, i + chunkSize);
    const { error } = await storage.from(bucketName).remove(batch);
    if (error) throw error;
    deletedCount += batch.length;
  }

  return deletedCount;
}

export async function uploadScreenshot({ sourceId, runId, tsIso, buffer, contentType }) {
  const client = getAdminClient();
  const bucketName = resolveBucket();

  const dt = new Date(tsIso);
  if (!Number.isFinite(dt.getTime())) throw new Error("Invalid tsIso");

  const yyyy = dt.getUTCFullYear();
  const mm = pad2(dt.getUTCMonth() + 1);
  const dd = pad2(dt.getUTCDate());
  const useWebp = String(contentType || "").toLowerCase().includes("webp");
  const ext = useWebp ? "webp" : "jpg";

  const objectPath = `screenshots/${sourceId}/${yyyy}/${mm}/${dd}/${runId}.${ext}`;

  const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);

  const { error: uploadError } = await client.storage.from(bucketName).upload(objectPath, payload, {
    contentType: useWebp ? "image/webp" : "image/jpeg",
    upsert: true,
  });
  if (uploadError) throw uploadError;

  let url = null;
  const signed = await client.storage.from(bucketName).createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);
  if (!signed?.error && signed?.data?.signedUrl) {
    url = signed.data.signedUrl;
  } else {
    const pub = client.storage.from(bucketName).getPublicUrl(objectPath);
    url = pub?.data?.publicUrl || null;
  }

  return { objectPath, url };
}

export async function pruneOldScreenshots({ cutoffIso, bucket }) {
  const client = getAdminClient();
  const bucketName = resolveBucket(bucket);
  const cutoffMs = Date.parse(String(cutoffIso || ""));
  if (!Number.isFinite(cutoffMs)) throw new Error("Invalid cutoffIso");

  const files = await listBucketObjectsRecursive(client.storage, bucketName);
  const toDelete = [];

  for (const file of files) {
    const fromMeta = Date.parse(String(file?.created_at || file?.updated_at || ""));
    const createdMs = Number.isFinite(fromMeta) ? fromMeta : inferTimestampMsFromPath(file?.objectPath);
    if (Number.isFinite(createdMs) && createdMs < cutoffMs) {
      toDelete.push(file.objectPath);
    }
  }

  const deletedCount = await deleteInBatches(client.storage, bucketName, toDelete);
  return { deletedCount };
}
