# VibeSchool — Application Logic Reference
> Single source of truth for how the app works. Read this before writing any code.

---

## What VibeSchool Is

A spaced-repetition learning tool for developers that converts their own merged GitHub PRs into voice quiz sessions. The core insight: developers already know what they just wrote — but they won't remember it in two weeks. VibeSchool closes that gap automatically, without any manual flashcard creation.

The product has two modes:

- **Ingestion mode:** Triggered by a merged PR. Processes the diff into quiz-ready concepts and schedules them.
- **Quiz mode:** Triggered by the user (or a calendar reminder). Delivers a voice quiz on due concepts and reschedules them based on performance.

---

## The Two Pipelines

### Pipeline 1 — Ingestion (runs on merge, async, background)

```
Trigger: GitHub webhook (PR merged)
         ↓
Step 1:  Parse diff → clean text
         ↓
Step 2:  Compress diff → fewer tokens (custom algorithm)
         ↓
Step 3:  Claude extracts concepts → {concept, roast_text, question_text, answer_hint}[]
         ↓
Step 4:  Each concept written to Redis
         - quiz content cached (roast + question + hint)
         - SM-2 state initialized (ef=2.5, interval=1, repetitions=0)
         - concept added to user's due sorted set
         ↓
Step 5:  (P1) Browserbase enriches each concept with a doc snippet
         ↓
Done. User is not notified yet — concepts sit in Redis until they're due.
```

This pipeline is **async and non-blocking**. The webhook returns `202 Accepted` immediately. All processing happens in a background task. If any step fails, Sentry captures it and the rest of the pipeline is unaffected.

### Pipeline 2 — Quiz Session (runs on user demand, real-time)

```
Trigger: User opens /quiz or clicks a concept card
         ↓
Step 1:  Fetch pre-cached quiz content from Redis
         (roast_text, question_text, answer_hint)
         ↓
Step 2:  Deepgram TTS converts roast_text → audio → plays in browser
         ↓
Step 3:  Deepgram TTS converts question_text → audio → plays in browser
         (sequential: roast first, then question)
         ↓
Step 4:  User speaks their answer into mic
         ↓
Step 5:  Deepgram STT transcribes audio → transcript string
         ↓
Step 6:  Claude grades transcript against question + answer_hint
         → {quality: 0-5, passed: bool, explanation: str}
         ↓
Step 7:  SM-2 updates concept state in Redis
         → new {ease_factor, interval, repetitions, next_review}
         ↓
Step 8:  Poke API schedules 10-min calendar block at next_review timestamp
         ↓
Done. User sees grade result + next review date. Concept is rescheduled.
```

This pipeline is **synchronous from the user's perspective**. Steps 1–3 (pre-cached content → TTS) must feel instant. Steps 4–8 (record → grade → schedule) happen after the user speaks and can tolerate up to ~3 seconds of latency.

---

## Why Pre-Caching Matters

The single most important latency decision in the system:

**Claude must not be in the quiz hot path for content generation.**

At ingestion time (Pipeline 1, Step 3), Claude generates the roast and question text and they are written to Redis immediately. When the quiz session starts, TTS fires on the cached text — there is no Claude call. The user hears their roast within ~500ms of clicking "Start Quiz."

The only real-time Claude call is answer grading (Pipeline 2, Step 6), which is fast: short input (transcript + question), short output (quality score + one sentence). This is acceptable latency.

```
WRONG (slow):
  user clicks quiz → Claude generates roast → TTS → user waits 2-4 seconds

RIGHT (fast):
  user clicks quiz → Redis fetch → TTS → user hears roast in <1 second
  user speaks → STT → Claude grades → result shown (~2 seconds)
```

---

## Data Model

### Concept

The atomic unit of the system. One concept per CS idea found in a PR.

```
concept_id:   "{user_id}:{pr_number}:{concept_slug}"
              e.g. "u_123:42:memoization"

concept:      human-readable name       e.g. "memoization"
roast_text:   savage code roast         e.g. "You wrote a recursive fib with zero caching..."
question_text: the quiz question        e.g. "What technique eliminates the redundant recomputation?"
answer_hint:  grading keywords          e.g. "memoization, caching, dynamic programming, lru_cache"
doc_snippet:  (P1) enrichment text      e.g. "Memoization is an optimization technique..."
```

### SM-2 State (per concept per user)

```
ease_factor:  float, min 1.3, starts at 2.5
              How easy this concept is for this user.
              Increases on correct answers, decreases on wrong.

interval:     int (days in production, minutes in demo mode)
              How long until next review.
              Starts at 1, grows multiplicatively with ease_factor.

repetitions:  int
              How many times answered correctly in a row.
              Resets to 0 on any wrong answer.

next_review:  unix timestamp
              When this concept is next due.
```

### SM-2 Transitions

```
On answer with quality q (0–5):

  if q >= 3 (correct):
    repetitions == 0 → new_interval = 1
    repetitions == 1 → new_interval = 6
    repetitions >= 2 → new_interval = floor(interval * ease_factor)
    new_ef = ef + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
    new_ef = max(1.3, new_ef)
    repetitions += 1

  if q < 3 (wrong):
    new_interval = 1
    new_ef = max(1.3, ef - 0.2)
    repetitions = 0

next_review = now + new_interval * seconds_per_unit
```

**Demo mode:** `seconds_per_unit = 60` (1 minute per "day") so the full SM-2 loop is demonstrable during judging. Production: `seconds_per_unit = 86400`.

### Redis Key Schema

```
concept:{user_id}:{concept_id}:quiz
  → JSON { concept, roast_text, question_text, answer_hint, doc_snippet? }
  → TTL: 7 days

concept:{user_id}:{concept_id}:state
  → JSON { ease_factor, interval, repetitions, next_review }
  → TTL: 7 days

due:{user_id}
  → sorted set, member=concept_id, score=next_review_timestamp
  → TTL: 7 days
```

All keys use a 7-day TTL minimum. The due sorted set is queried with `ZRANGEBYSCORE due:{user_id} -inf {now}` to get all concepts due for review.

---

## Compression Algorithm

Sits between the raw diff and Claude. Custom multi-pass implementation — no third-party compression API.

**Input:** Raw unified diff string from GitHub API
**Output:** `(compressed_diff: str, stats: dict)`

### Passes (applied in order)

**Pass 1 — File filter**
Keep only files with extensions: `.py .ts .js .tsx .jsx .go .rs .java .cpp .c .cs`
Drop entirely: lock files, generated files, binary notices, minified files.

**Pass 2 — Context line trimming**
Unified diffs include 3 lines of unchanged context above/below each hunk by default.
Reduce to 1 line. Drop the rest. Changed lines (`+` / `-`) are always kept.

**Pass 3 — Deduplication**
- Identical import statements appearing in multiple files: keep first, replace rest with `# [import deduped]`
- Identical hunks within the same file: keep first, append `# [N identical hunks collapsed]`

**Pass 4 — Identifier shortening**
- Extract all identifiers from `+` lines matching `[a-zA-Z_][a-zA-Z0-9_]{8,}` (long names only)
- Take top 20 by frequency
- Replace with aliases `v0`–`v19` throughout the diff
- Prepend an IDENTIFIER MAP legend to the output:
  ```
  # IDENTIFIER MAP:
  # v0=originalLongVariableName
  # v1=anotherLongIdentifier
  ```
- This legend is included in the Claude prompt so Claude can dereference aliases in roasts/questions

**Pass 5 — Whitespace normalization**
Remove whitespace-only change lines, collapse 3+ consecutive blank lines to 1, strip trailing whitespace.

### Expected reduction targets
- Small diff (<50 lines changed): ≥15% token reduction
- Large diff (10+ files): ≥30% token reduction

Stats dict structure:
```python
{
    "raw_tokens": int,
    "compressed_tokens": int,
    "reduction_pct": float,
    "passes_applied": list[str]
}
```

Stats are logged to Sentry as a breadcrumb on every ingestion.

---

## Claude Prompt Design

### Concept Extraction Prompt

**System:**
```
You are VibeSchool, a savage but educational code reviewer.
Given a GitHub PR diff, you:
1. Identify 1-5 CS concepts or patterns that appear in the diff
2. Write a roast for each — specific, referencing actual code details, funny but educational
3. Write one quiz question per concept testing understanding of that concept
4. Write answer hints (comma-separated keywords a grader would accept as correct)

If an IDENTIFIER MAP is present at the top of the diff, use it to dereference
aliases back to their original names when writing roasts and questions.

Rules:
- Respond ONLY with a valid JSON array. No markdown fences, no preamble.
- Each item: { concept, roast_text, question_text, answer_hint }
- Roasts must reference specific variable names or patterns from the actual diff
- Questions must be specific to the diff, not generic textbook questions
- If the diff is trivial (whitespace/comments/config only), return []
```

**User:** `Extract concepts from this PR diff:\n\n{compressed_diff}`

### Answer Grading Prompt

No system prompt. Single user message:
```
You are grading a developer's spoken quiz answer.

Question: {question_text}
Acceptable answer keywords: {answer_hint}
Student's spoken answer: {transcript}

Grade 0-5 (SM-2 quality):
5: Perfect, clearly understands
4: Correct with minor gaps
3: Correct but hesitant or incomplete
2: Partially correct
1: Attempted but mostly wrong
0: Wrong or no answer

Respond ONLY with valid JSON, no markdown fences:
{"quality": <int>, "passed": <bool>, "explanation": "<one sentence>"}
```

### Prompt Constraints

- Model: `claude-sonnet-4-6` for both calls
- Max tokens: 2048 for extraction, 256 for grading
- JSON only enforcement: system prompt specifies it, post-process strips accidental fences with regex
- Fallback: if JSON parse fails, log to Sentry, return `[]` for extraction or a default fail for grading

---

## API Surface

### Backend endpoints

```
POST /api/webhook/github
  Accepts GitHub PR webhook. Verifies HMAC signature.
  Returns 202 immediately, runs ingestion in background.
  Body: GitHub PR event payload

POST /api/transcribe
  Accepts audio/webm blob from browser MediaRecorder.
  Returns { transcript: str }
  Used in quiz hot path.

POST /api/grade
  Body: { user_id, concept_id, transcript }
  Grades answer, updates SM-2, returns result.
  Returns { passed, quality, explanation, next_review }

POST /api/schedule-review
  Body: { user_id, concept_id, next_review_timestamp, user_calendar_id }
  Creates 10-min Poke calendar event.
  Returns { status: "scheduled", event: {...} }

GET /api/due
  Query: ?user_id=...
  Returns list of concepts due for review.
  Returns { concepts: [...] }

GET /api/quiz/{concept_id}
  Query: ?user_id=...
  Returns pre-cached quiz content from Redis.
  Returns { concept, roast_text, question_text }
  (answer_hint intentionally excluded from this response — grader only)

GET /api/graph
  Query: ?user_id=...
  Returns concept graph data for the force-directed visualization.
  Returns {
    nodes: [{ id, concept, ease_factor, interval, repetitions, next_review, frequency, due: bool }],
    edges: [{ source, target }]
  }
  Nodes derived from all concept state keys in Redis for the user.
  Edges derived from concepts that share the same pr_number in their concept_id.
  (concept_id format: "{user_id}:{pr_number}:{slug}" — parse pr_number to find co-occurrences)
```

### Frontend pages

```
/                   Landing + GitHub OAuth login
/dashboard          Concept graph + due queue (cards to review)
/quiz/[conceptId]   Full quiz interaction page
```

#### Dashboard layout

The dashboard has two primary components:

**1. Concept graph (force-directed)**
A node-link graph showing all CS concepts extracted from the user's PRs and the relationships between them. Nodes are concepts. Edges connect concepts that co-occurred in the same PR or share a semantic relationship (e.g. "memoization" linked to "dynamic programming" linked to "recursion").

Node visual encoding:
- **Size:** proportional to number of times the concept has appeared across PRs
- **Color:** mastery level derived from SM-2 ease_factor
  - Red (ef <= 1.5): struggling
  - Yellow (1.5 < ef <= 2.2): learning
  - Green (ef > 2.2): mastered
- **Pulse animation:** concepts currently due for review pulse gently

Implementation: use D3.js force simulation or `react-force-graph`. Nodes are clickable — clicking a due node navigates to `/quiz/[conceptId]`, clicking a non-due node shows a detail popover (concept name, last reviewed, ease factor, source PR).

**2. Due queue (cards to review)**
A vertical list of concept cards sorted by urgency (most overdue first). Each card shows:
- Concept name
- Source PR number and title
- SM-2 next review timestamp ("due now", "due in 3 min", etc. in demo mode)
- A "Start Quiz" button that navigates to `/quiz/[conceptId]`

Cards are generated from GitHub diffs and the concepts that emerge from them — not manually created. This is the core product promise and should be visible on the dashboard: "Your cards are generated automatically from your merged PRs."

The PR list view is **removed** from the dashboard. The concept graph and due queue together give a complete picture of the user's learning state without needing a separate PR list.

---

## Quiz Session State Machine

The quiz page manages a linear state machine. No branching — always forward.

```
IDLE
  ↓ user clicks "Start Quiz"
LOADING
  ↓ Redis fetch complete
PLAYING_ROAST
  ↓ roast TTS audio ends
PLAYING_QUESTION
  ↓ question TTS audio ends
AWAITING_ANSWER
  ↓ user clicks mic button
RECORDING
  ↓ user clicks mic button again (or auto-stop after 30s)
TRANSCRIBING
  ↓ STT returns transcript
GRADING
  ↓ Claude returns grade
RESULT
  ↓ user clicks "Next" or "Done"
IDLE (next concept) or DONE (no more due concepts)
```

**Error states** (Sentry captures all of these):
- Mic permission denied → show error, stay in AWAITING_ANSWER
- STT returns empty transcript → show "Didn't catch that, try again", return to AWAITING_ANSWER
- Redis miss (concept not found) → show error, redirect to /dashboard
- Claude grading fails → default to quality=0, show generic failure message, still update SM-2

---

## Failure Modes and Fallbacks

| Failure | Behavior |
|---|---|
| Compression algorithm error | Log to Sentry, pass raw diff to Claude (graceful degradation) |
| Claude extraction returns empty `[]` | Skip this PR silently, log to Sentry |
| Claude extraction returns invalid JSON | Retry once, then skip, capture exception in Sentry |
| Redis write fails on ingestion | Capture in Sentry, PR is lost (acceptable for hackathon) |
| Deepgram TTS fails | Show question text on screen as fallback, no audio |
| Deepgram STT returns empty | Prompt user to retry, do not advance state |
| Claude grading fails | Default quality=0 (wrong answer), still update SM-2 |
| Poke API fails | Log to Sentry, still show grade result — calendar block is best-effort |
| Browserbase fails (P1) | Silent fallback, no enrichment snippet, core quiz unaffected |

---

## What Claude Code Is Used For

The Anthropic track requires the project to be **built with Claude Code** (the CLI tool), not just the Claude API. This means:

- Claude Code is the primary coding agent used to implement backend services
- Every A-task in the agent plan is implemented via Claude Code running in the terminal
- Claude Code also handles test generation, debugging, and refactoring throughout the build
- The Claude API (separate from Claude Code) is used at runtime for concept extraction and answer grading

These are two distinct uses of Anthropic products and both should be called out explicitly in the Devpost writeup.

---

## Demo Script (for judging, 1–3 PM Sunday)

Run this exact flow — have it set up and ready before judges arrive.

1. Show the dashboard with one pre-loaded PR already ingested (do this the night before with a real merged PR from your own repo)
2. Show the due queue with at least one concept marked as due
3. Click into the quiz — roast plays immediately (confirm pre-cache is working)
4. Speak a correct answer clearly
5. Show the transcript, grade result, and "next review in X minutes" confirmation
6. Show the Poke calendar event appearing in the connected calendar
7. Open Sentry dashboard in another tab — show the breadcrumbs from the session including compression stats
8. Open Redis CLI: `KEYS concept:*` — show the keys populated from ingestion

**Reset procedure before judges arrive:**
```bash
# Clear demo user's state and re-ingest a clean PR
redis-cli DEL due:{demo_user_id}
redis-cli KEYS "concept:{demo_user_id}:*" | xargs redis-cli DEL
# Then POST a real PR webhook payload to re-trigger ingestion
```

---

## Out of Scope (do not build)

- User-created flashcards (cards come from PRs only)
- Multiple GitHub repos per user (one repo for the demo)
- Push notifications (Poke calendar block is the only reminder mechanism)
- Mobile app
- Collaborative/team features
- Any authentication beyond GitHub OAuth
