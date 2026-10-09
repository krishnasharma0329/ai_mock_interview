// Mock Interviewer — admin page: list and review saved interviews.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TONE = (v) => (v >= 75 ? "#16a34a" : v >= 50 ? "#d97706" : "#dc2626");
const TOPIC = { resume: "Resume & Projects", language: "Programming Language", oops: "OOPs", dbms: "DBMS", os: "Operating Systems", cn: "Computer Networks", software_dev: "Software Development", dsa: "DSA", sql: "SQL", behavioral: "Behavioural", company_fit: "Company Fit" };

let password = "";
try { password = sessionStorage.getItem("mm-admin") || ""; } catch {}
let all = [];
let openId = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "x-admin-password": password, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const initials = (n) => String(n || "?").split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

async function load() {
  try {
    const { interviews } = await api("/api/admin/interviews");
    all = interviews;
    $("#login").classList.add("hidden");
    $("#dash").classList.remove("hidden");
    $("#refreshBtn").classList.remove("hidden");
    $("#logoutBtn").classList.remove("hidden");
    render();
  } catch (e) {
    $("#dash").classList.add("hidden");
    $("#login").classList.remove("hidden");
    if (password) { $("#loginErr").textContent = e.message; $("#loginErr").classList.remove("hidden"); }
    if (e.status === 401) { password = ""; try { sessionStorage.removeItem("mm-admin"); } catch {} }
  }
}

function render() {
  const q = $("#search").value.trim().toLowerCase();
  const list = all.filter((r) => !q || [r.name, r.company, r.role].some((x) => String(x || "").toLowerCase().includes(q)));
  const done = all.filter((r) => r.status === "completed");
  const scores = done.map((r) => r.overall_score).filter((x) => typeof x === "number");
  $("#stTotal").textContent = all.length;
  $("#stDone").textContent = done.length;
  $("#stAvg").textContent = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : "—";
  $("#stSel").textContent = done.filter((r) => (r.selection_probability ?? 0) >= 60).length;
  $("#empty").classList.toggle("hidden", list.length > 0);
  $("#rows").innerHTML = list.map((r) => `
    <tr data-id="${esc(r.id)}">
      <td>${r.snapshot_url ? `<img class="thumb" src="${esc(r.snapshot_url)}" alt="" loading="lazy">` : `<div class="thumb">${esc(initials(r.name))}</div>`}</td>
      <td><b>${esc(r.name)}</b><small>${esc(r.role)} · ${esc(r.company)}</small></td>
      <td>${r.interview_type === "hr" ? "HR" : "Technical"}<small>${esc(r.difficulty)} · ${esc(r.duration_min)} min</small></td>
      <td>${fmtDate(r.created_at)}</td>
      <td>${r.status === "completed" ? `<span class="pill pill-success">Completed</span>` : `<span class="pill pill-neutral">In progress</span>`}${r.basic_report ? `<small>basic report</small>` : ""}</td>
      <td>${typeof r.overall_score === "number" ? `<span class="score" style="color:${TONE(r.overall_score)}">${r.overall_score}</span><small>${r.selection_probability ?? "—"}% chance</small>` : "—"}</td>
      <td>${esc(r.verdict || "—")}</td>
    </tr>`).join("");
  document.querySelectorAll("#rows tr").forEach((tr) => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
}

async function openDetail(id) {
  openId = id;
  $("#detail").classList.remove("hidden");
  $("#dBody").innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const { interview: r } = await api(`/api/admin/interviews/${encodeURIComponent(id)}`);
    const rep = r.report || {};
    $("#dTitle").textContent = `${r.name} — ${r.company}`;
    const bars = (items, label) => (items || []).map((x) => `
      <div class="bar-row"><div class="bar-top"><span>${esc(label(x))}</span><span style="color:${TONE(x.score)}">${x.score}</span></div>
      <div class="bar"><i style="width:${Math.max(0, Math.min(100, x.score))}%;background:${TONE(x.score)}"></i></div><p>${esc(x.comment)}</p></div>`).join("");
    $("#dBody").innerHTML = `
      <div class="card d-top">
        ${r.snapshot_url ? `<a href="${esc(r.snapshot_url)}" target="_blank" rel="noopener"><img class="d-photo" src="${esc(r.snapshot_url)}" alt="Interview snapshot"></a>` : `<div class="d-photo">No photo saved</div>`}
        <div>
          <h3>${esc(r.name)}</h3>
          <div class="muted">${esc(r.role)} · ${esc(r.company)}</div>
          <div class="kv">
            <span>Interview</span><b>${r.interview_type === "hr" ? "HR" : "Technical"} · ${esc(r.difficulty)} · ${esc(r.duration_min)} min</b>
            <span>Interviewer</span><b>${esc(r.interviewer || "—")}</b>
            <span>Started</span><b>${fmtDate(r.created_at)}</b>
            <span>Finished</span><b>${fmtDate(r.completed_at)}</b>
            <span>Score</span><b style="color:${TONE(r.overall_score ?? 0)}">${r.overall_score ?? "—"} / 100 · ${r.selection_probability ?? "—"}% chance · ${esc(r.verdict || "—")}</b>
          </div>
        </div>
      </div>
      ${rep.summary ? `<div class="card d-sec"><h4>${esc(rep.headline || "Summary")}</h4><p>${esc(rep.summary)}</p>${r.basic_report ? `<p class="muted">This is a basic report (the AI report could not be generated).</p>` : ""}</div>` : ""}
      ${rep.skill_scores?.length ? `<div class="card d-sec"><h4>Skills</h4>${bars(rep.skill_scores, (x) => x.skill)}</div>` : ""}
      ${rep.topic_scores?.length ? `<div class="card d-sec"><h4>Topics asked</h4>${bars(rep.topic_scores, (x) => TOPIC[x.topic] || x.topic)}</div>` : ""}
      ${rep.coding_review?.length ? `<div class="card d-sec"><h4>Coding &amp; SQL</h4>${rep.coding_review.map((c) => `<p><b>${esc(c.problem)}</b> — ${esc(c.correctness.replace("_", " "))}${c.complexity ? ` · ${esc(c.complexity)}` : ""}<br>${esc(c.feedback)}</p>`).join("")}</div>` : ""}
      ${(rep.strengths?.length || rep.improvements?.length) ? `<div class="card d-sec"><h4>Strengths &amp; improvements</h4>${(rep.strengths || []).map((x) => `<p>✓ ${esc(x)}</p>`).join("")}${(rep.improvements || []).map((x) => `<p>→ ${esc(x)}</p>`).join("")}</div>` : ""}
      <div class="card d-sec"><h4>Transcript</h4>${(r.transcript || []).map((t) => `
        <div class="tline"><div class="q">${esc(t.question)}</div>${t.problem ? `<div class="muted">Problem: ${esc(t.problem)}</div>` : ""}
        <div class="a">${t.answer ? esc(t.answer) : `<span class="muted">(no answer)</span>`}</div>${t.code ? `<pre>${esc(t.code)}</pre>` : ""}${t.live_score != null ? `<div class="muted">Live score: ${t.live_score}/10</div>` : ""}</div>`).join("") || `<p class="muted">No transcript yet (interview in progress or not finished).</p>`}</div>
      <details class="card d-sec"><summary><b>Resume text</b></summary><div class="resume">${esc(r.resume_text || "")}</div></details>`;
  } catch (e) {
    $("#dBody").innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

$("#loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  password = $("#pw").value;
  try { sessionStorage.setItem("mm-admin", password); } catch {}
  $("#loginErr").classList.add("hidden");
  load();
});
$("#logoutBtn").addEventListener("click", () => {
  password = "";
  try { sessionStorage.removeItem("mm-admin"); } catch {}
  location.reload();
});
$("#refreshBtn").addEventListener("click", load);
$("#search").addEventListener("input", render);
$("#closeDetail").addEventListener("click", () => $("#detail").classList.add("hidden"));
$("#detail").addEventListener("click", (e) => { if (e.target.id === "detail") $("#detail").classList.add("hidden"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#detail").classList.add("hidden"); });
$("#deleteBtn").addEventListener("click", async () => {
  if (!openId || !confirm("Delete this interview and its photo permanently?")) return;
  try {
    await api(`/api/admin/interviews/${encodeURIComponent(openId)}`, { method: "DELETE" });
    $("#detail").classList.add("hidden");
    load();
  } catch (e) { alert(e.message); }
});

if (password) load();
