// Groq provider (free tier friendly).
//
// Free-plan limits are small (per model: ~8K tokens/minute, 200K tokens/day), so every request here is kept
// compact, and each call rotates to another free model when one is rate-limited.
//  - Research: openai/gpt-oss models with the built-in `browser_search` tool (live web search).
//  - Plan, interview turns, report: strict JSON structured outputs.
import Groq from "groq-sdk";
import { researchSystemPrompt, researchUserPrompt, interviewerSystemPrompt, reportSystemPrompt, PLAN_TOOL, TURN_TOOL, REPORT_SCHEMA } from "./prompts.js";

// Each free model has its own per-minute budget. Research runs on gpt-oss-20b + qwen so that
// gpt-oss-120b (the interviewer) is fresh when the candidate joins.
const SEARCH_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]; // browser_search capable
const JSON_MODELS = (process.env.GROQ_MODELS || "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b").split(",").map((m) => m.trim()).filter(Boolean);
const PLAN_MODELS = ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"];

export const groq = process.env.GROQ_API_KEY?.trim() ? new Groq({ apiKey: process.env.GROQ_API_KEY.trim(), maxRetries: 0, timeout: 90_000 }) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + " …[truncated]" : t || "");

/** Reasoning settings differ per model family. */
function reasoningParams(model) {
  if (model.startsWith("openai/gpt-oss")) return { reasoning_effort: "low", include_reasoning: false };
  if (model.startsWith("qwen/")) return { reasoning_effort: "none", reasoning_format: "hidden" };
  return {};
}

const isRetryable = (e) => e instanceof Groq.APIError && [413, 429, 498, 500, 502, 503].includes(e.status);

/** Seconds Groq asks us to wait (retry-after header, or "try again in 8.07s" in the message). */
function retryAfter(e) {
  const h = Number(e.headers?.get?.("retry-after") ?? e.headers?.["retry-after"]);
  if (h > 0) return h;
  const m = String(e.message || "").match(/try again in ([\d.]+)s/i);
  return m ? Number(m[1]) : 0;
}

/** Try each model in turn; when every model is rate-limited, wait for the soonest one to free up (up to 3 rounds). */
async function chat(models, params) {
  let lastErr;
  for (let round = 0; round < 4; round++) {
    let wait = Infinity;
    for (const model of models) {
      try {
        return await groq.chat.completions.create({ ...params, ...reasoningParams(model), model });
      } catch (e) {
        if (e instanceof Groq.BadRequestError) {
          // A model may reject a request option (strict schema, reasoning flags). Retry it in a plainer form,
          // then fall through to the next model.
          const plain = { ...params, model };
          if (plain.response_format?.json_schema) plain.response_format = { ...plain.response_format, json_schema: { ...plain.response_format.json_schema, strict: false } };
          try {
            console.warn(`Groq ${model}: 400 (${e.message.slice(0, 120)}) — retrying without strict/reasoning options`);
            return await groq.chat.completions.create(plain);
          } catch (e2) {
            lastErr = e2;
            if (e2 instanceof Groq.RateLimitError) wait = Math.min(wait, retryAfter(e2) || 6);
            continue;
          }
        }
        if (e instanceof Groq.APIConnectionError) {
          // Network blip (DNS/connection): wait a little and retry instead of failing.
          lastErr = e;
          wait = Math.min(wait, 3 + round * 3);
          console.warn(`Groq connection problem (${e.cause?.code || e.message}) — will retry`);
          break;
        }
        if (!isRetryable(e)) throw e;
        lastErr = e;
        wait = Math.min(wait, retryAfter(e) || 6);
        console.warn(`Groq ${model}: ${e.status === 429 ? "busy (free limit)" : e.status} — trying next model`);
      }
    }
    // Only wait for short per-minute limits; a daily limit (minutes/hours away) fails fast with a clear message.
    if (round < 3 && Number.isFinite(wait) && wait <= 20) await sleep((wait + 0.5) * 1000);
    else break;
  }
  throw lastErr;
}

function parseJson(msg) {
  const text = msg?.content || "";
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error("The AI returned an unreadable response. Please try again.");
}

const jsonFormat = (name, schema) => ({ type: "json_schema", json_schema: { name, strict: true, schema } });

export function groqErrorMessage(err) {
  if (err instanceof Groq.AuthenticationError) return "Groq rejected the API key. Check GROQ_API_KEY in .env and restart with: npm start";
  if (err instanceof Groq.RateLimitError && /per day|TPD|RPD/i.test(err.message))
    return "Today's free Groq usage limit is used up (200,000 tokens per day per model). It frees up gradually over the next hours — try again later, or upgrade the Groq plan.";
  if (err instanceof Groq.RateLimitError) return "The free Groq limit was reached for now. Wait about a minute and press Try again.";
  if (err instanceof Groq.APIConnectionError) return "Could not reach Groq. Check your internet connection.";
  if (err instanceof Groq.APIError && err.status === 413) return "That message was too long for the free Groq limit. Try a shorter answer.";
  if (err instanceof Groq.APIError) return `Groq error (${err.status}): ${err.message}`;
  return null;
}

export async function groqCheck() {
  try {
    await groq.models.list();
    return "ok";
  } catch (e) {
    if (e instanceof Groq.AuthenticationError || e instanceof Groq.PermissionDeniedError) return "invalid";
    if (e instanceof Groq.APIConnectionError) return "unreachable";
    return "ok";
  }
}

// ---------------------------------------------------------------- research

function sourcesFrom(message) {
  const out = [];
  for (const t of message?.executed_tools || []) {
    for (const r of t.browser_results || []) if (r.url) out.push({ title: r.title || r.url, url: r.url });
    const sr = t.search_results;
    const list = Array.isArray(sr) ? sr : sr?.results || [];
    for (const r of list) if (r?.url) out.push({ title: r.title || r.url, url: r.url });
  }
  return out;
}

export async function groqResearch(s, send) {
  const c = s.config;
  const tech = c.type === "technical";
  const year = new Date().getFullYear();
  const searches = tech
    ? [
        { q: `${c.company} ${c.role} technical interview questions ${year} interview experience`, ask: `what candidates report being asked in ${c.company}'s technical interview rounds for ${c.role} (resume/project questions, programming language, OOPs, DBMS, OS, networks), and the interview process/rounds` },
        { q: `${c.company} coding round array string DSA and SQL questions asked`, ask: `the actual coding (array and string problems) and SQL questions candidates report from ${c.company} interviews for ${c.role} or similar roles` },
      ]
    : [
        { q: `${c.company} HR interview questions ${c.role} ${year} interview experience`, ask: `the HR / behavioural questions candidates report being asked at ${c.company} for ${c.role}, and the HR round format` },
        { q: `${c.company} company values culture what they look for in candidates`, ask: `${c.company}'s values, culture, and what HR interviewers look for` },
      ];

  send({ type: "status", text: `Reading your resume and researching ${c.company}…` });
  const notes = [];
  const seen = new Set();
  for (const { q, ask } of searches) {
    send({ type: "search", query: q });
    try {
      const resp = await chat(SEARCH_MODELS, {
        messages: [
          { role: "system", content: "You are an interview researcher. Use browser search, then answer concisely in plain bullet points. Only include things you actually found; name the source site for each point." },
          { role: "user", content: `Search the web for: "${q}". Open at most 4 of the most relevant pages. Report ${ask}. Maximum 14 bullets, under 300 words.` },
        ],
        tools: [{ type: "browser_search" }],
        tool_choice: "required",
        max_completion_tokens: 1800,
      });
      const msg = resp.choices[0]?.message;
      notes.push(`### Search: ${q}\n${(msg?.content || "").replace(/【[^】]*】/g, "").trim()}`);
      for (const src of sourcesFrom(msg)) {
        if (seen.has(src.url)) continue;
        seen.add(src.url);
        s.sources.push(src);
        send({ type: "source", ...src });
      }
    } catch (e) {
      // A failed search shouldn't stop the interview; the plan is still built from the CV and known patterns.
      console.warn("Groq search failed:", e.status || "", e.message);
      notes.push(`### Search: ${q}\n(search unavailable right now)`);
    }
  }

  send({ type: "status", text: "Building your personalised interview plan…" });
  const system = researchSystemPrompt.replace(
    "Then call submit_interview_plan exactly once with the complete plan. Do not write the plan as text.",
    "You already have live web-search notes below. Return JSON matching the schema exactly. Keep every string short.",
  );
  const context = `<candidate_cv>\n${clip(s.cvText, 3500)}\n</candidate_cv>\n\n${researchUserPrompt(c)}\n\nLive web research notes:\n${clip(notes.join("\n\n"), 3000)}`;

  // Part 1: questions and insights (smaller outputs are far more reliable on free models).
  const props = PLAN_TOOL.input_schema.properties;
  const mainKeys = ["candidate_summary", "cv_languages", "key_skills", "company_insights", "interview_process", "focus_areas", "questions", "core_questions"];
  const mainSchema = { type: "object", additionalProperties: false, required: mainKeys, properties: Object.fromEntries(mainKeys.map((k) => [k, props[k]])) };
  const r1 = await chat(PLAN_MODELS, {
    messages: [{ role: "system", content: system }, { role: "user", content: `${context}\n\nNOW: fill only the fields in the schema (no coding/SQL problems in this part). At most 6 items in "questions"; ${tech ? "exactly 2 core_questions for each of oops, dbms, os, cn, software_dev and 2 for the main CV language, each with 2 short follow_ups" : "core_questions must be an empty array"}.` }],
    response_format: jsonFormat("interview_plan", mainSchema),
    max_completion_tokens: 3000,
  });
  const plan = parseJson(r1.choices[0]?.message);

  // Part 2: coding + SQL problems (technical only). Any failure falls back to the problem bank.
  if (tech) {
    try {
      const probKeys = ["dsa_array", "dsa_string", "sql"];
      const probSchema = {
        type: "object", additionalProperties: false, required: probKeys,
        properties: { dsa_array: props.dsa_array.anyOf[0], dsa_string: props.dsa_string.anyOf[0], sql: props.sql },
      };
      const r2 = await chat(PLAN_MODELS, {
        messages: [
          { role: "system", content: "You pick interview coding problems. Return JSON matching the schema exactly." },
          { role: "user", content: `Company: ${c.company}. Role: ${c.role}. Difficulty: ${c.difficulty} (LeetCode-${c.difficulty}, solvable in ~4 minutes).\nResearch notes:\n${clip(notes.join("\n\n"), 2500)}\n\nChoose ONE array problem (dsa_array), ONE string problem (dsa_string) and exactly TWO SQL questions (sql) with CREATE TABLE schemas and a few sample rows. Prefer problems the notes say ${c.company} actually asked. Keep statements short.` },
        ],
        response_format: jsonFormat("interview_problems", probSchema),
        max_completion_tokens: 1800,
      });
      Object.assign(plan, parseJson(r2.choices[0]?.message));
    } catch (e) {
      console.warn("Groq problem selection failed, using problem bank:", e.status || "", e.message?.slice(0, 120));
    }
  }
  return plan;
}

// ---------------------------------------------------------------- interview turns

/** Compact background for every turn — the [STEP] note in each message carries the actual question/problem. */
function planDigest(plan) {
  return [
    `Candidate: ${clip(plan.candidate_summary, 450)}`,
    plan.cv_languages?.length ? `Languages on CV: ${plan.cv_languages.join(", ")}` : "",
    plan.key_skills?.length ? `Key skills: ${plan.key_skills.slice(0, 10).join(", ")}` : "",
    `Company insights: ${clip(plan.company_insights, 450)}`,
    `Interview process: ${clip(plan.interview_process, 250)}`,
  ].filter(Boolean).join("\n");
}

const TURN_SCHEMA = {
  ...TURN_TOOL.input_schema,
  required: ["spoken", ...TURN_TOOL.input_schema.required],
  properties: { spoken: { type: "string", description: "Exactly what you say aloud to the candidate this turn." }, ...TURN_TOOL.input_schema.properties },
};

export async function groqTurn(s, userText, send) {
  s.gmessages ||= [];
  const system = interviewerSystemPrompt(s.config, "__PLAN__", s.interviewer)
    .replace(JSON.stringify("__PLAN__", null, 2), planDigest(s.plan))
    .replace("- After speaking, ALWAYS call record_turn once.", '- Reply ONLY with the JSON object: put exactly what you say aloud in "spoken", and fill the other fields as metadata for this turn.');

  s.gmessages.push({ role: "user", content: clip(userText, 6000) });
  // Keep the last few exchanges verbatim; older ones are summarised as a topic list to stay under the free token limits.
  const recent = s.gmessages.slice(-10);
  const asked = s.turns.map((t) => `- ${clip(t.question, 110)}`).slice(-18);
  const history = asked.length ? [{ role: "user", content: `[Questions you have ALREADY asked in this interview — never ask any of these again, ask something new:\n${asked.join("\n")}]` }, { role: "assistant", content: "Understood." }] : [];

  let resp;
  try {
    resp = await chat(JSON_MODELS, {
      messages: [{ role: "system", content: system }, ...history, ...(recent[0]?.role === "assistant" ? recent.slice(1) : recent)],
      response_format: jsonFormat("interviewer_turn", TURN_SCHEMA),
      max_completion_tokens: 1200,
    });
  } catch (e) {
    s.gmessages.pop();
    throw e;
  }
  const meta = parseJson(resp.choices[0]?.message);
  const seenS = new Set();
  const spoken = (String(meta.spoken || "").match(/[^.!?]+[.!?]*\s*/g) || [])
    .filter((p) => { const k = p.trim().toLowerCase(); if (!k || seenS.has(k)) return false; seenS.add(k); return true; })
    .join("").trim() || "Please go ahead.";
  delete meta.spoken;

  let remembered = spoken;
  if (meta.coding_task) remembered += `\n[Shared coding problem on screen: ${meta.coding_task.title}]`;
  if (meta.sql_task) remembered += `\n[Shared SQL question on screen: ${meta.sql_task.title}]`;
  s.gmessages.push({ role: "assistant", content: remembered });

  // Deliver in small chunks so captions appear progressively.
  const parts = spoken.match(/\S+\s*/g) || [spoken];
  for (let i = 0; i < parts.length; i += 3) {
    send({ type: "delta", text: parts.slice(i, i + 3).join("") });
    await sleep(25);
  }
  return { spoken, meta };
}

// ---------------------------------------------------------------- report

export async function groqReport(s, userText) {
  const resp = await chat(JSON_MODELS, {
    messages: [
      { role: "system", content: reportSystemPrompt },
      { role: "user", content: `<candidate_cv>\n${clip(s.cvText, 2500)}\n</candidate_cv>\n\n${clip(userText, 11000)}\n\nKeep every comment to 1–2 sentences.` },
    ],
    response_format: jsonFormat("interview_report", REPORT_SCHEMA),
    max_completion_tokens: 3200,
  });
  return parseJson(resp.choices[0]?.message);
}
