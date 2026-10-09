// Basic report built only from data collected during the interview (the interviewer's live per-answer
// scores, the code shown/submitted, and browser delivery metrics). Used when the AI report can't be
// generated (no internet, provider limits), so a finished interview is never lost.

const TOPIC_OF = {
  introduction: "resume", resume: "resume", language: "language", oops: "oops", dbms: "dbms", os: "os", cn: "cn",
  software_dev: "software_dev", dsa_array: "dsa", dsa_string: "dsa", sql: "sql", behavioral: "behavioral", hr: "behavioral",
  company_fit: "company_fit",
};
const TOPIC_NAME = {
  resume: "your projects", language: "programming language", oops: "OOPs", dbms: "DBMS", os: "operating systems",
  cn: "computer networks", software_dev: "software development", dsa: "data structures & algorithms", sql: "SQL",
  behavioral: "behavioural (STAR) answers", company_fit: "company fit",
};
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + "…" : t || "");

export function buildBasicReport(s, m = {}) {
  const tech = s.config.type === "technical";
  const turns = s.turns.filter((t) => t.answer != null && !["closing", "candidate_questions"].includes(t.meta?.category));
  const scored = turns.filter((t) => typeof t.score === "number");
  const overall10 = avg(scored.map((t) => t.score));
  const overall = overall10 == null ? 50 : clamp(overall10 * 10);

  // Topics actually asked, scored from the live per-answer scores.
  const byTopic = {};
  for (const t of turns) {
    const topic = TOPIC_OF[t.meta?.category];
    if (!topic) continue;
    (byTopic[topic] ||= []).push(t);
  }
  const topic_scores = Object.entries(byTopic).map(([topic, ts]) => {
    const sc = avg(ts.filter((t) => typeof t.score === "number").map((t) => t.score));
    return { topic, score: sc == null ? overall : clamp(sc * 10), comment: `Based on ${ts.length} answer${ts.length === 1 ? "" : "s"} during the interview.` };
  });

  // Coding / SQL problems that were shown.
  const coding_review = [];
  s.turns.forEach((t, i) => {
    const task = t.meta?.coding_task || t.meta?.sql_task;
    if (!task) return;
    const kind = t.meta.sql_task ? "sql" : t.meta.category === "dsa_string" ? "dsa_string" : "dsa_array";
    const nextTask = s.turns.findIndex((x, j) => j > i && (x.meta?.coding_task || x.meta?.sql_task));
    const later = s.turns.slice(i, nextTask === -1 ? undefined : nextTask);
    const withCode = later.find((x) => x.code && x.code.trim());
    const reviewScore = withCode ? s.turns[s.turns.indexOf(withCode)]?.score : null;
    const correctness = !withCode ? "not_attempted" : reviewScore == null ? "partially_correct" : reviewScore >= 7 ? "correct" : reviewScore >= 4 ? "partially_correct" : "incorrect";
    coding_review.push({
      problem: task.title, kind, correctness, complexity: "",
      feedback: withCode ? (withCode.feedback || "Code was submitted and reviewed live by the interviewer.") : "No code was submitted for this problem.",
      better_approach: "",
    });
  });

  const fillersRate = Number(m.fillersPer100Words) || 0;
  const avgWords = Number(m.avgWordsPerAnswer) || 0;
  const latency = m.avgLatencySec;
  const fluency = clamp(85 - fillersRate * 4 - (avgWords && avgWords < 12 ? 15 : 0));
  const confidence = clamp(latency == null ? overall : latency < 3 ? 78 : latency < 6 ? 64 : 48);
  const communication = clamp((overall + fluency) / 2 + (avgWords >= 25 ? 5 : avgWords && avgWords < 12 ? -10 : 0));
  const tech10 = avg(turns.filter((t) => typeof t.score === "number" && !["introduction", "behavioral", "hr", "company_fit"].includes(t.meta?.category)).map((t) => t.score));
  const task10 = avg(coding_review.map((c) => ({ correct: 9, partially_correct: 5.5, incorrect: 2.5, not_attempted: 0 })[c.correctness]));
  const estimated = "Estimated from the live interview data.";
  const skill_scores = tech
    ? [
        { skill: "Communication", score: communication, comment: estimated },
        { skill: "Fluency", score: fluency, comment: `${m.totalFillers ?? 0} filler words measured.` },
        { skill: "Confidence", score: confidence, comment: latency != null ? `Average ${latency}s before answering.` : estimated },
        { skill: "Problem Solving", score: clamp((task10 ?? overall10 ?? 5) * 10), comment: estimated },
        { skill: "Technical Knowledge", score: clamp((tech10 ?? overall10 ?? 5) * 10), comment: estimated },
      ]
    : [
        { skill: "Communication", score: communication, comment: estimated },
        { skill: "Fluency", score: fluency, comment: `${m.totalFillers ?? 0} filler words measured.` },
        { skill: "Confidence", score: confidence, comment: latency != null ? `Average ${latency}s before answering.` : estimated },
        { skill: "Behavioural (STAR)", score: overall, comment: estimated },
      ];

  const ranked = [...topic_scores].sort((a, b) => b.score - a.score);
  const strengths = ranked.filter((t) => t.score >= 60).slice(0, 3).map((t) => `Good answers on ${TOPIC_NAME[t.topic] || t.topic} (${t.score}/100).`);
  const weak = ranked.filter((t) => t.score < 60).slice(-3).reverse();
  const improvements = weak.map((t) => `Revise ${TOPIC_NAME[t.topic] || t.topic} (${t.score}/100).`);
  if (fillersRate > 4) improvements.push("Reduce filler words (um, basically, actually) — pause briefly instead.");
  if (avgWords && avgWords < 15) improvements.push("Give fuller answers with an example from your own work.");

  return {
    overall_score: overall,
    selection_probability: clamp(overall - 15),
    verdict: "",
    headline: "Basic report — the detailed AI report could not be generated",
    summary: `This report is built from the scores your interviewer gave during the interview (${scored.length} scored answer${scored.length === 1 ? "" : "s"}). Use "Try full AI report again" for detailed feedback and model answers.`,
    skill_scores,
    topic_scores,
    strengths: strengths.length ? strengths : ["You completed the interview — keep practising to build consistency."],
    improvements: improvements.length ? improvements : ["Generate the full AI report for specific improvement points."],
    question_breakdown: turns.map((t) => ({
      question: t.question,
      candidate_answer_summary: clip(t.answer, 220),
      score: typeof t.score === "number" ? t.score : 5,
      what_went_well: t.feedback || "",
      what_to_improve: "",
      ideal_answer: "Available in the full AI report.",
    })),
    coding_review,
    communication_analysis: {
      fluency: `About ${m.wpm ?? "—"} words per minute.`,
      filler_words: `${m.totalFillers ?? 0} filler words (${fillersRate} per 100 words).`,
      pace: latency != null ? `On average you started answering after ${latency} seconds.` : "",
      structure: avgWords ? `Average answer length: ${avgWords} words.` : "",
    },
    company_fit: "",
    action_plan: weak.map((t) => ({ title: `Practise ${TOPIC_NAME[t.topic] || t.topic}`, detail: "Revise the core concepts and practise explaining them out loud with an example." })),
  };
}
