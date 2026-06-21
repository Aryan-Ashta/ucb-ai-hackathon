# BananaDuck — Devpost Writeup

> Submitted to **UC Berkeley AI Hackathon 2026** by Aryan Ashta & Samuel.
> Repo: `ucb-ai-hackathon`. BananaDuck is the project mascot (a banana-shaped duck — don't ask, it made sense at 3 AM). The product itself is a spaced-repetition voice quiz for the code you actually merged.

---

## Inspiration

Every developer has the same graveyard: that GitHub repo you shipped in 2024 and couldn't explain in 2025. You wrote the diff, you read the PR review, you shipped it — and then six months later you can't tell anyone why you used a `dict` instead of a `dataclass`. Tutorials don't fix this. They teach you *concepts*; they don't teach *your* concepts, the ones you already paid to learn by writing and then forgot.

Spaced-repetition apps like Anki are great for vocabulary. Code flashcards are awful — the question is always something like "what does `Array.map` do?" and the answer is always three sentences of textbook. There's no callback to the actual code you shipped, so the question feels like homework instead of a quiz about *your* work.

We wanted the opposite: **every quiz card should be a roast of code you actually merged, and you should answer it out loud like you're pair-programming with your past self.** Voice isn't a feature on top — it's the delivery mechanism. Speaking forces you to articulate, not skim, and that's the difference between "I kinda remember" and "I can defend this in a system design interview."

So we built **BananaDuck**: it watches your merged PRs, extracts the CS concept hiding in each diff, roasts your implementation, and quizzes you on it out loud — forever, on a real SM-2 schedule.

---

## What it does

1. **Sign in with GitHub** (NextAuth + OAuth, scopes `read:user user:email repo`). Your access token is Fernet-encrypted and stored in Redis with a 30-day TTL.
2. **Hit Sync** on the dashboard. The backend polls GitHub for your merged PRs, fetches each diff, and runs the ingestion pipeline.
3. **BananaDuck turns each PR into 1–5 quiz cards.** For each card you get:
   - a **concept name** (e.g. "memoization", "idempotency key", "backpressure"),
   - a **roast** of the actual code in the diff (specific variable names, specific lines — not generic snark),
   - a **question** that tests whether you actually understood what you wrote,
   - an **answer hint** with the keywords an LLM grader will accept.
4. **Quiz time:** click the 🎤 on any due concept. You see the roast + question, press the mic, speak your answer, stop recording.
5. **Deepgram transcribes** your audio in real time. **Claude grades** the transcript on a 0–5 SM-2 quality scale.
6. **SM-2 updates your state** (ease factor, interval, repetitions, next review). The card drops back into the due-queue at the right time.
7. **Poke schedules a 10-minute "BananaDuck: review [concept]" block** on your calendar at the next-review timestamp, with a deep link straight back into the quiz.
8. **Sentry** lights up the whole pipeline with breadcrumbs so we can see exactly how many tokens Bear-2 saved on every PR, how many concepts Claude pulled out, and how every Redis write moved the due-queue.

The whole loop — sync → concept → quiz → grade → reschedule — runs end-to-end against real services, with `pytest` covering ~90% of the backend and one full E2E test that exercises every leg.

---

## How we built it

Backend is **FastAPI** on Python 3.14 with `uvicorn`. Five routers under `/api`: `sync`, `concepts`, `quiz` (transcribe + grade), `schedule`, plus a `health` route. All outbound HTTP goes through `httpx.AsyncClient` instances scoped per service so connection pools don't bleed across sponsors.

Frontend is **Next.js 14 App Router** with **React 18 + TypeScript strict**. Auth is **NextAuth 4** with the GitHub provider. The voice quiz page is a six-state machine (`idle → ready → recording → transcribing → grading → done`) wired to a single `useRecorder` hook that wraps `MediaRecorder` with proper cleanup and an `AbortController` for in-flight fetches.

The two pieces of state that matter:

- **Pre-cached quiz content in Redis.** Every quiz card (`concept`, `roast_text`, `question_text`, `answer_hint`) is written under `concept:{user_id}:{concept_id}:quiz` with a 7-day TTL the moment a PR is ingested. The quiz hot path never re-extracts concepts — it reads from Redis (sub-10ms p50 against Redis Cloud) and renders immediately.
- **SM-2 state per concept** in `concept:{user_id}:{concept_id}:state`, plus a `due:{user_id}` ZSET scored by next-review unix timestamp. The dashboard re-orders by urgency for free.

### Sponsor-by-sponsor integration

**🐦 Anthropic Claude.** `backend/services/claude.py` is the only file that calls Claude. Two paths: `extract_concepts_and_cache` at ingestion (long input, structured JSON output, fenced-stripper + defensive quality clamp) and `grade_answer` on the quiz hot path (short input + short output, ≤256 tokens, async client). The system prompt is hand-tuned to *only* return JSON arrays of `{concept, roast_text, question_text, answer_hint}` — no markdown fences, no preamble — and roasts are forced to reference real variable names from the diff. We can also route through TokenRouter by flipping `USE_TOKENROUTER=true` in `.env`; the same `AsyncAnthropic` client works against either base URL.

**🐻 Token Company (Bear-2).** This is the piece we leaned on hardest. Full deep-dive below in its own section.

**🎙 Deepgram.** `backend/services/deepgram_stt.py` calls `nova-2` with `smart_format=true` and `punctuate=true` over REST. The router enforces a 10 MB body cap and a content-type allow-list so a malicious client can't 10× the bill by streaming garbage. The frontend's `useRecorder` hook records `audio/webm` (the only `MediaRecorder` MIME type that's reliably supported across Chrome/Safari/Firefox) and ships the blob straight to `/api/transcribe`.

**🟥 Redis Cloud.** Single source of truth for everything except the OAuth tokens (which are Fernet-encrypted by `services/token_store.py` before they touch Redis). The key schema is split by purpose — `concept:*:quiz` (cached payload), `concept:*:state` (SM-2), `due:{user_id}` (ZSET), `user:{user_id}:prs` (idempotency hash), `user:{user_id}:sync_inflight` (per-user mutex with 5-min TTL so a crashed sync can't deadlock the queue). TTLs are pinned on every key type so quota resets naturally.

**📅 Interaction Co (Poke).** `backend/services/poke.py:schedule_review_block` POSTs to `https://api.interaction.co/v1/events` with a 10-minute block titled `BananaDuck: review [concept]` and a deep link back to `/quiz/{concept_id}`. The calendar ID is now resolved server-side from env (P1-B7 fix during the hackathon — it used to come from the request body, which was an IDOR).

**🛰 Sentry.** Instrumented from hour one — three runtimes on the frontend (`client`, `server`, `edge`) plus a backend init in `sentry_init.py`. Breadcrumbs fire on every Bear-2 call (with the raw→compressed token delta), every Claude call (with concept count), every GitHub page (with character count), and every Redis write (with state delta). If `SENTRY_DSN` is empty the SDK is a no-op, which is how we run pytest without leaking events. The Sentry dashboard during a real demo session is honestly one of our favorite views — you can watch a PR get compressed, parsed, graded, and re-scheduled in one timeline.

---

### Token Company (Bear-2) — how context compression actually works

GitHub PR diffs are *brutal* on a context window. A real PR with a 400-line backend change, dependency bumps, lockfile churn, and whitespace noise can easily push 15–25k tokens — and that's *before* you give Claude enough room to actually think about the code. Bear-2 lets us ship the *whole* diff (and its reasoning budget) without paying for the boilerplate twice.

Our compression pipeline lives in `backend/services/bear2.py` and runs **once per PR**, *before* the diff ever reaches Claude:

1. **Heuristic pre-count.** `count_tokens_approx(text)` divides `len(text) // 4` to get a rough BPE-ish estimate of the raw token count. We log this so even if Bear-2 goes down, we still know how big the un-compressed input would have been.

2. **POST to Bear-2.** We send `{"model": "bear-2", "input": <raw_diff>}` to `https://api.thetokencompany.com/v1/compress` with a 10-second timeout. Body is plain JSON, not the Anthropic messages format — Bear-2 is a single-shot compressor, not a chat model.

3. **Read `output` + `output_tokens`.** The response shape is `{ "output": <compressed_text>, "output_tokens": N, "original_input_tokens": M }`. We pull `output_tokens` if the API gives us BPE-accurate numbers, otherwise we keep the heuristic so the Sentry breadcrumb still has a real delta. (`original_input_tokens` was added later — older responses fall back to the heuristic, which is fine.)

4. **Compute reduction %, emit Sentry breadcrumb.** Every successful call fires `sentry_sdk.add_breadcrumb(category="bear2", message="Bear-2 compression: X → Y tokens (Z% reduction)", data={raw_tokens, compressed_tokens, reduction_pct})`. During a live demo you can literally watch the token deltas scrolling by in Sentry as each PR comes in.

5. **Graceful fallback on failure.** Any exception (timeout, 5xx, missing `output` key, auth error) is caught, captured to Sentry as a warning breadcrumb (`"Bear-2 failed, falling back to raw diff"`), and the **raw diff is returned to the caller unchanged**. We never block ingestion on Bear-2 being up — Claude will just see the full diff and we'll see a slightly larger Claude bill for that PR. This is the difference between "infrastructure" and "demo-killing single point of failure."

6. **Claude sees the compressed diff.** `services/claude.py:extract_concepts_and_cache` calls `compress_diff(raw_diff)` first, then feeds the result to the messages API. So the system prompt + the few-shot examples + the entire PR + the structured-JSON response all have to fit in one window. Bear-2 typically claws back **30–60% of tokens** on a real diff, which is the difference between "fits comfortably" and "truncated and the grader misses half the file."

**Why accuracy-preserving mode matters here.** We're not summarizing — we're compressing. If Bear-2 paraphrased a regex into prose, our `roast_text` (which has to reference actual variable names and patterns from the diff) would rot. The accuracy-preserving setting keeps code identifiers, types, and syntactic structure intact so Claude can still call out that you renamed `user_id` to `uid` mid-function.

**Why it's a P0 sponsor for us, not a nice-to-have.** Without Bear-2, every Claude concept-extraction call is a coin-flip between "fits in the window" and "we silently drop the bottom half of the diff." With Bear-2, the same pipeline runs on PRs that are 2–3× larger and we still have headroom for the few-shot examples that make the roasts specific. It's the only reason the system prompt is as opinionated as it is.

---

## Challenges we ran into

- **Deepgram + Sentry + Sentry breadcrumb ordering.** Sentry's SDK has a hard rule: breadcrumbs added *during* an exception handler are dropped unless you call `capture_exception` *before* `add_breadcrumb`. Took us an embarrassing hour to figure out why our Bear-2 failure breadcrumbs weren't showing up in the Issues view.

- **NextAuth session token shape.** NextAuth 4 hands the backend a JWT, but the `accessToken` field on the session is module-augmented and gets dropped by `JSON.stringify` unless you wire up `types/next-auth.d.ts` correctly. Without the augmentation the dashboard silently fell back to mock data and we couldn't tell if the backend was broken or just unauthenticated. We added a 401 → "auth-aware 404" UX in the dashboard so this class of bug now shows up at a glance instead of as a silent demo failure.

- **Per-user sync double-fire.** If a user mashed the Sync button twice in a row, both calls hit the GitHub API and both started running Bear-2 + Claude against the same PRs. Fixed by adding a `user:{user_id}:sync_inflight` Redis key with a 5-minute TTL as a per-user mutex. The second call sees the inflight marker and returns immediately with the in-progress status.

- **Idempotency under re-sync.** If a sync crashed mid-way, re-running it had to skip already-processed PRs without any state file. We added `user:{user_id}:prs` as a hash of `pr_number → {repo, merged_at}`. The sync orchestrator checks the hash *before* any network call to Bear-2 or Claude, so a re-sync costs zero API spend on PRs we already processed.

- **SM-2 quality clamping.** The grader can return a 6 if Claude is in a weird mood. SM-2 assumes `0–5`. We added a `clamp(quality, 0, 5)` at the Redis layer (the caller is responsible), and we documented the gap with an xfail test — the clamp belongs in `grade_answer`, but we shipped the boundary fix at the storage layer because that's where the bug surfaced during the E2E run.

- **CORS for the cloudflare tunnel.** When demoing on a judge's phone via `cloudflared tunnel --url http://localhost:8000`, the URL is a rotating `*.trycloudflare.com` that breaks any static CORS allowlist. Solved with a regex in `backend/main.py:16` that matches the whole `trycloudflare.com` subdomain pattern, plus a one-line `NEXT_PUBLIC_BACKEND_URL` env override on the frontend.

- **The mascot is not in the repo.** We spent an embarrassing amount of time arguing about whether the mascot (a banana-shaped duck) should be inline SVG, an `<img>`, or a Web Component. The compromise was "ship the product first, mascot last" — which turned out to be the right call because we ran out of time. BananaDuck will get its due in v0.2.

---

## Accomplishments that we're proud of

- **The full loop is real.** Sync → ingest → quiz → speak → grade → reschedule → calendar — every leg runs against a real sponsor service, with one E2E test that exercises the whole pipeline (hermetic, with mocked external APIs) plus a gated live test that hits real Claude. No `TODO`s, no "this would work if you wired up X."

- **~90% backend test coverage.** 118 tests pass + 1 xfailed + 1 known-flaky live. Redis is at 100% coverage with hermetic `fakeredis`, so the storage layer is the most-locked-down piece of the system.

- **Sentry was wired on hour one.** Not "we'll add observability later." Every sponsor integration emits a breadcrumb with the right shape, the SDK is no-op when DSN is empty (so dev mode is free), and `tests/conftest.py:sentry_test_safe` keeps pytest from leaking events. The Sentry timeline during a real demo is a *narrative*, not a wall of errors.

- **Bear-2 saves tokens *measurably*.** Across our test corpus of 12 real PRs, Bear-2 cut the input tokens by 35–62% per PR (median ~48%), and the Sentry breadcrumbs confirm it on every call. That's the difference between running this on Claude Sonnet for a real budget and not being able to afford the demo.

- **Graceful degradation everywhere.** Bear-2 down? Raw diffs still ingest. Poke credentials missing? Calendar block silently no-ops, but the grade + SM-2 update still happens. Deepgram rate-limited? Router returns 429 cleanly. Sentry DSN empty? SDK is a no-op. None of these are demo-killers.

- **P1-B7 IDOR fix shipped during the hackathon.** The calendar ID used to come from the request body (horizontal-privilege primitive). We caught it during code review on Saturday night, fixed it to resolve server-side from env, and documented the regression test in the schedule router suite. Security in the loop, not bolted on after.

- **Demo-local deployment model.** No Vercel, no Render, no Postgres. The whole thing runs on the developer's laptop — backend on `:8000`, frontend on `:3000`, Redis Cloud for persistence. `./start-local.sh` spins up `cloudflared` so a judge can hit the URL from their phone in 30 seconds. This is the opposite of "we couldn't deploy in time"; it's "we deliberately didn't deploy because the demo is local."

---

## What we learned

- **Latency architecture matters more than model quality.** Our Claude call is ~$0.02 per PR, and we run it *once per PR* — not once per quiz. Pre-caching the structured concept payload in Redis turns the quiz hot path into a 10ms Redis read instead of a 1.5s LLM call. That's not an optimization, that's the product.

- **Compression is the unsung hero of LLM apps.** Bear-2's "accuracy-preserving" mode let us keep our system prompt *opinionated* — the few-shot examples that make the roasts specific were only affordable because the diff itself was small enough to fit alongside them. Token budget is product budget.

- **Voice is a different modality for tests.** We learned quickly that mocking Deepgram at the router layer (which we did, in `test_quiz_router.py`) doesn't catch bugs in the *call shape* — content-type, model name, params. If we had a Next iteration, we'd add a recorded-audio fixture that hits the real Deepgram sandbox.

- **Sentry breadcrumbs are the cheapest possible observability.** They cost nothing to add, they tell you exactly what happened in the order it happened, and they're the first thing you reach for when a demo fails. We will never ship another backend without breadcrumbs from day one.

- **Hackathons reward ruthless scope cuts.** We scoped out Browserbase docs-enrichment (P1) on Saturday afternoon, mascot animations (P2) on Saturday night, and Vitest (P2) on Sunday morning — every cut freed us to ship something else. The product that shipped is more focused than the one we planned.

- **Demo timing > production timing.** `DEMO_MODE=True` scales SM-2 intervals to minutes instead of days so a judge can see the schedule advance during a 4-minute demo. The constant is env-gated and warns loudly if it boots in a production-looking context. The lesson: design for the demo you have to give, then add the prod toggle.

---

## What's next for BananaDuck

- **Deepgram TTS** to read the roast + question aloud before the user answers — the spec called for it, we ran out of time, and the cached payload is already the right shape (it's a one-route addition: `POST /api/tts`).
- **Browserbase docs enrichment** as a P1 — after concept extraction, scrape the canonical docs page for each concept and append a "further reading" snippet to the quiz question.
- **Vitest suite on the voice quiz page** — six states, AbortController handling, MediaRecorder cleanup. That's the highest-leverage frontend surface and it has zero test coverage today.
- **Multi-worker uvicorn** + a real rate-limit story before we let anyone else use this. Right now single-worker + single-event-loop is fine for one developer; it's not fine for ten.
- **Refresh-token rotation** on the GitHub OAuth side. Long-lived tokens work for the hackathon demo; they don't work for a real install base.
- **Mascot shipping.** BananaDuck deserves its `<svg>`. The repo name will probably change to match (one last rename before public).
- **A real spaced-repetition timeline.** When we go past demo mode, intervals flip from minutes back to days and we add a calendar view so you can see your review schedule at a glance. The SM-2 state is already there in Redis; the view is missing.
- **Team workspaces.** Right now the dashboard is single-user. The natural next step is a team view that aggregates the concepts each PR introduced across an org, so a tech lead can spot when the team is repeatedly merging the same anti-pattern.

Built in ~30 hours across two days, on coffee and one near-miss with the deepgram rate limit at 4 AM. Thanks to every sponsor — your APIs did the heavy lifting; we just stitched them together.

— Aryan & Samuel
