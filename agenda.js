// Interview agenda: the server decides WHAT happens next (topic order, follow-ups, when a coding/SQL
// problem goes on screen, when to close). The model only phrases the question, reacts and evaluates.
// This keeps interviews on track even with small/free models, and enforces the time budget.

const LANG_NAMES = { java: "Java", python: "Python", cpp: "C++", c: "C", javascript: "JavaScript", csharp: "C#", go: "Go" };
const TASK_MINUTES = 3; // budget per coding/SQL problem
const CLOSE_MINUTES = 1.2;

export function detectLanguage(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  if (/\bjava\b(?!script)/.test(t)) return "java";
  if (/\bpython\b/.test(t)) return "python";
  if (/c\+\+|\bcpp\b|c plus plus/.test(t)) return "cpp";
  if (/c#|c sharp|\.net/.test(t)) return "csharp";
  if (/javascript|\bjs\b|node/.test(t)) return "javascript";
  if (/\bgolang\b|\bgo\b/.test(t)) return "go";
  if (/\bc\b/.test(t)) return "c";
  return null;
}

const core = (plan, subject) => (plan.core_questions || []).filter((q) => q.subject === subject);

export function buildAgenda(c, plan) {
  const follow = c.difficulty === "hard" ? 3 : 2; // interviewer turns per topic: 1 main + follow-ups
  const steps = [];
  const talk = (key, cat, label, opts = {}) => steps.push({ kind: "talk", key, cat, label, maxTurns: follow, ...opts });
  const task = (key, cat, label, t, type) => t && steps.push({ kind: "task", key, cat, label, task: t, type, required: true });

  talk("intro", "introduction", "Introduction", {
    maxTurns: 1, required: true,
    main: "Greet the candidate by first name, introduce yourself in one sentence (first name and role), then ask them to tell you about themselves.",
    ask: "Could you tell me a little about yourself?",
  });

  if (c.type === "technical") {
    talk("lang_pref", "introduction", "Preferred language", { maxTurns: 1, required: true, main: "Ask which programming language they are most comfortable with.", ask: "Which programming language are you most comfortable with?" });
    const resume = (plan.questions || []).filter((q) => q.category === "resume");
    talk("resume", "resume", "Resume project", { q: resume[0] || { question: "Pick the strongest project on their CV and ask them to walk you through it and their exact contribution.", follow_ups: ["architecture", "a hard problem they solved", "why that tech stack"] } });
    talk("language", "language", "Programming language", { langStep: true });
    talk("oops", "oops", "OOPs", { q: core(plan, "oops")[0] });
    task("dsa_array", "dsa_array", "Array DSA problem", plan.dsa_array, "code");
    talk("dbms", "dbms", "DBMS", { q: core(plan, "dbms")[0] });
    task("sql_1", "sql", "SQL question 1", plan.sql?.[0], "sql");
    talk("os", "os", "Operating Systems", { q: core(plan, "os")[0], optional: true });
    task("dsa_string", "dsa_string", "String DSA problem", plan.dsa_string, "code");
    talk("cn", "cn", "Computer Networks", { q: core(plan, "cn")[0], optional: true });
    task("sql_2", "sql", "SQL question 2", plan.sql?.[1], "sql");
    talk("software_dev", "software_dev", "Software development", { q: core(plan, "software_dev")[0], optional: true });
  } else {
    const qs = (plan.questions || []).filter((q) => !["introduction", "closing"].includes(q.category)).slice(0, 8);
    qs.forEach((q, i) => talk(`hr_${i}`, q.category === "company_fit" ? "company_fit" : "behavioral", q.category, { q, optional: i >= 3 }));
    // Standard HR questions to use the remaining time (skipped automatically when time is short).
    const asked = qs.map((q) => q.question.toLowerCase()).join(" ");
    [
      ["company_fit", "Why should we hire you over other candidates?", ["what makes you different", "evidence from your experience"], /why should we hire/],
      ["behavioral", "Tell me about a time you worked under pressure or a tight deadline. What did you do?", ["what exactly was your role", "what was the result"], /pressure|deadline/],
      ["behavioral", "Where do you see yourself in five years?", ["how does this role help that", "what are you doing now towards it"], /five years|5 years/],
      ["behavioral", "What is one weakness you are actively working on?", ["a concrete example", "what progress have you made"], /weakness/],
      ["hr", "Are you comfortable with relocation and shift timings, and when can you join?", ["any constraints", "notice period"], /relocat|shift|notice/],
    ].forEach(([cat, question, follow_ups, seen], i) => {
      if (!seen.test(asked)) talk(`hr_std_${i}`, cat, cat, { q: { question, follow_ups }, optional: true });
    });
  }
  talk("questions", "candidate_questions", "Candidate's questions", { maxTurns: 1, required: true, main: "Wrap up: ask if they have any questions for you.", ask: "Do you have any questions for me?" });
  talk("close", "closing", "Closing", { maxTurns: 1, required: true, close: true, main: "If they asked something, answer briefly in character. Then thank them and close the interview politely." });
  return steps;
}

function remainingRequiredMinutes(s, fromIndex) {
  return s.agenda.slice(fromIndex).filter((st) => st.kind === "task").length * TASK_MINUTES + CLOSE_MINUTES;
}

function enter(s, i, elapsed) {
  s.ag = { i, turns: 0, phase: 0, approach: 0, enteredAt: elapsed };
}

/** Move to the next step that fits the remaining time. */
function nextStep(s, elapsed, duration) {
  let i = s.ag.i + 1;
  const remaining = duration - elapsed;
  const qIdx = s.agenda.findIndex((st) => st.key === "questions");
  if (remaining <= CLOSE_MINUTES && i < qIdx) i = remaining <= 0.6 ? qIdx + 1 : qIdx;
  while (i < s.agenda.length) {
    const st = s.agenda[i];
    if (st.required) break;
    const spare = remaining - remainingRequiredMinutes(s, i + 1);
    if (spare >= (st.optional ? 2.2 : 1.0)) break; // enough time for this topic (core subjects first)
    i++;
  }
  enter(s, Math.min(i, s.agenda.length - 1), elapsed);
}

export function startAgenda(s) {
  s.agenda = buildAgenda(s.config, s.plan);
  enter(s, 0, 0);
}

/** Called with each candidate answer, before asking the model for the next turn. */
export function onAnswer(s, { answer = "", code = "" }, elapsed, duration) {
  const st = s.agenda[s.ag.i];
  const a = s.ag;
  if (st.key === "lang_pref") s.prefLang ||= detectLanguage(answer);
  if (st.kind === "task") {
    if (code.trim()) {
      if (a.phase <= 1) a.phase = 2; // review the code next
      else if (a.phase === 3) return nextStep(s, elapsed, duration);
    } else if (a.phase === 1) a.approach++;
    else if (a.phase === 3) return nextStep(s, elapsed, duration);
    const overTime = elapsed - a.enteredAt > TASK_MINUTES + 2.5;
    if ((a.phase === 1 && a.approach >= 4) || overTime) return nextStep(s, elapsed, duration);
    return;
  }
  let max = st.maxTurns;
  const spare = duration - elapsed - remainingRequiredMinutes(s, a.i + 1);
  if (spare < 1.2) max = 1; // short on time: no more follow-ups
  if (a.turns >= max) nextStep(s, elapsed, duration);
  else if (duration - elapsed <= CLOSE_MINUTES && !["questions", "close"].includes(st.key)) nextStep(s, elapsed, duration);
}

const fmtTask = (st) =>
  st.type === "sql"
    ? `Problem on the candidate's screen — "${st.task.title}": ${st.task.question}\nTables: ${st.task.schema}`
    : `Problem on the candidate's screen — "${st.task.title}": ${st.task.statement}\nExamples: ${st.task.examples}`;

/** What the model must do this turn, plus what the server puts on screen. */
export function directive(s) {
  const st = s.agenda[s.ag.i];
  const a = s.ag;
  const out = { step: st, cat: st.cat, mode: "voice", attach: null, close: !!st.close };
  const react = a.turns === 0 && s.ag.i > 0 ? "First react to their last answer in a few words (neutral, human). Then " : "";
  let text;
  if (st.kind === "task") {
    out.mode = st.type;
    if (a.phase === 0) {
      out.attach = { [st.type === "sql" ? "sql_task" : "coding_task"]: st.task };
      text = `${react}present this problem: say you've shared it in their code panel, give a one-sentence summary (don't read it all out) and ask them to explain their approach first.`;
    } else if (a.phase === 1) {
      text = a.approach >= 2
        ? "They have discussed the approach enough. Politely ask them to write the code in the panel now and press Submit."
        : "They are explaining their approach. Respond briefly (probe one weak point if there is one) and ask them to write the code in the panel and press Submit.";
    } else {
      text = "They just submitted code (below). Review it honestly like a real interviewer: does it actually solve THIS problem, edge cases, time/space complexity. Say one or two sentences about it, then ask exactly ONE follow-up (complexity, optimisation or an edge case).";
    }
    text += `\n${fmtTask(st)}`;
  } else if (st.close) {
    text = st.main + " Set interview_complete to true.";
  } else if (a.turns === 0) {
    let main = st.main;
    if (!main && st.langStep) {
      const lang = LANG_NAMES[s.prefLang] || "their preferred language";
      const q = (s.plan.core_questions || []).find((x) => x.subject === "language" && (!s.prefLang || (x.language || "").toLowerCase().includes((LANG_NAMES[s.prefLang] || "").toLowerCase())));
      main = q ? `ask this ${lang} question (rephrase naturally): "${q.question}"` : `ask a core ${lang} interview question (internals, memory, collections or exceptions — something real interviewers ask freshers).`;
      st.q = q;
    } else if (!main) {
      main = st.q ? `ask this question (rephrase naturally, keep it short): "${st.q.question}"` : `ask a real ${st.label} interview question suited to a ${s.config.difficulty} fresher interview.`;
    }
    text = react + main.charAt(0).toLowerCase() + main.slice(1);
  } else {
    const ideas = st.q?.follow_ups?.length ? ` Ideas: ${st.q.follow_ups.join(" | ")}.` : "";
    text = `Ask exactly ONE follow-up cross-question that digs deeper into what they just said (why / how it works internally / an edge case / an example from their project). Stay on ${st.label}.${ideas}`;
  }
  out.text = `[STEP — ${st.label}: ${text}]`;
  return out;
}

/** Called after the model has spoken this turn. */
export function afterTurn(s) {
  const st = s.agenda[s.ag.i];
  s.ag.turns++;
  (s.visited ||= new Set()).add(st.key);
  if (st.kind === "task") {
    if (s.ag.phase === 0) s.ag.phase = 1;
    else if (s.ag.phase === 2) s.ag.phase = 3;
  }
}

/** Mandatory keys that have actually been asked (for chips and the report). */
export function coveredKeys(s) {
  const keys = ["dsa_array", "dsa_string", "sql_1", "sql_2", "language", "oops", "dbms", "os", "cn", "software_dev"];
  return new Set([...(s.visited || [])].filter((k) => keys.includes(k)));
}

// ---------------------------------------------------------------- plan validation + fallback problem bank
// Commonly asked fresher-interview problems, used only when research did not produce a usable one.
const BANK = {
  dsa_array: {
    easy: { title: "Second Largest Element", statement: "Given an array of integers, return the second largest distinct element. Return -1 if it does not exist.", examples: "[12, 35, 1, 10, 34, 1] -> 34\n[10, 10, 10] -> -1", constraints: "1 <= n <= 10^5" },
    medium: { title: "Maximum Subarray Sum", statement: "Given an integer array, find the contiguous subarray with the largest sum and return that sum.", examples: "[-2,1,-3,4,-1,2,1,-5,4] -> 6 (subarray [4,-1,2,1])\n[1] -> 1", constraints: "1 <= n <= 10^5, -10^4 <= a[i] <= 10^4" },
    hard: { title: "Trapping Rain Water", statement: "Given n non-negative integers representing an elevation map where each bar has width 1, compute how much water it can trap after raining.", examples: "[0,1,0,2,1,0,1,3,2,1,2,1] -> 6\n[4,2,0,3,2,5] -> 9", constraints: "1 <= n <= 2*10^4" },
  },
  dsa_string: {
    easy: { title: "Valid Palindrome", statement: "Given a string, return true if it is a palindrome after converting to lowercase and removing all non-alphanumeric characters.", examples: "\"A man, a plan, a canal: Panama\" -> true\n\"race a car\" -> false", constraints: "1 <= s.length <= 2*10^5" },
    medium: { title: "Longest Substring Without Repeating Characters", statement: "Given a string s, return the length of the longest substring without repeating characters.", examples: "\"abcabcbb\" -> 3\n\"bbbbb\" -> 1\n\"pwwkew\" -> 3", constraints: "0 <= s.length <= 5*10^4" },
    hard: { title: "Minimum Window Substring", statement: "Given strings s and t, return the smallest substring of s that contains every character of t (including duplicates). Return an empty string if none exists.", examples: "s = \"ADOBECODEBANC\", t = \"ABC\" -> \"BANC\"", constraints: "1 <= s.length, t.length <= 10^5" },
  },
  sql: {
    easy: [
      { title: "Second Highest Salary", schema: "CREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(100), salary INT, dept_id INT);", sample_rows: "(1,'Asha',70000,1) (2,'Ravi',85000,2) (3,'Meera',85000,1) (4,'John',60000,2)", question: "Return the second highest distinct salary (NULL if it does not exist)." },
      { title: "Employees per Department", schema: "CREATE TABLE departments (id INT PRIMARY KEY, name VARCHAR(100));\nCREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(100), dept_id INT);", sample_rows: "departments: (1,'Engineering') (2,'Sales')\nemployees: (1,'Asha',1) (2,'Ravi',1) (3,'Meera',2)", question: "List each department name with its number of employees, including departments with zero employees." },
    ],
    medium: [
      { title: "Top Customers by Spend", schema: "CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(100), city VARCHAR(50));\nCREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, amount DECIMAL(10,2), order_date DATE);", sample_rows: "customers: (1,'Asha','Pune') (2,'Ravi','Delhi')\norders: (10,1,2500,'2026-01-05') (11,2,900,'2026-01-07') (12,1,400,'2026-02-01')", question: "Return the top 3 customers by total order amount, with name and total, highest first." },
      { title: "Highest Salary in Each Department", schema: "CREATE TABLE departments (id INT PRIMARY KEY, name VARCHAR(100));\nCREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(100), salary INT, dept_id INT);", sample_rows: "departments: (1,'Engineering') (2,'Sales')\nemployees: (1,'Asha',90000,1) (2,'Ravi',85000,1) (3,'Meera',70000,2)", question: "For each department, return the department name and the employee(s) with the highest salary." },
    ],
    hard: [
      { title: "Month-over-Month Revenue Growth", schema: "CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, amount DECIMAL(10,2), order_date DATE);", sample_rows: "(1,1,1200,'2026-01-03') (2,2,800,'2026-01-20') (3,1,2500,'2026-02-11') (4,3,600,'2026-03-02')", question: "Return each month, its total revenue, and the percentage change from the previous month." },
      { title: "Users Active 3 Days in a Row", schema: "CREATE TABLE logins (user_id INT, login_date DATE);", sample_rows: "(1,'2026-01-01') (1,'2026-01-02') (1,'2026-01-03') (2,'2026-01-01') (2,'2026-01-03')", question: "Return the user_ids that logged in on at least 3 consecutive days." },
    ],
  },
};

const validTask = (t) => t && typeof t === "object" && t.title && (t.statement || t.question);

/** Make sure a plan has everything the agenda needs; fill gaps from the bank. Returns the list of filled fields. */
export function normalizePlan(plan, c) {
  const filled = [];
  plan.questions = Array.isArray(plan.questions) ? plan.questions.filter((q) => q && q.question) : [];
  plan.core_questions = Array.isArray(plan.core_questions) ? plan.core_questions.filter((q) => q && q.question && q.subject) : [];
  for (const k of ["candidate_summary", "company_insights", "interview_process"]) if (typeof plan[k] !== "string") plan[k] = "";
  for (const k of ["cv_languages", "key_skills", "focus_areas"]) if (!Array.isArray(plan[k])) plan[k] = [];
  if (c.type !== "technical") {
    plan.dsa_array = null;
    plan.dsa_string = null;
    plan.sql = [];
    return filled;
  }
  const lvl = ["easy", "medium", "hard"].includes(c.difficulty) ? c.difficulty : "medium";
  for (const k of ["dsa_array", "dsa_string"]) {
    if (!validTask(plan[k]) || !plan[k].statement) { plan[k] = { ...BANK[k][lvl], source_hint: "commonly asked" }; filled.push(k); }
    plan[k].examples ||= "";
    plan[k].constraints ||= "";
  }
  plan.sql = (Array.isArray(plan.sql) ? plan.sql : []).filter((q) => validTask(q) && q.question && q.schema);
  for (let i = plan.sql.length; i < 2; i++) {
    const b = BANK.sql[lvl].find((x) => !plan.sql.some((q) => q.title === x.title));
    plan.sql.push({ ...b });
    filled.push(`sql_${i + 1}`);
  }
  plan.sql = plan.sql.slice(0, 2);
  for (const q of plan.sql) q.sample_rows ||= "";
  return filled;
}

/** A question to append if the model only reacted and forgot to ask anything this turn. */
export function fallbackQuestion(s, d) {
  const st = d.step;
  if (st.close) return null;
  if (st.kind === "task") return s.ag.phase <= 1 && s.ag.turns <= 1 ? "Could you walk me through your approach first?" : "Could you write the code in the panel and press Submit?";
  if (s.ag.turns === 0) return st.ask || (st.q?.question ?? null);
  return "Can you go a bit deeper on that — how does it actually work?";
}
