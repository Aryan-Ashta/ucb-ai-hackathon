# VibeSchool — Hackathon Build Roadmap
> UC Berkeley AI Hackathon 2026 | June 20–21 | Team: Aryan (backend/ML) + Samuel (fullstack)

---

## Project Summary

**VibeSchool** (also: DiffLingo) is a spaced-repetition developer learning tool that turns merged GitHub PRs into active voice quizzes.

### Core Loop
```
GitHub PR diff
  → Token Company Bear-2 (compress noise)
  → Claude (extract CS concepts + generate roast + quiz question)
  → Redis (SM-2 scheduler — store concept due dates)
  → Deepgram TTS (speak roast + question aloud)
  → Deepgram STT (transcribe spoken answer)
  → Claude (grade answer)
  → Redis (update SM-2 interval)
  → Poke API (schedule 10-min review block on calendar)
  → Browserbase (scrape docs for concept enrichment — bonus)
```

### Mascot
Banana duck (see uploaded reference image). Appears in header, quiz transitions, and roast delivery animations.

---

## Sponsor Integration Map

| Sponsor | Integration Point | Judging Criteria | Priority |
|---|---|---|---|
| Anthropic | Claude Code used throughout build; Claude API for concept extraction, roast generation, answer grading | Built with Claude Code; meaningful domain impact | P0 |
| Token Company | Bear-2 compresses PR diffs before Claude ingestion | Depth + ingenuity | P0 |
| Deepgram | TTS delivers roast+question; STT transcribes spoken answer | Voice essential to experience | P0 |
| Redis | SM-2 scheduler — all interval/ease state lives here | Core infra | P0 |
| Interaction Co (Poke) | Auto-schedules 10-min review block post-quiz | Tool integration depth | P0 |
| Sentry | Error monitoring from day one — wraps all API calls and quiz sessions | Reliability from day one; team execution | P0 |
| Browserbase | Scrapes docs related to extracted concepts to enrich quiz questions | Any agent using the web powered by Browserbase | P1 (add if time) |

---

## Tech Stack

| Layer | Tool |
|---|---|
| Frontend | Next.js 14, React, Tailwind |
| Backend | FastAPI or Next.js API routes |
| Database / Cache | Redis (SM-2 state, pre-cached quiz content) |
| LLM | Claude API (claude-sonnet-4-6) via Anthropic SDK |
| Prompt compression | Token Company Bear-2 API |
| Voice in | Deepgram STT (streaming mic audio) |
| Voice out | Deepgram TTS (pre-cached roast+question text) |
| Calendar | Interaction Co Poke API |
| Web agent | Browserbase (docs enrichment) |
| Error monitoring | Sentry (init on day one) |
| Auth | GitHub OAuth (NextAuth or simple cookie) |
| Deployment | Local processes only — backend on `localhost:8000` (uvicorn), frontend on `localhost:3000` (`bun dev`). Cloudflare tunnel may optionally expose the backend for external demos; no Vercel/Render/cloud-hosted runtime. |

---

## Division of Labor

### Aryan — Backend / ML
- GitHub webhook ingestion and diff parsing
- Token Company Bear-2 integration
- Claude prompt engineering: concept extraction, roast generation, answer grading
- SM-2 algorithm implementation in Redis
- Deepgram STT pipeline
- Browserbase docs enrichment (P1)
- End-to-end integration testing

### Samuel — Fullstack
- Project scaffold and GitHub OAuth
- Sentry instrumentation (from hour one)
- Dashboard UI: PR list, concept cards, due queue
- Deepgram TTS audio playback in browser
- Quiz UI: mic button → transcript display → grade result
- Poke API calendar block confirmation UI
- Mascot animations and visual polish
- Devpost writeup and demo video

---

## Latency Architecture Note

**Critical optimization:** Claude should generate the roast + quiz question text at ingestion time (async, after diff is processed) and cache the result in Redis. When the user triggers a quiz session, TTS fires immediately on pre-cached text — no live Claude call in the hot path.

The only real-time Claude call during a quiz is answer grading, which is fast (short input, short output).

```
INGESTION (async, background):
  diff → Bear-2 → Claude → {concept, roast_text, question_text} → Redis cache

QUIZ SESSION (real-time):
  Redis cache → Deepgram TTS → audio plays
  mic → Deepgram STT → transcript
  transcript → Claude grade → {pass/fail, explanation}
  Redis update SM-2 interval
  Poke API → calendar block
```

---

## Phase 1 — Sat 10 AM to 3 PM
### Goal: End-to-end core loop working, visible in UI

> **This is the critical path. Do not let polish or sponsor exploration eat this window.**
> Checkpoint: diff in → concept + quiz question out, visible in UI. Both must be true before moving on.

### Aryan — Tasks

#### Task A1: GitHub webhook + diff parser
- **What:** Accept GitHub webhook POST for `pull_request` events (merged). Parse the diff payload into per-file, per-hunk chunks. Expose raw diff text as a string.
- **Output:** `parse_diff(payload) → str` function, tested on a real PR
- **Acceptance criteria:** Given a real merged PR webhook payload, returns clean diff text with no binary blobs or whitespace-only hunks
- **Agent notes:** Use `PyGithub` or raw GitHub API. Filter out lock files, generated files, and binary diffs. Keep only `.py`, `.ts`, `.js`, `.go`, `.rs`, `.java`, `.cpp`, `.c` extensions by default.

#### Task A2: Token Company Bear-2 compression
- **What:** Pass raw diff text through Bear-2 API before sending to Claude. Log token count before and after.
- **Output:** `compress_diff(raw_diff: str) → compressed_diff: str` function
- **Acceptance criteria:** Compressed output is semantically coherent (can be read by a human), token count is measurably lower, latency under 100ms
- **Agent notes:** See Bear-2 docs at https://thetokencompany.com/docs. Use the accuracy-preserving mode (not maximum compression) to avoid losing code semantics. Log `{raw_tokens, compressed_tokens, reduction_pct}` to Sentry as a breadcrumb.

#### Task A3: Claude concept extractor
- **What:** Send compressed diff to Claude. Extract CS concepts touched, generate a roast of the code, and produce one quiz question per concept.
- **Output:** `extract_concepts(compressed_diff: str) → List[{concept, roast_text, question_text, answer_hint}]`
- **Acceptance criteria:** Returns 1–5 concepts per PR, each with a roast that references actual code details, a clear quiz question, and an answer hint for grading
- **Agent notes:**
  - Use `claude-sonnet-4-6`
  - System prompt should specify: respond in JSON only, no markdown fences
  - Include in prompt: the compressed diff, instructions to be savage but educational in the roast, and to make the question specific to the actual code (not generic)
  - Example output schema:
    ```json
    [
      {
        "concept": "memoization",
        "roast_text": "You wrote a recursive fib with zero caching. A CS101 student called, they want their homework back.",
        "question_text": "What technique would eliminate the redundant recomputation in this recursive function?",
        "answer_hint": "memoization, caching, dynamic programming, lookup table"
      }
    ]
    ```
  - Store full output in Redis immediately after generation (see Phase 2, Task A4)

---

### Samuel — Tasks

#### Task S1: Project scaffold + GitHub OAuth
- **What:** Initialize Next.js 14 app with TypeScript. Set up GitHub OAuth via NextAuth. Configure env vars for all APIs.
- **Output:** Running app with `/api/auth` working, user can log in with GitHub
- **Acceptance criteria:** Auth flow completes, session contains GitHub access token, repo is structured cleanly
- **Agent notes:** Use `next-auth` with GitHub provider. Required env vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `REDIS_URL`, `SENTRY_DSN`, `TOKEN_COMPANY_API_KEY`, `POKE_API_KEY`

#### Task S2: Sentry instrumentation
- **What:** Initialize Sentry from hour one. Wrap all API route handlers and all outbound API calls.
- **Output:** Sentry dashboard showing real errors and breadcrumbs from the app
- **Acceptance criteria:** A deliberate thrown error in an API route appears in Sentry within 30 seconds. Breadcrumbs include Bear-2 token counts (from Aryan's A2 task).
- **Agent notes:** Use `@sentry/nextjs`. Init in `sentry.client.config.ts` and `sentry.server.config.ts`. Wrap API handlers with `Sentry.withSentry()`. Screenshot the Sentry dashboard for Devpost evidence.

#### Task S3: Dashboard skeleton
- **What:** Build the main dashboard UI showing: list of ingested PRs, concept cards per PR, due queue (concepts due for review today).
- **Output:** `/dashboard` page rendering with mock data
- **Acceptance criteria:** Page renders without errors, concept cards show concept name + roast preview + next review date, due queue shows concepts sorted by urgency
- **Agent notes:** Use Tailwind for styling. Banana duck mascot appears in the header. Concept cards should have a microphone button that will trigger the quiz flow (can be non-functional in this phase). Use mock data shaped like the real API response.

---

## Phase 2 — Sat 3 PM to 7 PM
### Goal: Full voice quiz loop end-to-end

> Checkpoint: Speak answer into mic, get graded, SM-2 interval updates in Redis.

### Aryan — Tasks

#### Task A4: SM-2 scheduler in Redis
- **What:** Implement the SM-2 spaced repetition algorithm. Store concept state in Redis. Pre-cache quiz content (roast + question text) at ingestion time.
- **Output:** `schedule_concept(concept_id, quality: int) → next_review_date`, `get_due_concepts(user_id) → List[concept]`
- **Acceptance criteria:** After a correct answer (quality ≥ 3), interval increases. After wrong answer (quality < 3), interval resets to 1 day. Pre-cached quiz text is accessible by key within 10ms.
- **Agent notes:**
  - Redis key schema:
    ```
    concept:{user_id}:{concept_id}:state    → {ease_factor, interval, repetitions, next_review}
    concept:{user_id}:{concept_id}:quiz     → {roast_text, question_text, answer_hint}
    due:{user_id}                           → sorted set, score = next_review timestamp
    ```
  - SM-2 formula: `new_ef = ef + (0.1 - (5-q)*(0.08 + (5-q)*0.02))`, clamp to minimum 1.3
  - New interval: if repetitions=0 → 1 day, repetitions=1 → 6 days, else → prev_interval * ef
  - Pre-cache quiz content immediately after Task A3 completes

#### Task A5: Deepgram STT pipeline
- **What:** Accept audio stream from browser mic, transcribe via Deepgram STT, return transcript string.
- **Output:** `/api/transcribe` WebSocket or POST endpoint returning `{transcript: str}`
- **Acceptance criteria:** Transcribes a 10–30 second spoken answer accurately. Latency under 2 seconds for a complete sentence.
- **Agent notes:** Use Deepgram's `nova-2` model for best accuracy. For hackathon simplicity, use the REST API (upload audio blob) rather than streaming WebSocket. Accept `audio/webm` from browser MediaRecorder API.

---

### Samuel — Tasks

#### Task S4: Deepgram TTS playback
- **What:** Fetch pre-cached roast + question text from Redis (via backend endpoint), convert to speech via Deepgram TTS, play in browser.
- **Output:** `playQuiz(conceptId)` function that plays roast then question audio sequentially
- **Acceptance criteria:** Audio plays in browser, roast plays first then question, no UI blocking during playback
- **Agent notes:** Use Deepgram TTS REST API. Return audio as `audio/mpeg` blob. Use browser `Audio` API for playback. Show animated banana duck during playback. Chain roast audio → question audio using `audio.onended`.

#### Task S5: Quiz UI + mic button
- **What:** Build the full quiz interaction: start quiz → TTS plays → mic records answer → STT transcript displayed → grade result shown.
- **Output:** `/quiz/[conceptId]` page with full interaction loop
- **Acceptance criteria:** User can complete a full round-trip: hear question, speak answer, see transcript, see pass/fail with explanation. SM-2 update confirmed (next review date changes).
- **Agent notes:**
  - Use browser `MediaRecorder` API to capture mic audio as `audio/webm`
  - Show animated waveform while recording (CSS animation, no library needed)
  - After STT returns transcript, display it and auto-submit to `/api/grade`
  - Grade result shows: pass/fail badge + Claude's explanation + next review date
  - Sentry should capture any mic permission errors

---

## Phase 3 — Sat 7 PM to 1 AM
### Goal: Calendar integration, polish, stress testing

> Feature freeze at 1 AM. Nothing new after this.

### Aryan — Tasks

#### Task A6: Poke API calendar integration
- **What:** After a graded quiz session, call Poke API to schedule a 10-minute review block on the user's calendar.
- **Output:** `/api/schedule-review` endpoint that creates a calendar event via Poke
- **Acceptance criteria:** After completing a quiz, a 10-min calendar event appears titled "VibeSchool: review [concept name]" scheduled at `next_review_date` from SM-2
- **Agent notes:** See Interaction Co Poke API docs. Event should include: title with concept name, description linking back to the quiz, duration 10 minutes, scheduled at the SM-2 next review timestamp. Confirm event creation in Sentry as a breadcrumb.

#### Task A7 (P1 — if time): Browserbase docs enrichment
- **What:** After concept extraction, use Browserbase to scrape the top documentation page for each concept. Append a "further reading" snippet to the quiz question.
- **Output:** `enrich_concept(concept: str) → doc_snippet: str` function
- **Acceptance criteria:** Returns a 1–2 sentence excerpt from an authoritative source (MDN, Python docs, Wikipedia CS) relevant to the concept
- **Agent notes:** Use Browserbase CLI or SDK. Query: `f"site:developer.mozilla.org OR site:docs.python.org {concept}"`. Extract first meaningful paragraph. Store enriched text alongside quiz content in Redis. Must use Browserbase platform per their track criteria.

#### Task A8: End-to-end stress test
- **What:** Run 3+ full cycles of PR ingestion → concept extraction → voice quiz → grade → calendar event. Find and fix any breakage.
- **Checklist:**
  - [ ] Bear-2 compression works on diffs of varying size (small patch vs large refactor)
  - [ ] Redis TTL doesn't expire mid-session (set TTL to 7 days minimum)
  - [ ] Deepgram STT handles ambient noise / mumbled answers gracefully (fallback: show "didn't catch that, try again")
  - [ ] Poke API calendar event created correctly for future dates
  - [ ] Sentry captures at least one real error from testing

---

### Samuel — Tasks

#### Task S6: Mascot + UI polish
- **What:** Integrate banana duck mascot throughout the experience.
- **Checklist:**
  - [ ] Banana duck in header (static)
  - [ ] Banana duck animation during TTS playback (bouncing or talking)
  - [ ] Banana duck reaction on quiz result (happy = correct, disappointed = wrong)
  - [ ] Concept cards show SM-2 progress bar (current interval / 30 days = % mastered)
  - [ ] Due queue sorted and highlighted (overdue items in red)

#### Task S7: Sentry dashboard review
- **What:** Confirm Sentry is capturing real events and breadcrumbs. Prepare screenshot for Devpost.
- **Checklist:**
  - [ ] At least 5 breadcrumbs visible from a single quiz session
  - [ ] Bear-2 token reduction breadcrumb showing before/after token counts
  - [ ] At least one real error captured during stress testing
  - [ ] Screenshot dashboard for Devpost evidence

---

## Phase 4 — Sunday AM
### Goal: Submission + demo prep

> **Devpost draft must exist by midnight Saturday with all teammates added and a project name. This is required to guarantee judging.**
> **Hard submission deadline: 11 AM Sunday.**

### Both — Tasks

#### Task B1: Devpost draft (midnight Sat)
- Create Devpost at https://ai-hackathon-2026.devpost.com
- Add both teammates
- Set project name (VibeSchool or DiffLingo)
- Add placeholder description — this satisfies the rules requirement

#### Task B2: Demo video
- **Flow to show:** PR merged → webhook fires → diff compressed (show token delta) → concepts extracted → voice roast plays → user speaks answer → transcript shown → grade result → calendar event scheduled
- **Each sponsor integration must be visible:** Show Bear-2 token reduction numbers, Sentry dashboard, Redis key readout, Deepgram transcript, Poke calendar event
- **Length:** 2–3 minutes max

#### Task B3: Devpost writeup
- **Required sections:**
  - What it does (2–3 sentences)
  - How we built it (tech stack + architecture diagram)
  - Sponsor integrations (one paragraph per sponsor, specific not generic)
  - Challenges (be honest — judges respect this)
  - What's next

- **Sponsor integration blurbs (draft):**
  - **Anthropic:** Built entirely with Claude Code. Claude API powers concept extraction from compressed PR diffs, generates roasts calibrated to the specific code, and grades spoken answers with nuanced feedback beyond keyword matching.
  - **Token Company:** Bear-2 compresses PR diffs before they hit Claude, reducing token count by [X]% while preserving semantic accuracy. This is the only integration that makes the tool economically viable at scale — large diffs are expensive without compression.
  - **Deepgram:** Voice is not a feature — it is the delivery mechanism. The roast and quiz question are spoken to the developer via Deepgram TTS. Their spoken answer is transcribed via Deepgram STT. Removing voice removes the product.
  - **Redis:** SM-2 state (ease factor, interval, repetitions, next review date) for every concept per user lives in Redis. Pre-cached quiz content eliminates Claude latency from the hot path during quiz sessions.
  - **Interaction Co (Poke):** After every graded quiz, VibeSchool schedules a 10-minute review block at the SM-2 next review date via the Poke API. This closes the loop between learning and doing.
  - **Sentry:** Instrumented from hour one. Every API call, quiz session, and integration failure is captured with breadcrumbs including Bear-2 token reduction stats.
  - **Browserbase (if completed):** Enriches quiz questions with live documentation snippets by scraping authoritative sources via Browserbase, adding real-world context to each concept.

#### Task B4: 4-minute pitch prep
- **Structure:**
  - 0:00–0:30 — The problem (developers merge PRs and immediately forget what they learned)
  - 0:30–1:30 — Live demo (run the full loop)
  - 1:30–2:30 — Technical depth (SM-2 + Bear-2 + voice architecture)
  - 2:30–3:00 — Sponsor integrations (rapid-fire, each named)
  - 3:00–3:30 — Why voice? (the pitch answer: "Developers don't open another tab. The quiz comes to them. The roast makes them pay attention.")
  - 3:30–4:00 — What's next
- **Aryan owns:** Technical architecture section
- **Samuel owns:** Demo walkthrough + UI sections
- **Anticipate:** "Why not just use Anki?" Answer: "Anki requires manual card creation. VibeSchool reads your actual code."

---

## Submission Checklist

- [ ] Devpost draft created before midnight Saturday
- [ ] Both teammates confirmed on Devpost
- [ ] All code pushed to public GitHub repo
- [ ] Demo video uploaded
- [ ] Devpost description complete with all sponsor integrations named
- [ ] Screenshots: Sentry dashboard, Redis key readout, Bear-2 token delta, Poke calendar event, Deepgram transcript
- [ ] Submitted before 11 AM Sunday
- [ ] Both team members physically present at judging table 1–3 PM

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Core loop not working by 3 PM checkpoint | Medium | Critical | Cut all sponsor extras until A1+A2+A3+S1+S2+S3 are done |
| Deepgram STT accuracy poor on ambient noise | Medium | High | Add "retry" button in UI; show transcript for user to confirm before grading |
| Poke API underdocumented / broken | Medium | Medium | Samuel attends Interaction Co workshop Saturday AM |
| Bear-2 strips code semantics | Low | High | Test on real diffs in first 30 minutes; switch to light compression mode if needed |
| Redis state corruption mid-demo | Low | High | Reset Redis key for demo PR before judging; keep a clean demo script |
| Token Company criteria changes | Low | Low | Integration is architectural, not cosmetic — any criteria framing will fit |
| Browserbase (P1) eats too much time | Medium | Low | Hard cut: if not done by midnight, drop it |

---

## Key Links

- Devpost: https://ai-hackathon-2026.devpost.com
- Slack: https://hackberkeley.org/slack
- Live site: https://live.hackberkeley.org
- Token Company docs: https://thetokencompany.com/docs
- Anthropic starter pack: https://www.anthropic.com/learn/build-with-claude
- Deepgram docs: https://developers.deepgram.com
- Browserbase docs: https://docs.browserbase.com
- Interaction Co starter pack: https://docs.google.com/document/d/1AXgdabkuifDE6z76S_1GKgHku7_HHMbAgnvEIaK-11I/edit
- Redis starter pack: https://docs.google.com/presentation/d/114YKGMd4_NY7oaNZ51hiEiyyzH6Q78yMkk8cRUmjmKA
- Sentry starter pack: https://drive.google.com/file/d/13ORcHoZ8242LS4-raV26ImGE59MJ9dnJ/view

---

## Agent Usage Notes

If you are an AI agent using this document:

- Tasks are labelled `A1–A8` (Aryan) and `S1–S7` (Samuel) and `B1–B4` (both)
- Each task has: **What**, **Output**, **Acceptance criteria**, **Agent notes**
- P0 tasks are mandatory. P1 tasks (`A7`) are optional — only attempt if all P0 tasks are complete
- The critical path is: `A1 → A2 → A3 → A4 → A5` on Aryan's side and `S1 → S2 → S3 → S4 → S5` on Samuel's side. These must complete before Phase 3 begins.
- Phase checkpoints are hard gates. Do not proceed to the next phase if the checkpoint is not met.
- When writing code, use `claude-sonnet-4-6` as the model string for any Claude API calls
- All secrets must be read from environment variables — never hardcode API keys
- Sentry must be initialized before any other integration is implemented
