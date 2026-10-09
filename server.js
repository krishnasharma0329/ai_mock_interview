import "dotenv/config";
import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mock from "./mock.js";
import { buildBasicReport } from "./basic-report.js";
import { extractText, getDocumentProxy } from "unpdf";
import { startAgenda, onAnswer, directive, afterTurn, coveredKeys, normalizePlan, fallbackQuestion } from "./agenda.js";
import { groq, groqCheck, groqResearch, groqTurn, groqReport, groqErrorMessage } from "./groq.js";
import {
  researchSystemPrompt,
  researchUserPrompt,
  interviewerSystemPrompt,
  reportSystemPrompt,
  PLAN_TOOL,
  TURN_TOOL,
  REPORT_SCHEMA,
  SUBJECTS,
  MANDATORY_KEYS,
  REQUIRED_KEYS,
} from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const MOCK = process.env.MOCK_AI === "1";
const USE_FALLBACKS = process.env.USE_FALLBACKS !== "0";
const EFFORT = {
  research: process.env.EFFORT_RESEARCH || "medium",
  turn: process.env.EFFORT_TURN || "medium",
  report: process.env.EFFORT_REPORT || "medium",
};

// Which AI service powers the interviewer: "groq" (free tier) or "claude".
const PROVIDER = (process.env.AI_PROVIDER || (process.env.GROQ_API_KEY?.trim() ? "groq" : "claude")).toLowerCase();
const HAS_KEY = PROVIDER === "groq" ? !!groq : !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
const client = MOCK || PROVIDER !== "claude" || !HAS_KEY ? null : new Anthropic();
let useFallbacks = USE_FALLBACKS;

// AI status: "mock" | "missing" | "checking" | "ok" | "invalid" | "model" | "unreachable"
let aiStatus = MOCK ? "mock" : HAS_KEY ? "checking" : "missing";
const KEY_VAR = PROVIDER === "groq" ? "GROQ_API_KEY" : "ANTHROPIC_API_KEY";
const AI_MESSAGES = {
  missing: `No ${PROVIDER === "groq" ? "Groq" : "Anthropic"} API key found. Open the .env file in the project folder, paste your key after ${KEY_VAR}=, save, and restart with: npm start`,
  invalid: `Your ${PROVIDER === "groq" ? "Groq" : "Anthropic"} API key was rejected. Check ${KEY_VAR} in .env, then restart with: npm start`,
  model: `Your API key cannot use the model "${process.env.CLAUDE_MODEL || "claude-opus-5"}". Change CLAUDE_MODEL in .env or check your Anthropic account.`,
  unreachable: `The server could not reach the ${PROVIDER === "groq" ? "Groq" : "Anthropic"} API. Check your internet connection.`,
};
async function checkKey() {
  if (MOCK || !HAS_KEY) return;
  if (PROVIDER === "groq") {
    aiStatus = await groqCheck();
    console.log(aiStatus === "ok" ? "✓ Groq API key verified (free tier)" : `✗ ${AI_MESSAGES[aiStatus]}`);
    return;
  }
  try {
    await client.models.retrieve(MODEL);
    aiStatus = "ok";
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) aiStatus = "invalid";
    else if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError) aiStatus = "model";
    else if (err instanceof Anthropic.APIConnectionError) aiStatus = "unreachable";
    else aiStatus = "ok"; // other errors (e.g. rate limits) don't mean the key is unusable
  }
  console.log(aiStatus === "ok" ? `✓ Anthropic API key verified (model: ${MODEL})` : `✗ ${AI_MESSAGES[aiStatus]}`);
}

/** Blocks AI routes with a clear message when the real AI isn't usable. */
function requireAI(_req, res, next) {
  if (MOCK || aiStatus === "ok" || aiStatus === "checking") return next();
  if (aiStatus === "unreachable") return checkKey().then(() => (aiStatus === "ok" ? next() : res.status(503).json({ error: AI_MESSAGES[aiStatus] })));
  res.status(503).json({ error: AI_MESSAGES[aiStatus] });
}

/**
 * Stream a Claude request. `attach` registers event handlers on the stream.
 * If the account rejects the server-side fallback beta, retry once without it.
 */
async function streamMessage(params, attach) {
  const run = (p) => {
    const st = client.beta.messages.stream(p);
    attach?.(st);
    return st.finalMessage();
  };
  try {
    return await run(withFallbacks(params));
  } catch (err) {
    if (useFallbacks && err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message)) {
      console.warn("Server-side fallbacks not available for this account; continuing without them.");
      useFallbacks = false;
      return run(params);
    }
    throw err;
  }
}
const app = express();
// Vercel limits request bodies to ~4.5 MB, so resumes are capped at 4 MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- stateless sessions ----------
// Serverless hosts (Vercel) don't keep memory between requests, so the whole interview state travels with
// the browser as a signed, compressed token. The HMAC signature stops anyone from editing it.
const SESSION_SECRET = process.env.SESSION_SECRET
  ? Buffer.from(process.env.SESSION_SECRET)
  : process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY
    ? createHash("sha256").update(`mock-interviewer:${process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY}`).digest()
    : randomBytes(32);
const SESSION_TTL_MS = 12 * 3600 * 1000;
const sign = (body) => createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");

function packSession(s) {
  const { rollback, report, ...rest } = s;
  const plain = { ...rest, covered: [...(s.covered || [])], visited: [...(s.visited || [])] };
  const body = gzipSync(JSON.stringify(plain)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function unpackSession(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig || "");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(gunzipSync(Buffer.from(body, "base64url")).toString("utf8"));
    if (!s.createdAt || Date.now() - s.createdAt > SESSION_TTL_MS) return null;
    s.covered = new Set(s.covered || []);
    s.visited = new Set(s.visited || []);
    return s;
  } catch {
    return null;
  }
}

/** Finish a streamed response successfully, handing the updated interview state back to the browser. */
function endOk(res, send, s) {
  send({ type: "state", state: packSession(s) });
  res.end();
}
const MANDATORY_TECH = MANDATORY_KEYS;
const MANDATORY_LABELS = {
  ...SUBJECTS,
  dsa_array: "DSA – Array problem",
  dsa_string: "DSA – String problem",
  sql_1: "SQL query #1",
  sql_2: "SQL query #2",
};

// ---------- helpers ----------

/** Server-side refusal fallbacks (Anthropic picks the fallback model by refusal category). */
function withFallbacks(params) {
  if (!useFallbacks) return params;
  return { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

/**
 * Prepare an assistant turn for echoing back. After a mid-output fallback, blocks before the
 * last `fallback` marker that are model-internal (thinking, tool_use, unpaired server_tool_use)
 * must be dropped; the marker itself is dropped too.
 */
function cleanForEcho(content) {
  const lastFallback = content.map((b) => b.type).lastIndexOf("fallback");
  if (lastFallback === -1) return content;
  const resultIds = new Set(
    content.filter((b) => b.type?.endsWith("_tool_result")).map((b) => b.tool_use_id),
  );
  return content.filter((b, i) => {
    if (b.type === "fallback") return false;
    if (i > lastFallback) return true;
    if (["thinking", "redacted_thinking", "tool_use"].includes(b.type)) return false;
    if (b.type === "server_tool_use" && !resultIds.has(b.id)) return false;
    return ["text", "server_tool_use", "web_search_tool_result", "web_fetch_tool_result"].includes(b.type);
  });
}

function ndjson(res) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return (obj) => res.write(JSON.stringify(obj) + "\n");
}

function apiErrorMessage(err) {
  const g = groqErrorMessage(err);
  if (g) return g;
  if (err instanceof Anthropic.AuthenticationError)
    return "Claude API authentication failed. Set ANTHROPIC_API_KEY in .env and restart the server.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API — wait a few seconds and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Claude API error (${err.status}): ${err.message}`;
  return err?.message || String(err);
}

function getSession(req, res) {
  const s = unpackSession(req.body?.state);
  if (!s) res.status(400).json({ error: "This interview session has expired or is invalid. Please start a new interview." });
  return s;
}

const ACCESS_CODE = process.env.ACCESS_CODE?.trim() || "";

// Testing aid only: INTERVIEW_CLOCK_SCALE=10 makes the interview clock run 10x faster.
const CLOCK_SCALE = Number(process.env.INTERVIEW_CLOCK_SCALE) || 1;
function minutesElapsed(s) {
  return s.startedAt ? ((Date.now() - s.startedAt) / 60000) * CLOCK_SCALE : 0;
}

function pendingMandatory(s) {
  if (s.config.type !== "technical") return [];
  return MANDATORY_TECH.filter((k) => !s.covered.has(k));
}
function pendingRequired(s) {
  if (s.config.type !== "technical") return [];
  return REQUIRED_KEYS.filter((k) => !s.covered.has(k));
}

const INTERVIEWERS = [
  { name: "Priya Sharma", title: "Senior Software Engineer" },
  { name: "Ananya Iyer", title: "Engineering Manager" },
  { name: "Neha Kapoor", title: "Lead Software Engineer" },
  { name: "Sneha Reddy", title: "Senior Software Engineer" },
];

const TOPIC_OF = {
  introduction: "resume", resume: "resume", language: "language", oops: "oops", dbms: "dbms", os: "os", cn: "cn",
  software_dev: "software_dev", dsa_array: "dsa", dsa_string: "dsa", sql: "sql", behavioral: "behavioral", hr: "behavioral",
  company_fit: "company_fit",
};

/** What was actually asked AND answered — the report may only score these. */
function coveredInInterview(s) {
  const topics = new Set();
  const problems = { dsa_array: 0, dsa_string: 0, sql: 0 };
  const seenTitles = new Set();
  for (const t of s.turns) {
    const task = t.meta?.coding_task || t.meta?.sql_task;
    if (task && !seenTitles.has(task.title)) {
      seenTitles.add(task.title);
      problems[t.meta.sql_task ? "sql" : t.meta.category === "dsa_string" ? "dsa_string" : "dsa_array"]++;
    }
    if (t.answer == null) continue;
    const topic = TOPIC_OF[t.meta?.category];
    if (topic) topics.add(topic);
  }
  return { topics: [...topics], problems };
}

/** Per-turn context the interviewer sees alongside the candidate's answer. */
function clockNote(s, extra = {}) {
  const elapsed = minutesElapsed(s);
  const remaining = Math.max(0, s.config.duration - elapsed);
  const lines = [`[Interview clock: ${elapsed.toFixed(1)} of ${s.config.duration} min elapsed, ${remaining.toFixed(1)} min remaining.]`];
  if (extra.latencySec != null) lines.push(`[Candidate began answering after ${extra.latencySec}s; answered via ${extra.via || "text"}.]`);
  return lines.join("\n");
}

// ---------- 1. create session (CV upload + details) ----------

app.post("/api/session", upload.single("cv"), requireAI, async (req, res) => {
  try {
    const { name, role, company, type, difficulty } = req.body;
    if (ACCESS_CODE && String(req.body.accessCode || "").trim() !== ACCESS_CODE)
      return res.status(403).json({ error: "Wrong access code. Ask the person who shared this app for the code." });
    const duration = Number(req.body.duration);
    const allowed = type === "hr" ? [15, 20, 25] : [20, 25, 30];
    if (!name?.trim() || !role?.trim() || !company?.trim())
      return res.status(400).json({ error: "Name, position and company are required." });
    if (!["technical", "hr"].includes(type)) return res.status(400).json({ error: "Invalid interview type." });
    if (!["easy", "medium", "hard"].includes(difficulty)) return res.status(400).json({ error: "Invalid difficulty." });
    if (!allowed.includes(duration)) return res.status(400).json({ error: `Duration must be one of ${allowed.join(", ")} min.` });
    if (!req.file) return res.status(400).json({ error: "Please upload your CV (PDF, DOCX or TXT)." });

    // Turn the CV into a content block Claude can read.
    let cvBlock;
    const fname = req.file.originalname.toLowerCase();
    if (req.file.mimetype === "application/pdf" || fname.endsWith(".pdf")) {
      cvBlock = {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: req.file.buffer.toString("base64") },
        title: "Candidate CV",
      };
    } else if (fname.endsWith(".docx")) {
      const { value } = await mammoth.extractRawText({ buffer: req.file.buffer });
      cvBlock = { type: "text", text: `<candidate_cv>\n${value}\n</candidate_cv>` };
    } else if (fname.endsWith(".txt") || fname.endsWith(".md")) {
      cvBlock = { type: "text", text: `<candidate_cv>\n${req.file.buffer.toString("utf8")}\n</candidate_cv>` };
    } else {
      return res.status(400).json({ error: "Unsupported CV format. Use PDF, DOCX or TXT." });
    }

    // Plain text of the CV (needed by Groq, which can't read PDFs directly).
    let cvText = "";
    try {
      if (cvBlock.type === "text") cvText = cvBlock.text.replace(/<\/?candidate_cv>/g, "").trim();
      else {
        const pdf = await getDocumentProxy(new Uint8Array(req.file.buffer));
        cvText = (await extractText(pdf, { mergePages: true })).text.trim();
      }
    } catch (e) {
      console.warn("CV text extraction failed:", e.message);
    }
    if (PROVIDER === "groq" && !MOCK && cvText.length < 40)
      return res.status(400).json({ error: "We couldn't read any text from this resume (it may be a scanned image). Please upload a text-based PDF or a DOCX file." });

    // Keep the session token small: use the extracted text instead of the raw PDF whenever possible.
    if (cvText.length >= 200) cvBlock = { type: "text", text: `<candidate_cv>\n${cvText}\n</candidate_cv>` };

    const id = randomUUID();
    const session = {
      id,
      config: { name: name.trim(), role: role.trim(), company: company.trim(), type, difficulty, duration },
      cvBlock,
      cvText,
      plan: null,
      sources: [],
      messages: [],
      pendingToolUseId: null,
      turns: [], // {question, meta, answer, code, metrics}
      covered: new Set(),
      startedAt: null,
      createdAt: Date.now(),
      interviewer: INTERVIEWERS[Math.floor(Math.random() * INTERVIEWERS.length)],
    };
    res.json({ sessionId: id, state: packSession(session) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 2. live web research → interview plan ----------

app.post("/api/session/:id/research", requireAI, async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const send = ndjson(res);
  try {
    if (MOCK) {
      await mock.research(s, send);
      return endOk(res, send, s);
    }
    if (PROVIDER === "groq") {
      const plan = await groqResearch(s, send);
      if (!plan || typeof plan !== "object") throw new Error("Could not build an interview plan. Please try again.");
      const filled = normalizePlan(plan, s.config);
      if (filled.length) console.log("Plan gaps filled from problem bank:", filled.join(", "));
      s.plan = plan;
      send({ type: "plan", plan, sources: s.sources, interviewer: s.interviewer });
      return endOk(res, send, s);
    }
    send({ type: "status", text: `Reading your CV and researching ${s.config.company}…` });

    const messages = [
      { role: "user", content: [s.cvBlock, { type: "text", text: researchUserPrompt(s.config) }] },
    ];
    const tools = [
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      PLAN_TOOL,
    ];
    let plan = null;
    const seenUrls = new Set();

    for (let step = 0; step < 6 && !plan; step++) {
      const attach = (stream) => stream.on("contentBlock", (block) => {
        if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) {
          send({ type: "search", query: block.input.query });
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) {
            if (r.type === "web_search_result" && !seenUrls.has(r.url)) {
              seenUrls.add(r.url);
              s.sources.push({ title: r.title, url: r.url });
              send({ type: "source", title: r.title, url: r.url });
            }
          }
        } else if (block.type === "tool_use" && block.name === "submit_interview_plan") {
          send({ type: "status", text: "Building your personalised interview plan…" });
        }
      });
      const msg = await streamMessage(
        {
          model: MODEL,
          max_tokens: 32000,
          thinking: { type: "adaptive" },
          output_config: { effort: EFFORT.research },
          system: researchSystemPrompt,
          tools,
          messages,
        },
        attach,
      );

      if (msg.stop_reason === "refusal") throw new Error("The model declined to build this interview plan. Try rephrasing the role or company.");
      const toolUse = msg.content.find((b) => b.type === "tool_use" && b.name === "submit_interview_plan");
      if (toolUse) {
        plan = toolUse.input;
        break;
      }
      messages.push({ role: "assistant", content: cleanForEcho(msg.content) });
      if (msg.stop_reason !== "pause_turn") {
        messages.push({ role: "user", content: "Research is sufficient. Call submit_interview_plan now with the complete plan." });
      }
    }
    if (!plan || typeof plan !== "object") throw new Error("Could not build an interview plan. Please try again.");
    normalizePlan(plan, s.config);
    s.plan = plan;
    send({ type: "plan", plan, sources: s.sources, interviewer: s.interviewer });
    return endOk(res, send, s);
  } catch (err) {
    console.error("research error:", err);
    send({ type: "error", error: apiErrorMessage(err) });
  }
  res.end();
});

// ---------- 3. interview turns (streamed) ----------

async function runInterviewerTurn(s, text, send, d) {
  let { spoken, meta } = PROVIDER === "groq" ? await groqTurn(s, text, send) : await claudeTurn(s, text, send);
  // Small models sometimes repeat a sentence; drop exact repeats.
  {
    const parts = spoken.match(/[^.!?]+[.!?]*\s*/g) || [spoken];
    const seen = new Set();
    const cleaned = parts.filter((p) => { const k = p.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; }).join("").trim();
    if (cleaned && cleaned !== spoken.trim()) {
      spoken = cleaned;
      send({ type: "replace", text: cleaned });
    }
  }
  // Guard: every turn (except the closing one) must actually ask the candidate something.
  if (!spoken.includes("?")) {
    const q = fallbackQuestion(s, d);
    if (q) {
      send({ type: "delta", text: ` ${q}` });
      spoken = `${spoken} ${q}`;
      const last = s.gmessages?.[s.gmessages.length - 1];
      if (PROVIDER === "groq" && last?.role === "assistant") last.content += ` ${q}`;
    }
  }
  // The agenda, not the model, decides what is on screen and what this turn was.
  if (meta.preferred_language && meta.preferred_language !== "other") s.prefLang ||= meta.preferred_language;
  meta.preferred_language = s.prefLang || null;
  meta.category = d.cat;
  meta.response_mode = d.mode;
  meta.coding_task = d.attach?.coding_task || null;
  meta.sql_task = d.attach?.sql_task || null;
  meta.interview_complete = d.close;
  afterTurn(s);
  s.covered = coveredKeys(s);
  meta.covered_mandatory = [...s.covered];

  // Score of the previous answer belongs to the previous turn.
  const prev = s.turns[s.turns.length - 1];
  if (prev && prev.answer != null) {
    prev.score = meta.last_answer_score ?? null;
    prev.feedback = meta.last_answer_note || "";
  }
  s.turns.push({ question: spoken.trim(), meta, answer: null });
  s.started = true;

  send({
    type: "meta",
    meta,
    covered: [...s.covered],
    pending: pendingRequired(s),
    elapsedMin: minutesElapsed(s),
  });
}

async function claudeTurn(s, text, send) {
  const userContent = [];
  if (s.pendingToolUseId) userContent.push({ type: "tool_result", tool_use_id: s.pendingToolUseId, content: "recorded" });
  userContent.push({ type: "text", text });
  s.messages.push({ role: "user", content: userContent });

  let spoken = "";
  const msg = await streamMessage(
    {
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT.turn },
      system: [
        { type: "text", text: interviewerSystemPrompt(s.config, s.plan, s.interviewer), cache_control: { type: "ephemeral" } },
      ],
      tools: [TURN_TOOL],
      messages: s.messages,
    },
    (stream) =>
      stream.on("text", (delta) => {
        spoken += delta;
        send({ type: "delta", text: delta });
      }),
  );

  if (msg.stop_reason === "refusal") {
    s.messages.pop();
    throw new Error("The interviewer model declined to respond to that answer. Try rephrasing.");
  }
  const content = cleanForEcho(msg.content);
  s.messages.push({ role: "assistant", content });

  const toolUse = content.find((b) => b.type === "tool_use" && b.name === "record_turn");
  s.pendingToolUseId = toolUse?.id || null;
  const meta = toolUse?.input || { response_mode: "voice", category: "general", interview_complete: false };

  if (!spoken.trim()) {
    // The model put everything in the tool call; make sure the candidate hears something.
    spoken = meta.coding_task?.title ? `Let's move to a problem: ${meta.coding_task.title}.` : "Please go ahead.";
    send({ type: "delta", text: spoken });
  }
  return { spoken, meta };
}

app.post("/api/session/:id/start", requireAI, async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  if (!s.plan) return res.status(400).json({ error: "Research has not finished yet." });
  const send = ndjson(res);
  try {
    if (!s.startedAt) s.startedAt = Date.now();
    if (MOCK) {
      await mock.turn(s, null, send);
      return endOk(res, send, s);
    }
    if (s.started) throw new Error("Interview already started.");
    startAgenda(s);
    const d = directive(s);
    await runInterviewerTurn(s, `${clockNote(s)}\n[The candidate ${s.config.name} has just joined the video call.]\n\n${d.text}`, send, d);
    return endOk(res, send, s);
  } catch (err) {
    console.error("start error:", err);
    send({ type: "error", error: apiErrorMessage(err) });
  }
  res.end();
});

app.post("/api/session/:id/turn", requireAI, async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const { answer = "", code = "", language = "", metrics = {} } = req.body || {};
  if (!answer.trim() && !code.trim()) return res.status(400).json({ error: "Answer is empty." });
  const send = ndjson(res);
  try {
    const current = s.turns[s.turns.length - 1];
    if (current) Object.assign(current, { answer, code, language, metrics });

    if (MOCK) {
      await mock.turn(s, { answer, code }, send);
      return endOk(res, send, s);
    }

    onAnswer(s, { answer, code }, minutesElapsed(s), s.config.duration);
    const d = directive(s);
    let text = `${clockNote(s, { latencySec: metrics.latencySec, via: metrics.via })}\n\nCandidate's answer:\n${answer.trim() || "(no spoken answer)"}`;
    if (code.trim()) text += `\n\nCandidate's ${language || "code"} submission:\n\`\`\`${language}\n${code.slice(0, 4000)}\n\`\`\``;
    text += `\n\n${d.text}`;
    await runInterviewerTurn(s, text, send, d);
    return endOk(res, send, s);
  } catch (err) {
    // The browser keeps its previous state token, so a failed turn is automatically undone.
    console.error("turn error:", err.status || "", err.message?.slice(0, 200));
    send({ type: "error", error: apiErrorMessage(err) });
  }
  res.end();
});

// ---------- 4. final report ----------

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));
/** Make the report safe to render and internally consistent, whatever the model returned. */
function normalizeReport(r, c) {
  r = r && typeof r === "object" ? r : {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const str = (x) => (typeof x === "string" ? x : "");
  r.overall_score = clamp(r.overall_score);
  r.selection_probability = clamp(r.selection_probability);
  // The verdict must agree with the score.
  const sc = r.overall_score;
  r.verdict = sc >= 82 ? "Strong Hire" : sc >= 68 ? "Hire" : sc >= 55 ? "Lean Hire" : sc >= 40 ? "Lean No Hire" : "No Hire";
  if (r.selection_probability > sc + 20) r.selection_probability = clamp(sc + 20);
  r.headline = str(r.headline) || `${r.verdict} — overall score ${sc}/100`;
  r.summary = str(r.summary);
  r.skill_scores = arr(r.skill_scores).filter((x) => x && x.skill).map((x) => ({ skill: str(x.skill), score: clamp(x.score), comment: str(x.comment) }));
  r.topic_scores = arr(r.topic_scores).filter((x) => x && x.topic).map((x) => ({ topic: x.topic, score: clamp(x.score), comment: str(x.comment) }));
  r.strengths = arr(r.strengths).map(str).filter(Boolean);
  r.improvements = arr(r.improvements).map(str).filter(Boolean);
  r.question_breakdown = arr(r.question_breakdown).filter((q) => q && q.question).map((q) => ({
    question: str(q.question), candidate_answer_summary: str(q.candidate_answer_summary), score: clamp(q.score, 0, 10),
    what_went_well: str(q.what_went_well), what_to_improve: str(q.what_to_improve), ideal_answer: str(q.ideal_answer),
  }));
  r.coding_review = arr(r.coding_review).filter((x) => x && x.problem && ["dsa_array", "dsa_string", "sql"].includes(x.kind)).map((x) => ({
    problem: str(x.problem), kind: x.kind, correctness: ["correct", "partially_correct", "incorrect", "not_attempted"].includes(x.correctness) ? x.correctness : "not_attempted",
    complexity: str(x.complexity), feedback: str(x.feedback), better_approach: str(x.better_approach),
  }));
  const ca = r.communication_analysis && typeof r.communication_analysis === "object" ? r.communication_analysis : {};
  r.communication_analysis = { fluency: str(ca.fluency), filler_words: str(ca.filler_words), pace: str(ca.pace), structure: str(ca.structure) };
  r.company_fit = str(r.company_fit);
  r.action_plan = arr(r.action_plan).filter((a) => a && a.title).map((a) => ({ title: str(a.title), detail: str(a.detail) }));
  return r;
}

app.post("/api/session/:id/report", async (req, res) => {
  const s = getSession(req, res);
  if (!s) return;
  const { metrics: clientMetrics = {}, pendingAnswer = "", pendingCode = "", language = "" } = req.body || {};
  let covered;
  try {
    // An answer the candidate was still composing when time ran out still counts.
    const last = s.turns[s.turns.length - 1];
    if (last && last.answer == null && (pendingAnswer.trim() || pendingCode.trim())) {
      Object.assign(last, { answer: pendingAnswer.trim() || "(code only)", code: pendingCode, language });
    }
    const transcript = s.turns
      .map((t, i) => {
        let out = `### Exchange ${i + 1} [${t.meta?.category || "general"}${t.meta?.is_cross_question ? ", cross-question" : ""}]\nInterviewer: ${t.question}`;
        if (t.meta?.coding_task) out += `\n(Problem shown: ${t.meta.coding_task.title} — ${t.meta.coding_task.statement})`;
        if (t.meta?.sql_task) out += `\n(SQL task shown: ${t.meta.sql_task.question})`;
        out += `\nCandidate: ${t.answer ?? "(no answer — interview ended)"}`;
        if (t.code) out += `\nCandidate ${t.language || ""} code:\n\`\`\`\n${t.code}\n\`\`\``;
        if (t.metrics?.latencySec != null) out += `\n(answer latency ${t.metrics.latencySec}s, ${t.metrics.words ?? "?"} words, ${t.metrics.fillers ?? 0} filler words, via ${t.metrics.via || "text"})`;
        if (t.score != null) out += `\n(live interviewer score: ${t.score}/10 — ${t.feedback})`;
        return out;
      })
      .join("\n\n");

    covered = coveredInInterview(s);
    if (!MOCK && !["ok", "checking"].includes(aiStatus)) throw new Error(AI_MESSAGES[aiStatus] || "The AI service is not available.");
    const finalize = (raw) => {
      const report = normalizeReport(raw, s.config);
      // Hard guarantee: never show scores for topics or problems that were not part of this interview.
      report.topic_scores = (report.topic_scores || []).filter((t) => covered.topics.includes(t.topic));
      const left = { ...covered.problems };
      report.coding_review = (report.coding_review || []).filter((c) => left[c.kind]-- > 0);
      s.report = report;
      return res.json({ report, sources: s.sources, config: s.config, covered, interviewer: s.interviewer });
    };

    if (MOCK) return finalize(mock.report(s, clientMetrics));

    const answered = s.turns.filter((t) => t.answer != null).length;
    const userText = `Candidate: ${s.config.name}
Target: ${s.config.role} at ${s.config.company}
Interview: ${s.config.type.toUpperCase()}, difficulty ${s.config.difficulty}, planned ${s.config.duration} min, actual ${minutesElapsed(s).toFixed(1)} min.
Questions answered: ${answered}.
Covered topics (score ONLY these in topic_scores): ${covered.topics.join(", ") || "none"}.
Problems actually shown: ${covered.problems.dsa_array} array DSA, ${covered.problems.dsa_string} string DSA, ${covered.problems.sql} SQL (coding_review must contain only these).
${s.config.type === "technical" && pendingRequired(s).length ? `Required problems NOT reached: ${pendingRequired(s).join(", ")} — mention this as a time-management/pace issue, but do not score them.` : ""}

Measured delivery metrics (from the browser):
${JSON.stringify(clientMetrics, null, 2)}

Interview plan summary:
${JSON.stringify({ company_insights: s.plan?.company_insights, interview_process: s.plan?.interview_process }, null, 2)}

Full transcript:
${transcript || "(the candidate did not answer any question)"}`;

    if (PROVIDER === "groq") return finalize(await groqReport(s, userText));

    const msg = await streamMessage({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT.report, format: { type: "json_schema", schema: REPORT_SCHEMA } },
      system: reportSystemPrompt,
      messages: [{ role: "user", content: [s.cvBlock, { type: "text", text: userText }] }],
    });
    if (msg.stop_reason === "refusal") throw new Error("The model declined to generate the report.");
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return finalize(JSON.parse(text));
  } catch (err) {
    // Never lose a finished interview: fall back to a report built from the live interview data.
    console.error("report error:", err.status || "", String(err.message || err).slice(0, 200));
    try {
      covered ||= coveredInInterview(s);
      const report = normalizeReport(buildBasicReport(s, clientMetrics), s.config);
      report.topic_scores = report.topic_scores.filter((t) => covered.topics.includes(t.topic));
      res.json({ report, basic: true, reason: apiErrorMessage(err), sources: s.sources, config: s.config, covered, interviewer: s.interviewer });
    } catch (e2) {
      console.error("basic report error:", e2);
      res.status(500).json({ error: apiErrorMessage(err) });
    }
  }
});

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, mock: MOCK, provider: PROVIDER, model: PROVIDER === "groq" ? "groq (free tier)" : MODEL, ai: aiStatus, message: AI_MESSAGES[aiStatus] || null, accessCode: !!ACCESS_CODE }),
);

// Locally run a normal server; on Vercel the exported app becomes a serverless function.
checkKey();
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Mock Interviewer running at http://localhost:${PORT}`);
    if (MOCK) console.log("⚠ DEMO MODE (MOCK_AI=1): questions are a fixed script and there is no real research. Use `npm start` for the real AI interviewer.");
    else if (!HAS_KEY) console.log(`✗ ${AI_MESSAGES.missing}`);
    else console.log(`Checking your ${PROVIDER === "groq" ? "Groq" : "Anthropic"} API key…`);
  });
}

export default app;
