import { REQUIRED_KEYS } from "./prompts.js";

// Offline mock (MOCK_AI=1): lets you click through the whole UI without an API key.
// Nothing here is real research — it only exercises the flow.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARRAY_TASK = {
  title: "Two Sum",
  statement: "Given an array of integers nums and an integer target, return the indices of the two numbers that add up to target. Each input has exactly one solution and you may not use the same element twice.",
  examples: "nums = [2,7,11,15], target = 9  →  [0,1]\nnums = [3,2,4], target = 6  →  [1,2]",
  constraints: "2 ≤ nums.length ≤ 10^4",
};
const STRING_TASK = {
  title: "Longest Substring Without Repeating Characters",
  statement: "Given a string s, find the length of the longest substring without repeating characters.",
  examples: 's = "abcabcbb"  →  3\ns = "bbbbb"  →  1',
  constraints: "0 ≤ s.length ≤ 5·10^4",
};
const SQL_1 = {
  title: "Top customers",
  schema: "CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(100));\nCREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, amount DECIMAL(10,2), created_at DATE);",
  sample_rows: "customers: (1,'Asha') (2,'Ravi')\norders: (10,1,250.00,'2025-01-02') (11,2,90.00,'2025-01-03')",
  question: "Return the top 3 customers by total order amount, with their total.",
};
const SQL_2 = {
  title: "Second highest salary",
  schema: "CREATE TABLE employees (id INT PRIMARY KEY, name VARCHAR(100), salary INT, dept_id INT);",
  sample_rows: "(1,'A',100) (2,'B',200) (3,'C',300)",
  question: "Find the second highest distinct salary. Return NULL if it doesn't exist.",
};

function scriptFor(s) {
  const c = s.config;
  const first = s.interviewer.name.split(" ")[0];
  const base = { coding_task: null, sql_task: null, is_cross_question: false, covered_mandatory: [], interview_complete: false, last_answer_score: 6, last_answer_note: "mock", preferred_language: null };
  const cov = [];
  const step = (text, meta, add) => {
    if (add) cov.push(add);
    return [text, { ...base, response_mode: "voice", ...meta, covered_mandatory: [...cov] }];
  };
  const x = { is_cross_question: true };
  if (c.type === "hr") {
    return [
      step(`Hi ${c.name}, I'm ${first} from the HR team at ${c.company}. Thanks for joining. So, tell me a little about yourself.`, { category: "introduction", last_answer_score: null }),
      step(`Okay. Why do you want to join ${c.company} specifically?`, { category: "company_fit" }),
      step("Mm-hm. Tell me about a time you had a disagreement with a teammate. What happened?", { category: "behavioral" }),
      step("And what exactly did you do to resolve it? What was the outcome?", { category: "behavioral", ...x }),
      step("Okay. Are you comfortable relocating, and what is your notice period?", { category: "hr" }),
      step("Alright, that's all from my side. Thank you for your time, we'll get back to you soon.", { category: "closing", interview_complete: true }),
    ];
  }
  return [
    step(`Hi ${c.name}, I'm ${first}, ${s.interviewer.title} here at ${c.company}. Thanks for joining. To start, tell me a little about yourself.`, { category: "introduction", last_answer_score: null }),
    step("Okay. Which programming language are you most comfortable with?", { category: "language" }),
    step("Alright, Java then. Tell me about one project on your resume. What was your exact contribution?", { category: "resume", preferred_language: "java" }),
    step("Hmm, okay. Why did you choose that database and not something else?", { category: "resume", ...x }),
    step("Okay. In Java, why are strings immutable?", { category: "language" }),
    step("Right. So what happens in the string pool when you write new String of a literal?", { category: "language", ...x }, "language"),
    step("Okay. What's the difference between an abstract class and an interface?", { category: "oops" }),
    step("And where did you actually use polymorphism in your project?", { category: "oops", ...x }, "oops"),
    step("Alright, I've shared a problem in the code panel. Explain your approach first, then write the code and submit it.", { category: "dsa_array", response_mode: "code", coding_task: ARRAY_TASK }),
    step("Okay. What's the time and space complexity of this? Can you do better?", { category: "dsa_array", response_mode: "code", ...x }, "dsa_array"),
    step("Let's talk databases. What is normalization, and when would you denormalize?", { category: "dbms" }, "dbms"),
    step("Okay, here's a SQL question in the panel.", { category: "sql", response_mode: "sql", sql_task: SQL_1 }),
    step("Let me ask something on operating systems. What's the difference between a process and a thread?", { category: "os" }, "sql_1"),
    step("Mm-hm. And what are the conditions for a deadlock?", { category: "os", ...x }, "os"),
    step("Okay, next problem is in the panel, a string one.", { category: "dsa_string", response_mode: "code", coding_task: STRING_TASK }),
    step("One more SQL query.", { category: "sql", response_mode: "sql", sql_task: SQL_2 }, "dsa_string"),
    step("Okay. That's all from my side. Do you have any questions for me?", { category: "candidate_questions" }, "sql_2"),
    step("Good question. Thanks for your time today, we'll get back to you soon.", { category: "closing", interview_complete: true }),
  ];
}

export async function research(s, send) {
  const c = s.config;
  send({ type: "status", text: `[MOCK] Reading CV and researching ${c.company}…` });
  for (const q of [`${c.company} ${c.role} interview questions 2026`, `${c.company} interview experience ${c.role} glassdoor`, `${c.company} leadership principles values`]) {
    await sleep(500);
    send({ type: "search", query: q });
    await sleep(300);
    const src = { title: `Google search: ${q}`, url: "https://www.google.com/search?q=" + encodeURIComponent(q) };
    s.sources.push(src);
    send({ type: "source", ...src });
  }
  s.plan = {
    candidate_summary: "[MOCK] Final-year CS student with web development projects.",
    key_skills: ["JavaScript", "React", "SQL", "Python"],
    core_questions: [],
    cv_languages: ["Java", "Python"],
    company_insights: `[MOCK] Placeholder insights — run without MOCK_AI to get real web research on ${c.company}.`,
    interview_process: "[MOCK] Online assessment → 2 technical rounds → HR.",
    focus_areas: ["DSA", "Projects", "DBMS"],
    questions: [{ category: "introduction", question: "Walk me through your background.", why_asked: "Warm-up", source_hint: "mock", time_min: 3, expected_points: [] }],
    dsa_array: c.type === "technical" ? { ...ARRAY_TASK, source_hint: "mock" } : null,
    dsa_string: c.type === "technical" ? { ...STRING_TASK, source_hint: "mock" } : null,
    sql: c.type === "technical" ? [SQL_1, SQL_2] : [],
  };
  send({ type: "plan", plan: s.plan, sources: s.sources, interviewer: s.interviewer });
}

export async function turn(s, answer, send) {
  const script = scriptFor(s);
  s.mockIndex = answer == null ? 0 : Math.min((s.mockIndex ?? 0) + 1, script.length - 1);
  const [text, meta] = script[s.mockIndex];
  for (const word of text.split(/(?<= )/)) {
    await sleep(35);
    send({ type: "delta", text: word });
  }
  for (const k of meta.covered_mandatory) s.covered.add(k);
  s.turns.push({ question: text, meta, answer: null });
  const pending = s.config.type === "technical" ? REQUIRED_KEYS.filter((k) => !s.covered.has(k)) : [];
  send({ type: "meta", meta, covered: [...s.covered], pending, elapsedMin: (Date.now() - s.startedAt) / 60000 });
}

export function report(s, metrics) {
  const tech = s.config.type === "technical";
  const general = tech ? ["Communication", "Fluency", "Confidence", "Problem Solving", "Technical Knowledge"] : ["Communication", "Fluency", "Confidence", "Behavioural (STAR)", "Culture Fit", "Professionalism"];
  const allTopics = ["resume", "language", "oops", "dbms", "os", "cn", "software_dev", "dsa", "sql", "behavioral", "company_fit"];
  const answered = s.turns.filter((t) => t.answer != null && t.meta.category !== "closing");
  return {
    overall_score: 64,
    selection_probability: 48,
    verdict: "Lean Hire",
    headline: "[DEMO] Good basics, but answers need more depth and structure.",
    summary: "[DEMO] This is sample output from demo mode. Run with an ANTHROPIC_API_KEY for a real evaluation of your answers.",
    skill_scores: general.map((skill, i) => ({ skill, score: 52 + ((i * 9) % 35), comment: "Sample comment." })),
    // The server drops any topic that wasn't actually asked.
    topic_scores: allTopics.map((topic, i) => ({ topic, score: 50 + ((i * 7) % 40), comment: "Sample comment." })),
    strengths: ["Clear introduction", "Knew the basics of hashing"],
    improvements: ["Explain the approach before coding", "Give examples from your own project"],
    question_breakdown: answered.map((t) => ({ question: t.question, candidate_answer_summary: (t.answer || "").slice(0, 120), score: 6, what_went_well: "Sample.", what_to_improve: "Sample.", ideal_answer: "Sample model answer." })),
    coding_review: [
      { problem: "Two Sum", kind: "dsa_array", correctness: "correct", complexity: "O(n) time, O(n) space", feedback: "Sample.", better_approach: "Single-pass hash map." },
      { problem: "Longest Substring Without Repeating Characters", kind: "dsa_string", correctness: "partially_correct", complexity: "O(n^2)", feedback: "Sample.", better_approach: "Sliding window with a set." },
      { problem: "Top customers", kind: "sql", correctness: "correct", complexity: "-", feedback: "Sample.", better_approach: "JOIN + GROUP BY + ORDER BY + LIMIT." },
      { problem: "Second highest salary", kind: "sql", correctness: "incorrect", complexity: "-", feedback: "Sample.", better_approach: "MAX with a subquery or DENSE_RANK." },
    ],
    communication_analysis: { fluency: `Sample. Measured ${metrics.wpm ?? "-"} words per minute.`, filler_words: `Sample. ${metrics.totalFillers ?? 0} filler words.`, pace: "Sample.", structure: "Sample." },
    company_fit: "Sample.",
    action_plan: [{ title: "Practise explaining approach first", detail: "Sample detail." }, { title: "Revise sliding-window problems", detail: "Sample detail." }],
  };
}
