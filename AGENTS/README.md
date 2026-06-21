# AGENTS/ — Agent Plans & Audit History

> **All of these documents are now superseded by the two top-level files:**
>
> - **`ROADMAP.md`** — the consolidated build plan (sponsor integration map, repo structure, demo checklist, risk register, out-of-scope callouts).
> - **`STATUS.md`** — the verified current state of every component (what works, what doesn't, fix list, verification commands, coverage report).
>
> Read those two first. The files below are kept as historical artifacts and reference material — they have not been deleted because the audit trail is valuable.

## What's here

| File | Status | Purpose |
|---|---|---|
| `vibeschool_agent_plan.md` | **Reference / still useful** | The original detailed task-by-task execution plan (A1–A8 backend, S1–S7 frontend, B1–B4 submission). Useful when you want to know what each sponsor integration was *supposed* to do at planning time. Most tasks are now complete — see `STATUS.md` "Implementation Completeness" for the audit. |
| `vibeschool_roadmap.md` | **Superseded** | Original hackathon build plan with phases. Content consolidated into `ROADMAP.md`. |
| `vibeschool_audit_issues.md` | **Superseded** | First-pass audit (June 20 morning). Almost every P0 is now fixed; see `STATUS.md`. |
| `vibeschool_demo_readiness.md` | **Superseded** | "From code-complete to live demo" plan written when the dashboard still used `MOCK_PRS` and the quiz route 404'd. Both issues are now fixed (`STATUS.md`). |
| `vibeschool_redis_followup.md` | **Superseded** | Redis-specific follow-up plan. Tasks P1-2, P1-4, P2-1 are still open; see `STATUS.md` "P2-B1 / P2-B7 / P2-B8". |

## Adding new agent plans

If you write a new agent execution plan, drop it here with the `vibeschool_<topic>.md` naming convention. If it covers work that supersedes something in `ROADMAP.md` or `STATUS.md`, update those two files in the same commit and add a one-line "Superseded by" note at the top of the new doc.

## Past session guides

Operational guides from past sessions live under `.hermes/plans/` (dated `YYYY-MM-DD_HHMMSS-slug.md`). Those are session-by-session; `AGENTS/` is project-wide.

## When in doubt

`ROADMAP.md` = what we're building and why.
`STATUS.md` = what's actually working right now and what's broken.
This file = historical / reference material.
