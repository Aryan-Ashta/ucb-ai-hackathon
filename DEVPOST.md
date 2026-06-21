# BananaDuck: Spaced-Repetition for the Code You Actually Merged

### One-liner
BananaDuck turns your merged GitHub PRs into punchy, roast-heavy voice quizzes to lock in the CS concepts you already paid to learn by writing.

---

### The Problem: Your Code Graveyard
Every developer has a graveyard: that repository you shipped in 2024 and can't explain in 2025. You wrote the diff, you read the PR review, you merged it—and then six months later, you can't defend the architectural choices during a system design interview. 

Tutorials don't fix this. They teach you generic concepts. They don't teach *your* concepts—the ones you implemented and then immediately forgot. Spaced-repetition apps like Anki are great for vocab, but code flashcards are usually just homework. There's no callback to the real work you did.

### The Solution: BananaDuck
BananaDuck (formerly VibeSchool) watches your merged PRs, extracts the high-leverage CS concepts hiding in your diffs, roasts your implementation to make it memorable, and quizzes you out loud on a real SM-2 schedule.

**Voice is the delivery mechanism, not a feature.** Speaking forces you to articulate, not just skim. It’s the difference between "I kinda remember that" and "I can defend this."

---

### Sponsor Tracks & Tech Stack

#### 🛰 Sentry — High-Precision Telemetry Mapping
Instrumented from Hour One. We don't just log errors; we map the entire ingestion and quiz telemetry pipeline.
- **Breadcrumb Narrative:** Every Bear-2 compression, Claude extraction, and SM-2 update fires a structured breadcrumb. In a Sentry session, you can watch a PR get compressed, parsed, and scheduled in one timeline.
- **Failed Quiz Telemetry:** We capture "failed" quiz attempts (quality < 3) as handled exceptions with the user's transcript and the answer hint as context, allowing us to see exactly where our "roasts" are too obscure or where the user's mental model is breaking.
- **Production-Ready:** Using `sentry-sdk` on the FastAPI backend and `@sentry/nextjs` on the frontend across three runtimes (client, server, edge).

#### 🐻 The Token Company — 75% Semantic Compression via Bear-2
GitHub PR diffs are brutal on context windows. A 400-line change with lockfile churn can push 25k tokens before you even give an LLM room to think.
- **The Pipeline:** We run every diff through `bear-2` before it hits Claude.
- **The Result:** We consistently achieve **30–60% token reduction** (and up to 75% on churn-heavy diffs) while preserving 100% of the code identifiers and syntactic structure.
- **Ingenuity:** We use a heuristic pre-counter to track exactly how many tokens Bear-2 saves us, emitting this delta directly to Sentry. If Bear-2 is down, the system gracefully falls back to the raw diff—zero-blocking architecture.

#### 🛠 The Toolbox — Engineering-Led Spaced-Repetition
BananaDuck isn't a "learning app"—it's a developer tool designed for the engineering workflow.
- **The "Roast" Engine:** We don't just ask questions. We use Claude to roast your actual variable names and logic. If you used a `dict` where a `dataclass` belonged, BananaDuck will call it out before asking you why.
- **SM-2 Scheduler:** A industrial-grade implementation of the SuperMemo-2 algorithm in Redis. We use ZSETs to manage the due-queue, ensuring sub-10ms p50 latency for the quiz hot path.
- **Poke Integration:** On a successful quiz, BananaDuck automatically schedules a 10-minute "Review" block on your real calendar via the Poke API, closing the loop between "learning" and "doing."

---

### How We Built It
- **Backend:** FastAPI (Python 3.14) + Redis Cloud. 93% test coverage with `pytest` and `fakeredis`.
- **Frontend:** Next.js 14 App Router + Tailwind (Dark/Marigold).
- **Intelligence:** Claude-3.5-Sonnet (via TokenRouter) for extraction and grading. 
- **Voice:** Deepgram Nova-2 for real-time transcription of spoken answers.
- **Persistence:** Redis as a single source of truth for SM-2 state, encrypted OAuth tokens (Fernet), and the concept cache.

### Challenges & Lessons
- **Context is King:** The hardest part wasn't the AI—it was the diff parsing. GitHub diffs are noisy. Using Bear-2 was the only way to make the concept extraction affordable and accurate.
- **Latency Architecture:** We moved the expensive Claude extraction to the *ingestion* phase. The quiz itself is a lightning-fast Redis read.
- **Mascot Debates:** We spent 2 hours arguing over whether a banana-shaped duck (the mascot) should be an SVG or a Web Component. We chose to ship the code first.

### What's Next
- **Deepgram TTS:** Reading the roasts aloud in a snarky British accent.
- **Browserbase Enrichment:** Automatically scraping documentation for the concepts you're struggling with.
- **Team Workspaces:** Roasting your coworkers' PRs so the whole team learns from every merge.
