// Mock Interviewer — frontend controller (vanilla JS, no build step)

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const DURATIONS = { technical: [20, 25, 30], hr: [15, 20, 25] };
const FILLERS = /\b(um+|uh+|erm+|hmm+|uhm+|you know|basically|actually|literally|i mean|kind of|sort of)\b/gi;
const LANG_LABEL = { java: "Java", python: "Python", cpp: "C++", c: "C", javascript: "JavaScript", csharp: "C#", go: "Go", sql: "SQL", other: "Other" };
const STARTER = {
  java: "class Solution {\n    \n}\n",
  python: "def solve():\n    pass\n",
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\n\n",
  c: "#include <stdio.h>\n\n",
  javascript: "function solve() {\n  \n}\n",
  csharp: "public class Solution {\n    \n}\n",
  go: "package main\n\n",
  sql: "SELECT\n",
};
const isStarter = (code) => !code.trim() || Object.values(STARTER).some((s) => s.trim() === code.trim());

const S = {
  sessionId: null,
  config: null,
  plan: null,
  sources: [],
  interviewer: { name: "Priya Sharma", title: "Senior Software Engineer" },
  lang: "en-IN",
  stream: null,
  micOn: true,
  camOn: true,
  voiceOn: true,
  phase: "idle",
  mode: "voice",
  task: null,
  codeTouched: false,
  prefLang: null,
  complete: false,
  ended: false,
  busy: false,
  startedAt: 0,
  durationMs: 0,
  answers: [],
  turn: null,
};

// ---------------------------------------------------------------- AI status banner
S.ai = "checking";
async function checkHealth() {
  let h;
  try { h = await (await fetch("/api/health")).json(); } catch { h = { ai: "down" }; }
  S.ai = h.ai;
  $("#accessField").classList.toggle("hidden", !h.accessCode);
  S.storage = !!h.storage;
  $("#consentBox").classList.toggle("hidden", !S.storage);
  updateJoin();
  const el = $("#aiBanner");
  $("#mockBadge").classList.toggle("hidden", !h.mock);
  if (h.mock) {
    el.className = "ai-banner warn";
    el.innerHTML = `<div><b>Demo mode: this is NOT the real AI interviewer.</b>Questions are a fixed script, your answers are not analysed and no company research is done. To use the real AI: stop the server, put your free Groq API key after <code>GROQ_API_KEY=</code> in the <code>.env</code> file and start with <code>npm start</code>.</div>`;
  } else if (h.ai === "checking") {
    setTimeout(checkHealth, 1500);
    return;
  } else if (h.ai === "down") {
    el.className = "ai-banner error";
    el.innerHTML = `<div><b>The interview server is not running.</b>Start it with <code>npm start</code> and refresh this page.</div>`;
  } else if (h.ai !== "ok") {
    el.className = "ai-banner error";
    el.innerHTML = `<div><b>The AI interviewer is not connected.</b>${esc(h.message)}</div>`;
  } else {
    el.className = "ai-banner hidden";
  }
}
checkHealth();

// ---------------------------------------------------------------- landing: company logo wall
(function buildLogoWall() {
  const logos = ["google", "microsoft", "amazon", "meta", "apple", "netflix", "infosys", "tcs", "wipro", "accenture", "oracle", "adobe",
    "intel", "cisco", "cognizant", "hcl", "flipkart", "zoho", "salesforce", "nvidia", "uber", "paypal", "samsung", "linkedin",
    "swiggy", "zomato", "paytm", "spotify", "airbnb", "atlassian", "sap", "dell", "hp"];
  const wall = $("#logoWall");
  for (let r = 0; r < 9; r++) {
    const row = document.createElement("div");
    row.className = "logo-row";
    const shift = (r * 7) % logos.length;
    const order = [...logos.slice(shift), ...logos.slice(0, shift)].slice(0, 22);
    // Duplicate the sequence so the drift animation loops seamlessly.
    row.innerHTML = [...order, ...order].map((l) => `<span class="logo-tile"><img src="logos/${l}.svg" alt="" loading="lazy"></span>`).join("");
    wall.append(row);
  }
})();

function show(screen) {
  $$(".screen").forEach((el) => el.classList.toggle("active", el.id === `screen-${screen}`));
  window.scrollTo(0, 0);
}
function showError(el, msg) {
  el.innerHTML = msg ? esc(msg) : "";
  el.classList.toggle("hidden", !msg);
}

/** POST and consume an NDJSON stream. */
async function streamPost(url, body, onEvent) {
  // The interview state token travels with every request (the server keeps nothing between requests).
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(body || {}), state: S.state }) });
  if (!res.ok || !res.body) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(JSON.parse(line));
    }
  }
  if (buf.trim()) handle(JSON.parse(buf));
  function handle(e) {
    if (e.type === "state") S.state = e.state;
    else onEvent(e);
  }
}

// ================================================================ PAGE 1 — wizard
const form = $("#setupForm");

function goStep(n) {
  $$("#stepper li").forEach((li) => {
    const k = Number(li.dataset.step);
    li.classList.toggle("active", k === n);
    li.classList.toggle("done", k < n);
  });
  $$(".step-pane").forEach((p) => p.classList.toggle("active", Number(p.dataset.pane) === n));
}

function renderDurations() {
  const opts = DURATIONS[form.type.value];
  const cur = Number(form.querySelector('input[name="duration"]:checked')?.value);
  const pick = opts.includes(cur) ? cur : opts[opts.length - 1];
  $("#durationGroup").innerHTML = opts
    .map((m) => `<label><input type="radio" name="duration" value="${m}" ${m === pick ? "checked" : ""}/><span>${m} min</span></label>`)
    .join("");
}
form.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener("change", renderDurations));
renderDurations();

$("#next1").addEventListener("click", () => {
  if (!$("#accessField").classList.contains("hidden") && !form.accessCode.value.trim()) { showError($("#err1"), "Please enter the access code."); form.accessCode.focus(); return; }
  for (const [k, label] of [["name", "your full name"], ["role", "the position"], ["company", "the company"]]) {
    if (!form[k].value.trim()) { showError($("#err1"), `Please enter ${label}.`); form[k].focus(); return; }
  }
  showError($("#err1"), "");
  goStep(2);
});
$("#back2").addEventListener("click", () => goStep(1));
form.addEventListener("submit", (e) => e.preventDefault());
[$("#fName"), $("#fRole"), $("#fCompany")].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#next1").click(); } }));

const dz = $("#dropzone");
const cvInput = $("#cvInput");
function setCv(file) {
  if (!file) return;
  if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) return showError($("#err2"), "Please upload a PDF, DOCX or TXT file.");
  if (file.size > 4 * 1024 * 1024) return showError($("#err2"), "Your resume must be under 4 MB.");
  const dt = new DataTransfer();
  dt.items.add(file);
  cvInput.files = dt.files;
  dz.classList.add("has-file");
  $("#cvName").textContent = file.name;
  $("#cvHint").textContent = `${Math.max(1, Math.round(file.size / 1024))} KB · click to replace`;
  showError($("#err2"), "");
}
cvInput.addEventListener("change", () => setCv(cvInput.files[0]));
["dragenter", "dragover"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (ev) => setCv(ev.dataTransfer.files[0]));

$("#next2").addEventListener("click", async () => {
  if (!cvInput.files[0]) return showError($("#err2"), "Please upload your resume.");
  showError($("#err2"), "");
  const fd = new FormData(form);
  S.lang = fd.get("lang");
  S.config = {
    name: fd.get("name").trim(), role: fd.get("role").trim(), company: fd.get("company").trim(),
    type: fd.get("type"), difficulty: fd.get("difficulty"), duration: Number(fd.get("duration")),
  };
  const btn = $("#next2");
  btn.disabled = true;
  try {
    const res = await fetch("/api/session", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not start");
    S.sessionId = data.sessionId;
    S.state = data.state;
    goStep(3);
    initDevices();
    runResearch();
  } catch (e) {
    showError($("#err2"), e.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- step 3: research
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
function addSourceLink(src) {
  const url = safeUrl(src.url);
  if (!url) return;
  const li = document.createElement("li");
  li.innerHTML = `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(src.title || url)}</a>`;
  $("#srcList").append(li);
  $("#srcCount").textContent = $("#srcList").children.length;
  $("#srcFound").classList.remove("hidden");
}
function setCheck(key, state, text) {
  const li = $(`#checklist li[data-c="${key}"]`);
  li.classList.remove("active", "done");
  if (state) li.classList.add(state);
  if (text != null) li.querySelector("small").textContent = text;
}

async function runResearch() {
  const c = S.config;
  $("#companyLine").textContent = `Researching ${c.company}`;
  $("#prepTitle").textContent = "Preparing your interview";
  $("#prepSub").textContent = "This usually takes under a minute.";
  $("#prepSummary").classList.add("hidden");
  showError($("#err3"), "");
  ["cv", "company", "questions", "ready"].forEach((k) => setCheck(k, null));
  setCheck("cv", "active");
  $("#srcList").innerHTML = "";
  $("#srcFound").classList.add("hidden");
  S.ready = false;
  $("#joinBtn").disabled = true;
  let sources = 0;
  try {
    await streamPost(`/api/session/${S.sessionId}/research`, {}, (e) => {
      if (e.type === "search") {
        setCheck("cv", "done", "Resume checked");
        setCheck("company", "active", `Searching: ${e.query}`);
      } else if (e.type === "source") {
        sources++;
        addSourceLink(e);
        setCheck("questions", "active", `${sources} interview source${sources > 1 ? "s" : ""} found`);
      } else if (e.type === "status" && /plan/i.test(e.text)) {
        setCheck("cv", "done");
        setCheck("company", "done", `${c.company} interview process reviewed`);
        setCheck("questions", "done");
        setCheck("ready", "active", "Selecting questions for your profile");
      } else if (e.type === "plan") {
        S.plan = e.plan;
        S.sources = e.sources || [];
        if (e.interviewer) S.interviewer = e.interviewer;
        setCheck("cv", "done", "Resume checked");
        setCheck("company", "done", `${c.company} interview process reviewed`);
        setCheck("questions", "done", `${sources} sources reviewed`);
        setCheck("ready", "done", `${S.interviewer.name} will take your interview`);
        $("#prepTitle").textContent = "Your interview is ready";
        $("#prepSub").textContent = `${c.type === "hr" ? "HR" : "Technical"} interview · ${c.difficulty} · ${c.duration} minutes`;
        const trim = (t, n) => (t && t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t || "");
        $("#prepSummary").innerHTML = `<p><b>Your profile:</b> ${esc(trim(e.plan.candidate_summary, 220))}</p><p><b>${esc(c.company)}:</b> ${esc(trim(e.plan.company_insights, 240))}</p>`;
        $("#prepSummary").classList.remove("hidden");
        S.ready = true;
        updateJoin();
      } else if (e.type === "error") {
        throw new Error(e.error);
      }
    });
    if (!S.plan) throw new Error("Preparation stopped unexpectedly.");
  } catch (e) {
    $$("#checklist li.active").forEach((li) => li.classList.remove("active"));
    $("#err3").innerHTML = `${esc(e.message)} <button type="button" class="btn btn-ghost btn-sm" id="retry3" style="margin-left:8px">Try again</button>`;
    $("#err3").classList.remove("hidden");
    $("#retry3").onclick = runResearch;
  }
}

function updateJoin() {
  const needConsent = S.storage && !$("#consentCheck").checked;
  $("#joinBtn").disabled = !S.ready || needConsent;
  $("#joinHint").textContent = !S.ready ? "Available once your interview is ready" : needConsent ? "Please accept the consent above to join" : "Use headphones for the best experience";
}
$("#consentCheck").addEventListener("change", updateJoin);

// ---------------------------------------------------------------- devices
let audioCtx, analyser, levelData, levelRAF;
let micWorking = false;

async function initDevices() {
  if (S.stream) return;
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: 640, height: 400 } });
  } catch {
    try { S.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { S.stream = null; }
  }
  if (!S.stream) {
    $("#previewMsg").textContent = "Camera and microphone are blocked. Allow access in the address bar, or you can type your answers.";
    $("#micStatus").textContent = "Microphone not available";
    return;
  }
  const hasVideo = S.stream.getVideoTracks().length > 0;
  $("#previewVideo").srcObject = S.stream;
  $("#previewOff").classList.toggle("hidden", hasVideo);
  if (!hasVideo) { $("#previewMsg").textContent = "No camera found"; $("#optCamera").checked = false; }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(S.stream).connect(analyser);
  levelData = new Uint8Array(analyser.fftSize);
  const tick = () => {
    analyser.getByteTimeDomainData(levelData);
    let sum = 0;
    for (const v of levelData) sum += ((v - 128) / 128) ** 2;
    const level = Math.min(1, Math.sqrt(sum / levelData.length) * 5);
    $("#previewLevel").style.width = `${level * 100}%`;
    if (level > 0.25 && !micWorking) { micWorking = true; $("#micStatus").textContent = "Microphone is working"; }
    levelRAF = requestAnimationFrame(tick);
  };
  tick();
}
$("#optCamera").addEventListener("change", (e) => {
  S.camOn = e.target.checked;
  S.stream?.getVideoTracks().forEach((t) => (t.enabled = S.camOn));
  $("#previewOff").classList.toggle("hidden", S.camOn && !!S.stream?.getVideoTracks().length);
  if (!S.camOn) $("#previewMsg").textContent = "Camera is off";
});

// ================================================================ text-to-speech
const Speaker = {
  queue: 0, gen: 0, buffer: "", streaming: false, onIdle: null, voice: null,
  pickVoice() {
    const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    const lang = S.lang.toLowerCase();
    const female = /female|zira|samantha|heera|veena|susan|hazel|libby|sonia|neerja|aria|jenny|karen|moira|tessa|serena/i;
    this.voice =
      voices.find((v) => v.lang.toLowerCase() === lang && female.test(v.name)) ||
      voices.find((v) => female.test(v.name)) ||
      voices.find((v) => v.lang.toLowerCase() === lang) ||
      voices[0] || null;
  },
  begin() { this.cancel(); this.streaming = true; },
  feed(text) {
    if (!S.voiceOn || !("speechSynthesis" in window)) return;
    this.buffer += text;
    let m;
    while ((m = this.buffer.match(/^([\s\S]*?[.!?])(\s+)/))) {
      this.say(m[1]);
      this.buffer = this.buffer.slice(m[0].length);
    }
  },
  end() {
    this.streaming = false;
    if (S.voiceOn && this.buffer.trim()) this.say(this.buffer);
    this.buffer = "";
    this.checkIdle();
  },
  say(text) {
    if (!text.trim() || !("speechSynthesis" in window)) return;
    if (!this.voice) this.pickVoice();
    const u = new SpeechSynthesisUtterance(text.trim());
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang || S.lang;
    u.rate = 1;
    this.queue++;
    u.onstart = () => setPhase("speaking");
    let finished = false;
    const gen = this.gen;
    const done = () => { if (finished || gen !== this.gen) return; finished = true; this.queue = Math.max(0, this.queue - 1); this.checkIdle(); };
    u.onend = done;
    u.onerror = done;
    // Some voice engines never fire onend; don't let the call hang.
    setTimeout(done, 4000 + text.split(/\s+/).length * 600);
    speechSynthesis.speak(u);
  },
  checkIdle() {
    if (!this.streaming && this.queue === 0) { const cb = this.onIdle; this.onIdle = null; cb?.(); }
  },
  cancel() {
    this.gen++;
    this.buffer = ""; this.queue = 0; this.onIdle = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  },
};
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => Speaker.pickVoice();

// ================================================================ PAGE 2 — the call
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const firstName = () => S.interviewer.name.split(" ")[0];
const canSpeak = () => S.micOn && !!SR && !!S.stream;

function setPhase(p) {
  S.phase = p;
  const st = $("#callStatus");
  st.textContent = {
    thinking: `${firstName()} is thinking…`,
    speaking: `${firstName()} is speaking`,
    listening: canSpeak() ? "Listening — answer whenever you're ready" : "Your turn — type your answer",
    idle: "Connected",
    ended: "Interview ended",
  }[p];
  st.className = `call-status ${p}`;
  $("#avatar").classList.toggle("speaking", p === "speaking");
  $("#avatar").classList.toggle("thinking", p === "thinking");
  $("#aiTile").classList.toggle("talking", p === "speaking");
}

function setAiCaption(text) {
  $("#aiCaption").innerHTML = text ? `<span>${esc(text)}</span>` : "";
}

// ---------------------------------------------------------------- speech recognition
let rec = null;
const heard = { final: "", interim: "", lastAt: 0 };
let talkTimer;

const heardText = () => (heard.final + " " + heard.interim).replace(/\s+/g, " ").trim();
function resetHeard() { heard.final = ""; heard.interim = ""; heard.lastAt = 0; renderMeCaption(); }
function renderMeCaption() {
  const f = heard.final.trim();
  const i = heard.interim.trim();
  $("#meCaption").innerHTML = f || i ? `<span>${esc(f)} <span class="interim">${esc(i)}</span></span>` : "";
}

function startRecognition() {
  if (!canSpeak() || S.ended || rec) return;
  const r = new SR();
  rec = r;
  r.lang = S.lang;
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (ev) => {
    if (rec !== r) return;
    const now = performance.now();
    const t = S.turn;
    if (t) { if (!t.firstAt) t.firstAt = now; t.lastAt = now; t.via = "voice"; }
    heard.interim = "";
    for (let k = ev.resultIndex; k < ev.results.length; k++) {
      const res = ev.results[k];
      if (res.isFinal) heard.final += " " + res[0].transcript.trim();
      else heard.interim += " " + res[0].transcript;
    }
    heard.lastAt = Date.now();
    renderMeCaption();
    $("#meTile").classList.add("talking");
    clearTimeout(talkTimer);
    talkTimer = setTimeout(() => $("#meTile").classList.remove("talking"), 700);
  };
  r.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      S.micOn = false;
      updateMicUI();
      showCallError("Microphone access was blocked, so please type your answers below.");
      openDrawer(false);
    }
  };
  r.onend = () => {
    if (rec !== r) return;
    // Chrome stops continuous recognition after a silence; keep it alive while it's the candidate's turn.
    if (heard.interim.trim()) { heard.final += " " + heard.interim; heard.interim = ""; }
    if (S.phase === "listening" && S.micOn && !S.ended) { try { r.start(); } catch { rec = null; } } else rec = null;
  };
  try { r.start(); } catch { rec = null; }
}
function stopRecognition() {
  const r = rec;
  rec = null;
  if (r) { try { r.abort(); } catch {} }
  $("#meTile").classList.remove("talking");
}

/** Hands-free turn taking: once the candidate pauses, send what they said. */
setInterval(() => {
  const bar = $("#pauseBar");
  if (S.phase !== "listening" || S.busy || !heard.lastAt) { bar.style.width = "0"; return; }
  const text = heardText();
  // While they are typing or writing code, speech is held and sent together with "Submit".
  if (!text || S.codeTouched || $("#typeInput").value.trim()) { bar.style.width = "0"; return; }
  const words = text.split(" ").length;
  const threshold = S.mode !== "voice" ? 3800 : words < 4 ? 3500 : 2400;
  const quiet = Date.now() - heard.lastAt;
  bar.style.width = quiet > 500 ? `${Math.min(100, ((quiet - 500) / (threshold - 500)) * 100)}%` : "0";
  if (quiet >= threshold) sendAnswer({ answer: text });
}, 120);

// ---------------------------------------------------------------- turns
function openTurn() {
  S.turn = { openedAt: performance.now(), firstAt: 0, lastAt: 0, via: "text" };
}
function turnMetrics(answer) {
  const t = S.turn || { openedAt: performance.now() };
  return {
    words: (answer.match(/\S+/g) || []).length,
    fillers: (answer.match(FILLERS) || []).length,
    latencySec: t.firstAt ? Math.round((t.firstAt - t.openedAt) / 100) / 10 : null,
    speakMs: t.firstAt && t.lastAt ? t.lastAt - t.firstAt : 0,
    via: t.via,
  };
}

function showCallError(msg, retry) {
  const el = $("#callError");
  el.innerHTML = msg ? esc(msg) + (retry ? ` <button class="btn btn-primary btn-sm" id="retryTurn" style="margin-left:8px">Try again</button>` : "") : "";
  el.classList.toggle("hidden", !msg);
  if (retry) $("#retryTurn").onclick = retry;
}

async function sendAnswer({ answer = "", code = "" }) {
  if (S.busy || S.ended) return;
  stopRecognition();
  const metrics = turnMetrics(answer);
  const language = S.mode === "sql" ? "sql" : $("#langSelect").value;
  resetHeard();
  const ok = await interviewerTurn(`/api/session/${S.sessionId}/turn`, { answer, code, language, metrics });
  if (ok) S.answers.push(metrics);
}

async function interviewerTurn(url, body, attempt = 0) {
  S.busy = true;
  showCallError("");
  setPhase("thinking");
  setAiCaption("");
  Speaker.begin();
  let text = "";
  let meta = null;
  try {
    await streamPost(url, body, (e) => {
      if (e.type === "delta") {
        text += e.text;
        setAiCaption(text);
        Speaker.feed(e.text);
        if (!S.voiceOn) setPhase("speaking");
      } else if (e.type === "replace") {
        text = e.text;
        setAiCaption(text);
      } else if (e.type === "meta") meta = e.meta;
      else if (e.type === "error") throw new Error(e.error);
    });
  } catch (e) {
    Speaker.cancel();
    // Free-tier limits: wait and retry automatically a few times before asking the student.
    if (/limit|busy|429|try again/i.test(e.message) && !/today/i.test(e.message) && attempt < 3 && !S.ended) {
      setPhase("thinking");
      $("#callStatus").textContent = `${firstName()} is thinking… (high load, retrying)`;
      await new Promise((r) => setTimeout(r, 12000));
      return interviewerTurn(url, body, attempt + 1);
    }
    S.busy = false;
    setPhase("idle");
    showCallError(e.message, () => interviewerTurn(url, body));
    return false;
  }
  S.busy = false;
  if (meta) applyMeta(meta);
  Speaker.onIdle = afterInterviewerSpoke;
  Speaker.end();
  return true;
}

function applyMeta(meta) {
  if (meta.preferred_language && STARTER[meta.preferred_language]) S.prefLang = meta.preferred_language;
  if (meta.coding_task) openTask("code", meta.coding_task);
  else if (meta.sql_task) openTask("sql", meta.sql_task);
  else if (meta.response_mode === "voice") closeTask();
  if (meta.interview_complete) S.complete = true;
}

function afterInterviewerSpoke() {
  if (S.ended) return;
  if (S.complete) {
    setPhase("ended");
    setTimeout(finish, 1600);
    return;
  }
  openTurn();
  setPhase("listening");
  startRecognition();
  if (!canSpeak()) { openDrawer(false); $("#typeInput").focus(); }
}

// ---------------------------------------------------------------- slide-out answer / code panel
const codeBox = $("#codeBox");
const drawer = $("#drawer");
let drawerAuto = false; // opened automatically for a coding/SQL question

function openDrawer(auto = false) {
  if (!drawer.classList.contains("open")) drawerAuto = auto;
  drawer.classList.add("open");
  $("#screen-interview").classList.add("drawer-open");
  $("#kbBtn").classList.add("on-active");
}
function closeDrawer() {
  drawer.classList.remove("open");
  $("#screen-interview").classList.remove("drawer-open");
  $("#kbBtn").classList.remove("on-active");
  drawerAuto = false;
}
$("#kbBtn").addEventListener("click", () => {
  if (drawer.classList.contains("open")) closeDrawer();
  else { openDrawer(false); $("#typeInput").focus(); }
});
$("#drawerClose").addEventListener("click", closeDrawer);

function openTask(mode, task) {
  S.mode = mode;
  S.task = task;
  S.codeTouched = false;
  $("#cpKind").textContent = mode === "sql" ? "SQL question" : "Coding question";
  $("#cpTitle").textContent = task.title;
  $("#cpProblem").innerHTML =
    mode === "sql"
      ? `${esc(task.question)}<h6>Tables</h6><pre>${esc(task.schema)}</pre><h6>Sample data</h6><pre>${esc(task.sample_rows)}</pre>`
      : `${esc(task.statement)}<h6>Examples</h6><pre>${esc(task.examples)}</pre>${task.constraints ? `<h6>Constraints</h6><pre>${esc(task.constraints)}</pre>` : ""}`;
  $("#cpProblem").classList.remove("hidden");
  const sel = $("#langSelect");
  sel.value = mode === "sql" ? "sql" : S.prefLang || (sel.value === "sql" ? "java" : sel.value);
  sel.disabled = mode === "sql";
  codeBox.value = STARTER[sel.value];
  updateGutter();
  $("#drHint").textContent = "Explain your approach out loud, write the code, then press Submit.";
  openDrawer(true);
  $(".dr-body").scrollTop = 0;
}
function closeTask() {
  if (!S.task) return;
  S.mode = "voice";
  S.task = null;
  $("#cpProblem").classList.add("hidden");
  $("#cpKind").textContent = "Answer panel";
  $("#cpTitle").textContent = "Type your answer or write code";
  $("#langSelect").disabled = false;
  $("#drHint").textContent = "You can keep talking while you type.";
  if (drawerAuto) closeDrawer();
}
function updateGutter() {
  const n = codeBox.value.split("\n").length;
  $("#gutter").textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  $("#gutter").scrollTop = codeBox.scrollTop;
}
codeBox.addEventListener("input", () => {
  updateGutter();
  if (!isStarter(codeBox.value)) S.codeTouched = true;
  if (S.turn && !S.turn.firstAt) S.turn.firstAt = performance.now();
});
codeBox.addEventListener("scroll", () => ($("#gutter").scrollTop = codeBox.scrollTop));
codeBox.addEventListener("keydown", (e) => {
  const { selectionStart: a, selectionEnd: b, value } = codeBox;
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submitPanel();
  } else if (e.key === "Tab") {
    e.preventDefault();
    codeBox.value = value.slice(0, a) + "    " + value.slice(b);
    codeBox.selectionStart = codeBox.selectionEnd = a + 4;
    updateGutter();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const line = value.slice(value.lastIndexOf("\n", a - 1) + 1, a);
    let indent = line.match(/^\s*/)[0];
    if (/[:{(\[]\s*$/.test(line)) indent += "    ";
    codeBox.value = value.slice(0, a) + "\n" + indent + value.slice(b);
    codeBox.selectionStart = codeBox.selectionEnd = a + 1 + indent.length;
    updateGutter();
  }
});
$("#langSelect").addEventListener("change", (e) => {
  if (isStarter(codeBox.value)) { codeBox.value = STARTER[e.target.value]; updateGutter(); }
});
codeBox.value = STARTER.java;
updateGutter();

/** Send whatever is in the panel (typed text + code) together with anything said out loud. */
function submitPanel() {
  if (S.busy || S.ended || S.phase === "thinking") return;
  const typed = $("#typeInput").value.trim();
  const code = isStarter(codeBox.value) ? "" : codeBox.value;
  const spoken = heardText();
  if (!typed && !code && !spoken) {
    showCallError(S.task ? "Write your code (or type an answer) first, then press Submit." : "Type your answer first, then press Submit.");
    return;
  }
  if (S.phase === "speaking") { Speaker.cancel(); openTurn(); }
  if (S.turn && !S.turn.firstAt) S.turn.firstAt = performance.now();
  $("#typeInput").value = "";
  S.codeTouched = false;
  const answer = [spoken, typed].filter(Boolean).join(" ") || "(submitted code)";
  sendAnswer({ answer, code });
}
$("#submitCode").addEventListener("click", submitPanel);
$("#typeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitPanel(); }
});
$("#typeInput").addEventListener("input", () => { if (S.turn && !S.turn.firstAt) S.turn.firstAt = performance.now(); });

// ---------------------------------------------------------------- controls
function updateMicUI() {
  $("#micBtn").classList.toggle("off", !S.micOn);
  $("#micInd").classList.toggle("off", !S.micOn);
  if (S.phase === "listening") setPhase("listening");
}
$("#micBtn").addEventListener("click", () => {
  if (!S.stream || !SR) {
    openDrawer(false);
    return showCallError("Voice answers need Chrome or Edge with microphone access — please type your answers in the panel.");
  }
  S.micOn = !S.micOn;
  updateMicUI();
  if (S.micOn && S.phase === "listening") startRecognition();
  if (!S.micOn) stopRecognition();
});
$("#camBtn").addEventListener("click", () => {
  if (!S.stream?.getVideoTracks().length) return;
  S.camOn = !S.camOn;
  S.stream.getVideoTracks().forEach((t) => (t.enabled = S.camOn));
  $("#camBtn").classList.toggle("off", !S.camOn);
  $("#meOff").classList.toggle("hidden", S.camOn);
});
$("#endBtn").addEventListener("click", () => {
  if (S.ended) return;
  if (confirm("End the interview now and see your report?")) finish();
});
document.addEventListener("keydown", (e) => {
  if ($("#screen-interview").classList.contains("active") && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "m") { e.preventDefault(); $("#micBtn").click(); }
});

// ---------------------------------------------------------------- timer
let timerInt;
function startTimer() {
  S.startedAt = Date.now();
  S.durationMs = S.config.duration * 60000;
  const tick = () => {
    const left = Math.max(0, S.durationMs - (Date.now() - S.startedAt));
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    $("#timerText").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    $(".call-clock").classList.toggle("warn", left <= 3 * 60000 && left > 60000);
    $(".call-clock").classList.toggle("danger", left <= 60000);
    if (left <= 0) { clearInterval(timerInt); timeUp(); }
  };
  tick();
  timerInt = setInterval(tick, 1000);
}
function timeUp() {
  if (S.ended) return;
  stopRecognition();
  S.complete = true;
  const line = "We're out of time. Thank you for your time today, it was nice talking to you.";
  Speaker.begin();
  setAiCaption(line);
  Speaker.onIdle = () => finish();
  Speaker.feed(line + " ");
  Speaker.end();
  setTimeout(finish, 6000);
}

// ---------------------------------------------------------------- interview snapshot (stored only with consent)
function captureFrame() {
  const v = $("#selfVideo");
  if (!S.camOn || !v.videoWidth) return null;
  const w = Math.min(640, v.videoWidth);
  const h = Math.round((v.videoHeight / v.videoWidth) * w);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(v, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.75);
}
function scheduleSnapshot() {
  let tries = 0;
  const attempt = async () => {
    if (S.ended || S.snapshotSaved) return;
    const image = captureFrame();
    if (image) {
      try {
        const r = await fetch(`/api/session/${S.sessionId}/snapshot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: S.state, image }) });
        if (r.ok) { S.snapshotSaved = true; return; }
      } catch {}
    }
    if (++tries < 4) setTimeout(attempt, 30000); // camera might be off right now; try again later
  };
  setTimeout(attempt, 20000);
}

// ---------------------------------------------------------------- join
$("#joinBtn").addEventListener("click", async () => {
  const c = S.config;
  S.voiceOn = $("#optVoice").checked;
  S.camOn = $("#optCamera").checked && !!S.stream?.getVideoTracks().length;
  $("#callTitle").textContent = `${c.company} · ${c.type === "hr" ? "HR" : "Technical"} Interview`;
  $("#callSub").textContent = c.role;
  $("#coBadge").textContent = c.company.trim()[0]?.toUpperCase() || "C";
  $("#aiName").textContent = S.interviewer.name;
  $("#aiRole").textContent = c.type === "hr" ? `HR Manager, ${c.company}` : `${S.interviewer.title}, ${c.company}`;
  $("#meName").textContent = `${c.name} (You)`;
  $("#meInitials").textContent = c.name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  if (S.stream) $("#selfVideo").srcObject = S.stream;
  S.stream?.getVideoTracks().forEach((t) => (t.enabled = S.camOn));
  $("#meOff").classList.toggle("hidden", S.camOn);
  $("#camBtn").classList.toggle("off", !S.camOn);
  S.micOn = !!S.stream && !!SR;
  updateMicUI();
  if (!S.micOn) openDrawer(false);
  if (!SR) showCallError("Your browser doesn't support voice answers. Use Chrome or Edge, or type your answers below.");
  if (S.voiceOn && "speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  show("interview");
  window.addEventListener("beforeunload", beforeUnload);
  startTimer();
  await interviewerTurn(`/api/session/${S.sessionId}/start`, { consent: !!$("#consentCheck").checked });
  if (S.storage) scheduleSnapshot();
});
function beforeUnload(e) { if (!S.ended) { e.preventDefault(); e.returnValue = ""; } }

// ---------------------------------------------------------------- finish
function aggregateMetrics() {
  const a = S.answers;
  const voice = a.filter((x) => x.via === "voice" && x.speakMs > 2000);
  const totalWords = a.reduce((s, x) => s + x.words, 0);
  const totalFillers = a.reduce((s, x) => s + x.fillers, 0);
  const lat = a.filter((x) => x.latencySec != null);
  return {
    answers: a.length,
    voice_answers: a.filter((x) => x.via === "voice").length,
    typed_answers: a.filter((x) => x.via !== "voice").length,
    wpm: voice.length ? Math.round(voice.reduce((s, x) => s + x.words, 0) / (voice.reduce((s, x) => s + x.speakMs, 0) / 60000)) : null,
    totalWords,
    avgWordsPerAnswer: a.length ? Math.round(totalWords / a.length) : 0,
    totalFillers,
    fillersPer100Words: totalWords ? Math.round((totalFillers / totalWords) * 1000) / 10 : 0,
    avgLatencySec: lat.length ? Math.round((lat.reduce((s, x) => s + x.latencySec, 0) / lat.length) * 10) / 10 : null,
    minutesUsed: Math.round(((Date.now() - S.startedAt) / 60000) * 10) / 10,
    preferredLanguage: S.prefLang,
  };
}

async function finish() {
  if (S.ended) return;
  S.ended = true;
  clearInterval(timerInt);
  stopRecognition();
  Speaker.cancel();
  setPhase("ended");
  window.removeEventListener("beforeunload", beforeUnload);
  S.finalMetrics = aggregateMetrics();
  const body = {
    metrics: S.finalMetrics,
    pendingAnswer: heardText(),
    pendingCode: S.task && !isStarter(codeBox.value) ? codeBox.value : "",
    language: S.mode === "sql" ? "sql" : $("#langSelect").value,
  };
  $("#overlay").classList.remove("hidden");
  await loadReport(body);
}

async function loadReport(body) {
  $("#overlayTitle").textContent = "Interview complete";
  $("#overlayText").textContent = "Reviewing every answer and preparing your report…";
  try {
    const res = await fetch(`/api/session/${S.sessionId}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, state: S.state }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create the report");
    cancelAnimationFrame(levelRAF);
    audioCtx?.close().catch(() => {});
    S.stream?.getTracks().forEach((t) => t.stop());
    renderReport(data);
    if (data.basic) {
      const note = document.createElement("div");
      note.className = "card r-sec basic-note";
      note.innerHTML = `<div><b>This is a basic report.</b> The detailed AI report couldn't be created right now: ${esc(data.reason || "the AI service is unavailable")}<br/>Your interview is saved — you can try again in a minute.</div><button class="btn btn-primary btn-sm" id="fullReportBtn">Try full AI report again</button>`;
      $("#reportRoot").prepend(note);
      $("#fullReportBtn").onclick = async () => {
        $("#fullReportBtn").disabled = true;
        $("#fullReportBtn").textContent = "Generating…";
        await loadReport(body);
      };
    }
    $("#overlay").classList.add("hidden");
    show("report");
  } catch (e) {
    $("#overlayTitle").textContent = "Couldn't create the report";
    $("#overlayText").innerHTML = `${esc(e.message)}<br/><br/><button class="btn btn-primary" id="retryReport">Try again</button>`;
    $("#retryReport").onclick = () => loadReport(body);
  }
}

// ================================================================ PAGE 3 — report
const toneOf = (score, max = 100) => { const p = (score / max) * 100; return p >= 75 ? "success" : p >= 50 ? "warning" : "danger"; };
const COLOR = { success: "#16a34a", warning: "#d97706", danger: "#dc2626" };

function renderReport({ report: r, sources }) {
  const c = S.config;
  const m = S.finalMetrics || {};
  const TOPIC = {
    resume: "Resume & Projects", language: LANG_LABEL[S.prefLang] || "Programming Language", oops: "OOPs", dbms: "DBMS",
    os: "Operating Systems", cn: "Computer Networks", software_dev: "Software Development", dsa: "Data Structures & Algorithms",
    sql: "SQL", behavioral: "Behavioural", company_fit: "Company Fit",
  };
  const KIND = { dsa_array: "Array problem", dsa_string: "String problem", sql: "SQL query" };
  const RESULT = { correct: ["Correct", "success"], partially_correct: ["Partially correct", "warning"], incorrect: ["Incorrect", "danger"], not_attempted: ["Not attempted", "neutral"] };
  const verdictTone = /Strong Hire|^Hire/.test(r.verdict) ? "success" : r.verdict === "Lean Hire" ? "warning" : "danger";
  const C = 2 * Math.PI * 56;
  const bar = (score, label, comment) => `
    <div class="bar-row">
      <div class="bar-top"><span>${esc(label)}</span><span style="color:${COLOR[toneOf(score)]}">${score}</span></div>
      <div class="bar"><i data-w="${Math.max(0, Math.min(100, score))}" style="background:${COLOR[toneOf(score)]}"></i></div>
      <p>${esc(comment)}</p>
    </div>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  $("#reportRoot").innerHTML = `
    <div class="card r-hero">
      <div class="ring">
        <svg viewBox="0 0 132 132"><circle class="track" cx="66" cy="66" r="56"/><circle class="val" id="ringVal" cx="66" cy="66" r="56" stroke="${COLOR[toneOf(r.overall_score)]}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
        <div><span><b>${r.overall_score}</b><small>Overall score</small></span></div>
      </div>
      <div>
        <span class="pill pill-${verdictTone}">${esc(r.verdict)}</span>
        <h1>${esc(r.headline)}</h1>
        <div class="r-meta">${esc(c.name)} · ${esc(c.role)} at ${esc(c.company)} · ${c.type === "hr" ? "HR" : "Technical"} interview · ${esc(c.difficulty)} · ${m.minutesUsed ?? "?"} of ${c.duration} min · Interviewer: ${esc(S.interviewer.name)}</div>
        <p>${esc(r.summary)}</p>
      </div>
      <div class="chance">
        <small>Chance of selection</small>
        <b style="color:${COLOR[toneOf(r.selection_probability)]}">${r.selection_probability}%</b>
        <div class="bar"><i data-w="${r.selection_probability}" style="background:${COLOR[toneOf(r.selection_probability)]}"></i></div>
      </div>
    </div>

    <div class="r-grid">
      <div class="card r-sec"><h2>Overall skills</h2>${r.skill_scores.map((s) => bar(s.score, s.skill, s.comment)).join("")}</div>
      <div class="card r-sec">
        <h2>Topics asked in this interview <small>${plural(r.topic_scores.length, "topic")}</small></h2>
        ${r.topic_scores.length ? r.topic_scores.map((t) => bar(t.score, TOPIC[t.topic] || t.topic, t.comment)).join("") : `<p class="muted">The interview ended before any topic was covered.</p>`}
      </div>
    </div>

    ${r.coding_review.length ? `
    <div class="card r-sec">
      <h2>Coding &amp; SQL questions <small>${plural(r.coding_review.length, "question")}</small></h2>
      ${r.coding_review.map((x) => `
        <div class="problem">
          <div class="problem-top"><b>${esc(x.problem)}</b><span class="pill pill-neutral">${KIND[x.kind] || esc(x.kind)}</span><span class="pill pill-${RESULT[x.correctness]?.[1] || "neutral"}">${RESULT[x.correctness]?.[0] || esc(x.correctness)}</span></div>
          ${x.complexity && x.complexity !== "-" ? `<div class="cx">${esc(x.complexity)}</div>` : ""}
          <p>${esc(x.feedback)}</p>
          ${x.better_approach ? `<p class="muted"><b>Better approach:</b> ${esc(x.better_approach)}</p>` : ""}
        </div>`).join("")}
    </div>` : ""}

    <div class="card r-sec">
      <h2>Communication &amp; fluency</h2>
      <div class="stats">
        <div class="stat"><b>${m.wpm ? m.wpm : "—"}</b><small>Words per minute</small></div>
        <div class="stat"><b>${m.totalFillers ?? 0}</b><small>Filler words (${m.fillersPer100Words ?? 0} per 100)</small></div>
        <div class="stat"><b>${m.avgLatencySec != null ? m.avgLatencySec + "s" : "—"}</b><small>Avg. time before answering</small></div>
      </div>
      <div class="notes">
        <p><b>Fluency.</b> ${esc(r.communication_analysis.fluency)}</p>
        <p><b>Filler words.</b> ${esc(r.communication_analysis.filler_words)}</p>
        <p><b>Pace.</b> ${esc(r.communication_analysis.pace)}</p>
        <p><b>Structure.</b> ${esc(r.communication_analysis.structure)}</p>
      </div>
    </div>

    <div class="card r-sec">
      <h2>Question by question <small>${plural(r.question_breakdown.length, "question")}</small></h2>
      ${r.question_breakdown.map((q, i) => `
        <details class="qa" ${i === 0 ? "open" : ""}>
          <summary><span class="qn">Q${i + 1}</span><span class="qt">${esc(q.question)}</span>
            <span class="qs" style="background:var(--${toneOf(q.score, 10)}-soft);color:${COLOR[toneOf(q.score, 10)]}">${q.score}/10</span></summary>
          <div class="qa-body">
            <div><small>Your answer</small>${esc(q.candidate_answer_summary)}</div>
            <div><small>What went well</small>${esc(q.what_went_well)}</div>
            <div><small>What to improve</small>${esc(q.what_to_improve)}</div>
            <div><small>A strong answer</small>${esc(q.ideal_answer)}</div>
          </div>
        </details>`).join("") || `<p class="muted">No questions were answered.</p>`}
    </div>

    <div class="r-grid">
      <div class="card r-sec"><h2>Strengths</h2><ul class="list good">${r.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
      <div class="card r-sec"><h2>Areas to improve</h2><ul class="list bad">${r.improvements.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
    </div>

    <div class="r-grid">
      <div class="card r-sec"><h2>Fit for ${esc(c.company)}</h2><p style="margin:0;color:var(--text-2)">${esc(r.company_fit)}</p></div>
      <div class="card r-sec"><h2>Your next two weeks</h2><ol class="steps">${r.action_plan.map((a) => `<li><b>${esc(a.title)}</b><p>${esc(a.detail)}</p></li>`).join("")}</ol></div>
    </div>

    ${sources?.length ? `<div class="card r-sec"><h2>Sources used to prepare your interview</h2><ul class="sources">${sources.filter((s) => safeUrl(s.url)).slice(0, 20).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a></li>`).join("")}</ul></div>` : ""}`;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    $("#ringVal").style.strokeDashoffset = C * (1 - r.overall_score / 100);
    $$("#reportRoot .bar i").forEach((i) => (i.style.width = i.dataset.w + "%"));
  }));
}
$("#printBtn").addEventListener("click", () => { $$("details.qa").forEach((d) => (d.open = true)); window.print(); });
$("#againBtn").addEventListener("click", () => location.reload());
