// Optional Supabase storage: candidate details, one interview snapshot, and the final report.
// Enabled only when SUPABASE_URL and SUPABASE_SECRET_KEY are set. Every function fails soft:
// a storage problem is logged but never breaks the interview.
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL?.trim();
const KEY = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
const TABLE = "interviews";
const BUCKET = "snapshots";

export const db = URL && KEY ? createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
export const storageEnabled = !!db;

let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 2 * 1024 * 1024, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
  bucketReady = true;
}

/** Create the interview record when the candidate joins (after giving consent). Returns its id. */
export async function recordStart(s) {
  if (!db) return null;
  const c = s.config;
  const { data, error } = await db
    .from(TABLE)
    .insert({
      name: c.name, role: c.role, company: c.company, interview_type: c.type, difficulty: c.difficulty, duration_min: c.duration,
      resume_text: (s.cvText || "").slice(0, 20000), interviewer: s.interviewer?.name || null, status: "in_progress",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** Store the interview snapshot (JPEG data URL from the browser). */
export async function recordSnapshot(recordId, dataUrl) {
  if (!db || !recordId) return;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || "");
  if (!m) throw new Error("Invalid image");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 2 * 1024 * 1024) throw new Error("Image too large");
  await ensureBucket();
  const path = `${recordId}.jpg`;
  const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: m[1], upsert: true });
  if (error) throw error;
  const { error: e2 } = await db.from(TABLE).update({ snapshot_path: path }).eq("id", recordId);
  if (e2) throw e2;
}

/** Save the final report and transcript. */
export async function recordResult(s, report, { basic = false, metrics = {} } = {}) {
  if (!db || !s.recordId) return;
  const transcript = s.turns.map((t) => ({
    question: t.question, category: t.meta?.category || null, answer: t.answer ?? null, code: t.code || null,
    problem: t.meta?.coding_task?.title || t.meta?.sql_task?.title || null, live_score: t.score ?? null,
  }));
  const { error } = await db
    .from(TABLE)
    .update({
      status: "completed", completed_at: new Date().toISOString(), overall_score: report.overall_score,
      selection_probability: report.selection_probability, verdict: report.verdict, report, transcript, metrics, basic_report: basic,
    })
    .eq("id", s.recordId);
  if (error) throw error;
}

/** Admin: list interviews (newest first), with short-lived links to the snapshots. */
export async function listInterviews({ limit = 100 } = {}) {
  const { data, error } = await db
    .from(TABLE)
    .select("id, created_at, completed_at, status, name, role, company, interview_type, difficulty, duration_min, interviewer, overall_score, selection_probability, verdict, snapshot_path, basic_report")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const paths = data.map((r) => r.snapshot_path).filter(Boolean);
  if (paths.length) {
    const { data: signed } = await db.storage.from(BUCKET).createSignedUrls(paths, 3600);
    const byPath = Object.fromEntries((signed || []).map((x) => [x.path, x.signedUrl]));
    for (const r of data) r.snapshot_url = byPath[r.snapshot_path] || null;
  }
  return data;
}

/** Admin: one interview with full report, transcript and resume text. */
export async function getInterview(id) {
  const { data, error } = await db.from(TABLE).select("*").eq("id", id).single();
  if (error) throw error;
  if (data.snapshot_path) {
    const { data: s } = await db.storage.from(BUCKET).createSignedUrl(data.snapshot_path, 3600);
    data.snapshot_url = s?.signedUrl || null;
  }
  return data;
}

/** Admin: delete an interview and its snapshot. */
export async function deleteInterview(id) {
  const { data } = await db.from(TABLE).select("snapshot_path").eq("id", id).single();
  if (data?.snapshot_path) await db.storage.from(BUCKET).remove([data.snapshot_path]);
  const { error } = await db.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}

export const SETUP_SQL = `create table if not exists public.interviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'in_progress',
  name text, role text, company text,
  interview_type text, difficulty text, duration_min int,
  resume_text text, interviewer text,
  snapshot_path text,
  overall_score int, selection_probability int, verdict text,
  report jsonb, transcript jsonb, metrics jsonb,
  basic_report boolean default false
);
-- Only the server (secret key) may read or write; no public access.
alter table public.interviews enable row level security;`;
