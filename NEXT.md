# NEXT.md — Post-trace priorities for VibeSchool

> Generated 2026-06-21 from three subagent dataflow traces.
> **Total: 43 issues** (8 HIGH, 20 MEDIUM, 15 LOW) across 23 backend + frontend files.
>
> The detailed fix instructions have been split into **3 parallel agent paths**:
>
> | Path | File | Scope | Est. time | Items |
> |---|---|---|---|---|
> | **1. Quiz** | [`AGENTS/agent_path_1_quiz.md`](./AGENTS/agent_path_1_quiz.md) | Frontend `app/quiz/[id]/` + backend `routers/quiz.py` + `grade_answer` | ~2 hr | 10 fixes |
> | **2. Dashboard + 401** | [`AGENTS/agent_path_2_dashboard.md`](./AGENTS/agent_path_2_dashboard.md) | Frontend `app/dashboard/` + 401 auth flow + `merged_at` round-trip | ~1.5 hr | 10 fixes |
> | **3. Ingestion RAG** | [`AGENTS/agent_path_3_ingestion.md`](./AGENTS/agent_path_3_ingestion.md) | Sync pipeline + vector store + embeddings + RAG batching | ~2 hr | 9 fixes |
>
> Each path file is **self-contained** — it lists the exact files the agent owns, files they must NOT touch, ordered fixes, verification commands, commit conventions, and sign-off criteria. Three agents can work in parallel without conflicts (file boundaries are explicit).

## TL;DR — What's blocking the demo

If we shipped today with zero fixes:

1. **🔴 Calendar demo pillar silently broken.** `/api/schedule-review` works end-to-end but **the frontend never calls it.** → **Path 1, fix 1** (~5 min)
2. **🟡 Roasts won't reliably reference prior concepts.** Per-concept Voyage POSTs + fire-and-forget drift → **Path 3** (~1.5 hr for the HIGH items)
3. **🟡 User stranded on broken dashboard if their GitHub token expires mid-demo.** 401 doesn't sign them out → **Path 2, fix 1** (~10 min)

We can fix #1 + #3 in **~15 minutes total**. Fixing #2 properly is the most work.

---

## Trace sources

- `/tmp/trace_1_ingestion.md` — full ingestion RAG trace (200 lines, 13 issues)
- `/tmp/trace_2_quiz.md` — full quiz hot-path trace (68 lines, 19 issues)
- `/tmp/trace_3_dashboard.md` — full dashboard render trace (101 lines, 11 issues)

---

## Recommended execution order

| Step | Time | What |
|---|---|---|
| **0** | 15 min | Path 1 fix 1 (schedule-review call) + Path 2 fix 1 (401 signout). Two trivial frontend-only edits; unblocks the demo. |
| **1** | parallel | Dispatch all 3 agent paths (Path 1 + Path 2 + Path 3) concurrently. File boundaries prevent conflicts. |
| **2** | +2 hr | Tier B items from each path (RAG batching, IDOR fix, merged_at round-trip, AbortController). |
| **3** | +5 hr | Tier C polish across all paths. |

**Total to demo-ready + RAG-correct: ~2 hours.**
**Total to demo-ready + RAG-correct + all polish: ~5.5 hours.**

---

## What's already solid (per the three traces)

- Per-user Redis sync lock (5-min NX-EX TTL) prevents Claude double-billing.
- Idempotency hash cleanly disambiguates PRs vs commits via `c-` prefix.
- Graceful degradation on every external API (Voyage, Bear-2, Claude, Deepgram, Poke).
- Shared httpx client — proper TCP keep-alive.
- Bulk Redis pipeline (`_load_concept_envelopes_bulk`) collapses 2N round-trips to 1.
- `concept_ids.py` is a single source of truth for the encoder/decoder contract.
- 114 frontend tests + 195 backend tests all green; coverage at 93%.
