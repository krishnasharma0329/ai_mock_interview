# Mock Interviewer — realistic AI mock interviews for students

Three pages:

1. **Setup (MOCK INTERVIEWER).** Step by step: your details → resume + interview type, difficulty and duration → the app checks your resume, researches the company live on the web (real reported interview questions), and checks your camera and mic. Then you press **Join interview**.
2. **Interview (video call).** You see only the AI interviewer (an animated person with live captions), your own camera, and a code panel when a coding or SQL question comes. There is **no submit button for answers**: it listens all the time and responds when you pause, like a real call. The interviewer asks which programming language you're comfortable with and uses it for language questions and code. Each answer gets cross-questioned.
3. **Report.** Scores **only for what was actually asked**: overall score, selection chance, general skills, topic scores (only covered topics), coding/SQL review (only problems you were given), fluency metrics, question-by-question feedback with model answers, and a 2-week plan. You can download it as a PDF.

| Option | Choices |
|---|---|
| Interview type | Technical · HR |
| Difficulty | Easy · Medium · Hard |
| Duration | Technical: 20 / 25 / 30 min · HR: 15 / 20 / 25 min |

Technical rounds always include 1 array problem, 1 string problem and 2 SQL queries. Language, OOPs, DBMS, OS, Computer Networks and Software Development are covered as time allows.

## Setup

Requirements: Node.js 18+ and a **free Groq API key** (https://console.groq.com/keys, no credit card).

```bash
npm install
# open .env and paste your key after GROQ_API_KEY=
npm start
```

Open **http://localhost:3000** in **Chrome or Edge** and allow camera and microphone access.
The terminal prints `✓ Groq API key verified` when the AI is connected. If the key is missing or wrong, the page shows a red banner explaining what to fix.

**Groq free-tier limits:** about 8,000 tokens per minute and 200,000 tokens per day per model. The app rotates between three free models (`openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `openai/gpt-oss-20b`) to stretch this, which is enough for a few full interviews per day. If a limit is hit, the call screen shows "Try again".

If the AI report can't be created (no internet, or the free daily limit is used up), you still get a **basic report** built from the interviewer's live scores, with a button to try the full AI report again. Short network drops are retried automatically.

To use Claude instead, set `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY=` in `.env`.

`npm run mock` is a **demo mode** only for checking the UI: questions are a fixed script, answers are not analysed and no research is done.

## How it works

```
Browser (public/)                         Server (server.js)                    Claude API
──────────────────                        ──────────────────                    ──────────
Setup form + CV upload  ──POST /api/session──▶  stores session, parses CV
Research screen         ◀─NDJSON stream──  /research ── web_search + CV ──▶ claude-opus-5
  (live searches/sources)                    submit_interview_plan tool ◀──
Interview room          ◀─NDJSON stream──  /start, /turn ── streamed reply ──▶ claude-opus-5
  speech-to-text, TTS,                       record_turn tool (scores, mode,
  timer, code editor                         coding/SQL task, coverage)
Report                  ◀──── JSON ──────  /report ── structured output ──▶ claude-opus-5
```

- **Real time:** interviewer replies stream token-by-token, and speech starts at the first finished sentence. Your speech is transcribed live while you talk.
- **Pacing:** every turn tells the interviewer how much time is left and which mandatory topics (the six CS subjects, 2 DSA, 2 SQL) are still pending, so it covers all of them before time runs out.
- **Voice:** recognition uses the browser's Web Speech API. In Chrome this sends audio to Google's speech service. Typing always works too.
- **Shortcuts:** `Ctrl+Enter` submits, `Ctrl+M` toggles the mic, and `Tab` indents in the code editor.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `groq` | `groq` (free) or `claude` |
| `GROQ_API_KEY` | — | Required for Groq |
| `GROQ_MODELS` | `openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b` | Models tried in order |
| `ANTHROPIC_API_KEY` | — | Required for Claude |
| `CLAUDE_MODEL` | `claude-opus-5` | Model for every stage |
| `EFFORT_RESEARCH` / `EFFORT_TURN` / `EFFORT_REPORT` | `medium` / `medium` / `medium` | Thinking effort. Lower `EFFORT_TURN` to `low` for faster but shallower replies |
| `USE_FALLBACKS` | `1` | Server-side refusal fallbacks (`0` turns them off) |
| `PORT` | `3000` | |
| `MOCK_AI` | `0` | `1` = offline scripted mode |

## Files

```
server.js        Express API: sessions, research, interview turns, report (Claude path)
groq.js          Groq provider: web-search research, JSON interview turns, report
prompts.js       Researcher / interviewer / evaluator prompts and JSON schemas
mock.js          Offline scripted mode for UI testing
public/          index.html, styles.css, app.js (no build step)
samples/         sample-cv.txt for a quick test
```

Notes: sessions live in memory, so restarting the server clears them. Each interview makes one research call plus one Claude call per answer, and that usage is billed to your API key.
