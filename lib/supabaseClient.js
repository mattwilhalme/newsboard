import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const SUPABASE_SCREENSHOT_BUCKET = process.env.SUPABASE_SCREENSHOT_BUCKET || "screenshots";
export const SUPABASE_SCREENSHOT_PUBLIC = String(process.env.SUPABASE_SCREENSHOT_PUBLIC || "false").toLowerCase() === "true";

let _client = null;

export function hasSupabaseAdmin() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabaseAdmin() {
  if (!hasSupabaseAdmin()) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  if (_client) return _client;

  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
