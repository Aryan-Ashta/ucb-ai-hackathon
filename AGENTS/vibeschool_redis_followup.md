# VibeSchool — Redis Audit Follow-up Plan

> **For Hermes:** This is the execution plan for closing the remaining open gaps
> from `AGENTS/vibeschool_audit_issues.md` and the gap analysis in
> `AGENTS/vibeschool_redis_gap_analysis.md` (TODO: link to the research subagent's
> report once it's checked in). Tasks are ordered P0 → P1 → P2. Each task has a
> file:line ref, a copy-pasteable patch, a verification command, and a time
> estimate. Do not skip the order — P0 fixes are prerequisites for P1 work in
> some cases (e.g. the 404 wrap needs to land before we can remove the
> `ValueError` contract test that depends on the raise).

> **Scope:** `backend/` only. The frontend is intentionally out of scope (see
> "Out of scope" at the bottom). All changes are hermetic except for a single
> optional live-Redis smoke check in `scripts/check_redis.py`.

> **Snapshot:** 2026-06-20. Baseline: 92 passed, 1 xfailed
> (`test_update_sm2_state_quality_clamps_via_caller` documents a real bug; the
> xfail will turn green automatically when the fix lands).

---

## 0. What is already done (2026-06-20)

Just landed via subagent — no need to redo:

- **19 new hermetic tests** covering the documented-but-untested Redis behaviors:
  - 12 in `backend/tests/test_redis.py` (lines 214–397)
  - 7 in `backend/tests/test_sm2.py` (lines 40–139)
- **Verified full backend suite:** 92 passed, 1 xfailed, 1 warning.
- **1 real bug surfaced and pinned:** `update_sm2_state` does not clamp
  `quality` to `[0, 5]` before forwarding to `sm2_next`. See `P1-3` below.
- **Test coverage uplift:** TTL is now asserted on every key type
  (`user:{user_id}:prs`, `user:{user_id}:last_sync`, `user:{user_id}:repos`,
  `due:{user_id}`, `user:{user_id}:sync_inflight`). `get_due_concepts`
  ordering by urgency is now pinned. SM-2 boundaries at `q=2` / `q=3` are
  now tested. The `DEMO_MODE` 60-second delta is now pinned.

**No production code was modified in this pass.** All changes are tests.

---

## 1. Recommended execution order

```
P0-1  Wrap update_sm2_state in HTTPException(404)   ~5 min
P1-1  SINGLETON comment on _redis                   ~1 min
P1-2  Pipeline mark_pr_processed (atomicity)        ~5 min
P1-3  Clamp quality in update_sm2_state             ~3 min
P1-4  Pipeline add_user_repo (atomicity)            ~5 min
P1-5  Sentry breadcrumb for orphan in due set       ~5 min
P2-1  Pipeline get_due_concepts (N+1 perf)          ~15 min
P2-2  Env-driven DEMO_MODE                          ~5 min
P2-3  Concept_id schema comment                     ~1 min
P2-4  10ms hot-path latency assertion               ~10 min
───── gate: pytest + scripts/check_redis.py ─────
total: ~55 min
```

P0-1 must land first because it changes a router contract that one of the
existing tests (`test_update_sm2_state_missing_concept_raises`) currently pins
on a `ValueError`. After the wrap, that test stays green (it asserts the
service layer still raises) but the router now converts to 404.

---

## 2. P0 — Block the demo from working

### P0-1. Wrap `update_sm2_state` in `HTTPException(404)` at the router

- **Severity:** P0 (user-visible 500 mid-quiz on a missing concept)
- **Doc says:** "use HTTPException(404) (but keep the underlying ValueError as
  the cause)" (STATUS.md:262, P2-B8).
- **Code today:** `backend/services/redis_client.py:149` raises a bare
  `ValueError`. `backend/routers/quiz.py:62` and `backend/routers/schedule.py`
  call `update_sm2_state` without a try/except — FastAPI converts the
  `ValueError` to a 500. A user whose `:state` key has TTL'd out mid-quiz sees
  an ugly 500 instead of a clean 404.
- **What's missing:** A 2-line `try/except HTTPException(404, ...)` around
  the call.
- **Time:** ~5 min (two call sites, ~3 lines each).
- **Patch (apply to both call sites):**

  **`backend/routers/quiz.py`** (around line 62, inside the `grade` handler):
  ```python
  from fastapi import HTTPException  # already imported; verify at top of file

  try:
      next_review = await update_sm2_state(
          user["id"], req.concept_id, result["quality"]
      )
  except ValueError as e:
      raise HTTPException(status_code=404, detail=str(e)) from e
  ```

  **`backend/routers/schedule.py`** (around the call to `update_sm2_state`):
  ```python
  try:
      next_review = await update_sm2_state(
          user["id"], req.concept_id, req.quality
      )
  except ValueError as e:
      raise HTTPException(status_code=404, detail=str(e)) from e
  ```

  (If `schedule.py` doesn't call `update_sm2_state`, skip it — the audit only
  flagged the quiz path. Re-read `schedule.py` to confirm before patching.)

- **Verify:**
  ```bash
  .venv/bin/pytest backend/tests/test_redis.py -v -k "missing_concept"
  # expected: test_update_sm2_state_missing_concept_raises still passes
  # (the test asserts the service layer raises ValueError; the router
  # now wraps it. Different layer, different contract.)

  .venv/bin/pytest backend/tests/test_quiz_router.py -v
  .venv/bin/pytest backend/tests/test_schedule_router.py -v
  # expected: all pass; the 404 wrapper is exercised by the router tests

  # Manual check: with the backend running, POST /api/grade with a fake
  # concept_id. Expected: HTTP 404, not 500.
  ```

- **Side effects:** None. The service layer still raises; the router
  converts. The existing `test_update_sm2_state_missing_concept_raises` test
  pins the service-layer raise and stays green.

---

## 3. P1 — Deprecations & fragile bits

### P1-1. SINGLETON comment on `_redis` (audit P1-3, minimal)

- **Severity:** P1 (audit issue still open, but very low impact under the
  current single-worker / single-event-loop deployment)
- **Doc says:** "'SINGLETON: safe only because we run one event loop per
  process; revisit before scaling workers' — option (b) is the minimum bar"
  (audit_issues.md:194).
- **Code today:** `backend/services/redis_client.py:20` declares
  `_redis: aioredis.Redis | None = None` with no comment. `get_redis()`
  (`redis_client.py:39-57`) lazy-initializes and reuses.
- **What's missing:** A 3–4 line comment explaining the invariant.
- **Time:** ~1 min.
- **Patch:** insert directly above `backend/services/redis_client.py:20`
  (i.e. above the `_redis: aioredis.Redis | None = None` line):
  ```python
  # SINGLETON (intentional): one Redis client per process, shared across
  # the event loop. Safe today because uvicorn runs with --workers 1 and
  # pytest installs fakeredis via conftest. If you scale to --workers 2+,
  # give each worker its own connection (pool size stays per-worker, not
  # per-cluster). Consider a WeakKeyDictionary keyed on
  # asyncio.get_running_loop() if you start running multiple event loops
  # in the same process (e.g. jupyter, background workers, separate
  # sub-apps). See audit_issues.md P1-3.
  ```

- **Verify:**
  ```bash
  grep -n "SINGLETON (intentional)" backend/services/redis_client.py
  # expected: one match on or before line 25

  .venv/bin/pytest backend/tests/test_redis.py::test_get_redis_returns_same_instance -v
  # expected: 1 passed
  ```

- **Alternative (not recommended for the hackathon):** swap to
  `WeakKeyDictionary[asyncio.AbstractEventLoop, aioredis.Redis]`. Adds
  ~15 lines and a multi-loop test. Defer to post-hackathon.

### P1-2. Pipeline `mark_pr_processed` (atomicity)

- **Severity:** P1 (silent leak risk — key can live forever if `expire` fails)
- **Doc says:** Implicit requirement from "every Redis write must include
  `ex=REDIS_TTL_SECONDS`" (PLAN.md:227) and from the style of
  `cache_quiz_content` / `update_sm2_state` which DO pipeline.
- **Code today:** `backend/services/redis_client.py:177-178`:
  ```python
  await r.hset(key, str(pr_number), json.dumps({...}))
  await r.expire(key, REDIS_TTL_SECONDS)
  ```
  Two separate round-trips. If the second fails, the hash has no TTL.
- **What's missing:** A single `MULTI/EXEC` for the two-call write.
- **Time:** ~5 min.
- **Patch:** replace the two lines with:
  ```python
  pipe = r.pipeline()
  pipe.hset(key, str(pr_number), json.dumps({"repo": repo, "merged_at": merged_at}))
  pipe.expire(key, REDIS_TTL_SECONDS)
  await pipe.execute()
  ```

- **Verify:**
  ```bash
  .venv/bin/pytest backend/tests/test_redis.py -v
  # expected: 29 passed, 1 xfailed (no behavior change, just atomicity)

  # Live smoke: optional
  .venv/bin/python -m backend.scripts.check_redis
  ```

### P1-3. Clamp `quality` to `[0, 5]` inside `update_sm2_state`

- **Severity:** P1 (real bug, surfaced by the new xfailed test)
- **Doc says:** "quality: 0-5 (from Claude grader)" (redis_client.py:141
  docstring). Defense-in-depth: caller is `routers/quiz.py`, which clamps in
  `claude.py:156`, but the redis client is now the public boundary.
- **Code today:** `backend/services/redis_client.py:138-170`:
  ```python
  async def update_sm2_state(user_id: str, concept_id: str, quality: int) -> int:
      ...
      state = json.loads(state_data)
      new_state = sm2_next(state, quality)
  ```
  No clamp. `sm2_next` (`backend/services/sm2.py:24`) uses `if quality >= 3:`
  and `max(1.3, ...)` — a `quality=99` would silently take the q>=3 branch
  and produce a huge ease-factor bump that's clamped to 1.3 by the floor.
  No exception, but the resulting state is nonsense.
- **What's missing:** A 1-line clamp at the boundary.
- **Time:** ~3 min.
- **Patch:** insert at the top of `update_sm2_state` (just after the
  docstring, before the `r = await get_redis()` call):
  ```python
  quality = max(0, min(5, int(quality)))  # defensive clamp
  ```

- **Verify:**
  ```bash
  .venv/bin/pytest backend/tests/test_redis.py::test_update_sm2_state_quality_clamps_via_caller -v
  # expected: PASSED (no longer XFAIL)
  # the strict=False xfail becomes a real regression guard

  .venv/bin/pytest backend/tests/test_redis.py -v
  # expected: 30 passed, 0 xfailed
  ```

- **Note:** the `claude.py:156` clamp can stay — the new redis-client clamp
  is defense in depth, not a replacement.

### P1-4. Pipeline `add_user_repo` (atomicity)

- **Severity:** P1 (same risk profile as P1-2)
- **Doc says:** Same as P1-2.
- **Code today:** `backend/services/redis_client.py:218-219`:
  ```python
  await r.sadd(f"user:{user_id}:repos", repo_full_name)
  await r.expire(f"user:{user_id}:repos", REDIS_TTL_SECONDS)
  ```
  Two round-trips. If the second fails, the set has no TTL.
- **What's missing:** A pipeline.
- **Time:** ~5 min.
- **Patch:** replace the two lines with:
  ```python
  repos_key = f"user:{user_id}:repos"
  pipe = r.pipeline()
  pipe.sadd(repos_key, repo_full_name)
  pipe.expire(repos_key, REDIS_TTL_SECONDS)
  await pipe.execute()
  ```

- **Verify:** Same as P1-2.

### P1-5. Sentry breadcrumb for orphan in due set

- **Severity:** P1 (silent skip hides a real TTL race)
- **Doc says:** Implicit expectation: `get_due_concepts` returns "all
  concepts due for review" (redis_client.py:104-105 docstring). Today it
  silently drops concepts whose `:quiz`/`:state` keys have TTL'd out.
- **Code today:** `backend/services/redis_client.py:117-118`:
  ```python
  if quiz_data and state_data:
      result.append({...})
  ```
  No log, no Sentry breadcrumb. The new test
  `test_orphan_in_due_set_is_silently_skipped` pins this behavior.
- **What's missing:** A Sentry breadcrumb at warn level (fail loud) and an
  optional `ZREM` to clean up the orphan.
- **Time:** ~5 min.
- **Patch:** replace the if-block with:
  ```python
  if quiz_data and state_data:
      result.append({...})
  else:
      sentry_sdk.add_breadcrumb(
          category="redis",
          message=(
              f"Orphan in due set: {concept_id} "
              f"(quiz={bool(quiz_data)}, state={bool(state_data)})"
          ),
          level="warning",
      )
      # Optional: clean up the orphan so the next due-queue read is clean.
      # await r.zrem(due_key, concept_id)
  ```

- **Decision required:** Should we also `ZREM` the orphan?
  - **Yes** (recommended for the hackathon): keep the due set clean, but
    add the breadcrumb first so the event is captured before the removal.
  - **No** (paranoid): keep the orphan so a human can investigate; only
    add the breadcrumb.
  - **Pick "Yes" if you trust the TTL race; pick "No" if you want a paper
    trail.** The patch above defaults to breadcrumb-only; uncomment the
    `ZREM` to switch.

- **Verify:**
  ```bash
  .venv/bin/pytest backend/tests/test_redis.py::test_orphan_in_due_set_is_silently_skipped -v
  # expected: still passes — the breadcrumb doesn't change return value
  ```

---

## 4. P2 — Cleanup, alignment, docs drift

### P2-1. Pipeline `get_due_concepts` (N+1 perf, STATUS P2-B1)

- **Severity:** P2 (STATUS.md flagged, not user-visible at hackathon scale)
- **Doc says:** "get_due_concepts is N+1: zrangebyscore + 2N r.get calls.
  30 due concepts = 61 round-trips. Pipeline." (STATUS.md:256)
- **Code today:** `backend/services/redis_client.py:104-127` — one
  `zrangebyscore`, then a Python for-loop with 2 awaits per concept.
- **What's missing:** A single pipeline that batches all 2N GETs.
- **Time:** ~15 min.
- **Patch:** replace the for-loop body (lines 113-125) with:
  ```python
  if not due_concept_ids:
      return result

  pipe = r.pipeline()
  for concept_id in due_concept_ids:
      pipe.get(f"concept:{user_id}:{concept_id}:quiz")
      pipe.get(f"concept:{user_id}:{concept_id}:state")
  flat = await pipe.execute()

  # Orphan detection: a None in either slot means the TTL race fired.
  for i, concept_id in enumerate(due_concept_ids):
      quiz_data = flat[2 * i]
      state_data = flat[2 * i + 1]
      if quiz_data and state_data:
          result.append(
              {
                  "concept_id": concept_id,
                  **json.loads(quiz_data),
                  "state": json.loads(state_data),
              }
          )
      else:
          sentry_sdk.add_breadcrumb(
              category="redis",
              message=(
                  f"Orphan in due set: {concept_id} "
                  f"(quiz={bool(quiz_data)}, state={bool(state_data)})"
              ),
              level="warning",
          )
  ```

  Note: this also subsumes P1-5. Apply P1-5 first if you want a separate
  commit; otherwise, do P2-1 and skip the duplicate P1-5 patch.

- **Verify:**
  ```bash
  .venv/bin/pytest backend/tests/test_redis.py -v
  # expected: 30 passed, 0 xfailed, behavior unchanged
  ```

  Optional perf check (manual):
  ```python
  # Seed 30 due concepts, time get_due_concepts before and after
  import time
  # ... before: ~30ms
  # ... after:  ~1ms
  ```

### P2-2. Env-driven `DEMO_MODE` (audit P2-4)

- **Severity:** P2 (audit issue, low probability of accidental prod deploy)
- **Doc says:** "If the deploy accidentally runs with DEMO_MODE = True, every
  user gets a 'review in 60 s' notification … There is no env override"
  (audit_issues.md:287-303). Fix: read `VIBESCHOOL_DEMO_MODE` env, default
  `True`. PLAN.md:160 demands the literal constant for the acceptance
  criterion — keep both.
- **Code today:** `backend/services/sm2.py:6` is a bare
  `DEMO_MODE = True`.
- **What's missing:** Env override + warning on startup outside dev.
- **Time:** ~5 min.
- **Patch:** replace `backend/services/sm2.py:6` with:
  ```python
  import os
  import warnings

  DEMO_MODE = os.environ.get("VIBESCHOOL_DEMO_MODE", "true").lower() in (
      "1", "true", "yes"
  )

  if DEMO_MODE and os.environ.get("VIBESCHOOL_ENV", "development") != "development":
      warnings.warn(
          "DEMO_MODE is on outside the development environment — "
          "spaced-repetition intervals will be ~60 seconds, not ~1 day. "
          "Set VIBESCHOOL_DEMO_MODE=false to disable.",
          RuntimeWarning,
      )
  ```

- **Verify:**
  ```bash
  .venv/bin/pytest backend/tests/test_sm2.py::test_sm2_demo_mode_uses_minutes -v
  # expected: passes (default DEMO_MODE is True)

  VIBESCHOOL_DEMO_MODE=false .venv/bin/python -c \
    "from backend.services.sm2 import sm2_next; \
     print(sm2_next({'ease_factor':2.5,'interval':1,'repetitions':0,'next_review':0}, 5)['next_review'] - __import__('time').time())"
  # expected: ~86400 (1 day), not ~60 (1 minute)

  VIBESCHOOL_DEMO_MODE=false VIBESCHOOL_ENV=production .venv/bin/python -c \
    "import warnings; warnings.simplefilter('error'); \
     from backend.services import sm2" 2>&1
  # expected: no warning fires because DEMO_MODE is off
  ```

- **Note:** The new test
  `test_sm2_demo_mode_uses_minutes` pins the default behavior (60s). It will
  pass with or without this patch as long as the env is unset. To make the
  test strict, add a fixture that monkey-patches `DEMO_MODE` — but that's
  P3 scope; skip for the hackathon.

### P2-3. Concept_id schema comment (informational)

- **Severity:** P3 (informational; no functional change)
- **Doc says:** "concept_id" format `{user_id}:{pr_number}:{slug}`
  (models.py:8). Stored key becomes `concept:{user_id}:{user_id}:{pr}:{slug}`
  because `concept_id` already includes the user_id.
- **Code today:** No comment explaining the duplication.
- **What's missing:** A 3-line note above the key-schema block in
  `backend/services/redis_client.py:60-63`.
- **Time:** ~1 min.
- **Patch:** add directly above `backend/services/redis_client.py:60`
  (above the `# ── Key schema ──` line):
  ```python
  # Note: concept_id already includes user_id (see models.QuizConcept), so
  # the full key is concept:{user_id}:{user_id}:{pr}:{slug}:{...}. The
  # user_id prefix is the user-scoping primitive; the suffix is purely
  # an identifier. Don't try to "fix" the duplication — both segments
  # are load-bearing.
  ```

- **Verify:**
  ```bash
  grep -n "concept_id already includes user_id" backend/services/redis_client.py
  # expected: one match
  ```

### P2-4. 10ms hot-path latency assertion (roadmap.md:180)

- **Severity:** P2 (acceptance criterion unverified)
- **Doc says:** "Pre-cached quiz text is accessible by key within 10ms"
  (roadmap.md:180, A4 acceptance).
- **Code today:** `backend/scripts/check_redis.py` (per the agent plan)
  does PING / SET / GET / TTL / DEL but no timing assertion.
- **What's missing:** A timing assertion against the live Redis Cloud
  instance.
- **Time:** ~10 min.
- **Patch:** add to `backend/scripts/check_redis.py` after the existing
  smoke block:
  ```python
  # Hot-path latency: roadmap.md A4 says "pre-cached quiz text accessible
  # within 10ms". Measure it.
  import time
  await r.set("vibeschool:hot", '{"x":1}', ex=60)
  t0 = time.perf_counter()
  for _ in range(100):
      await r.get("vibeschool:hot")
  avg_ms = (time.perf_counter() - t0) * 1000 / 100
  print(f"hot-path GET avg: {avg_ms:.2f}ms (target: < 10ms)")
  assert avg_ms < 10, f"hot-path GET avg {avg_ms:.2f}ms exceeds 10ms"
  await r.delete("vibeschool:hot")
  ```

- **Verify:**
  ```bash
  .venv/bin/python -m backend.scripts.check_redis
  # expected: "hot-path GET avg: X.XXms" printed, less than 10
  ```

- **Note:** Requires a real Redis URL in `backend/.env`. Skip if you don't
  have credentials handy; the existing in-process tests already prove the
  code path is fast.

---

## 5. Trade-offs (decide before you start)

| Decision | Options | Recommended |
|---|---|---|
| **Singleton fix (P1-1)** | (a) comment only (1 min) vs (b) `WeakKeyDictionary` per-loop (15 min) | (a) for the hackathon. Document the upgrade path. |
| **Orphan cleanup (P1-5)** | (a) Sentry breadcrumb only vs (b) breadcrumb + `ZREM` | (a) — keeps a paper trail; humans investigate before cleanup. (b) keeps the data set clean. |
| **Atomicity of `mark_pr_processed` / `add_user_repo` (P1-2, P1-4)** | (a) pipeline (1 RTT, MULTI/EXEC) vs (b) Lua script (still 1 RTT, less chatty on the wire) | (a) — consistent with the existing style. |
| **DEMO_MODE env (P2-2)** | (a) env + warning vs (b) env only | (a) — the warning catches the accident class. |
| **N+1 in `get_due_concepts` (P2-1)** | (a) pipeline (P2-1 patch) vs (b) Lua script (faster) | (a) — keeps the codebase readable; 30ms → 1ms is plenty. |

---

## 6. Verification gate (run after every P0/P1 fix)

```bash
cd /Users/aryanashta/Documents/GitHub/ucb-ai-hackathon
.venv/bin/pytest backend/tests/test_redis.py backend/tests/test_sm2.py -v
# expected after P0-1:  29 passed, 1 xfailed (unchanged)
# expected after P1-1:  29 passed, 1 xfailed
# expected after P1-2:  29 passed, 1 xfailed
# expected after P1-3:  30 passed, 0 xfailed  ← the xfail turns green
# expected after P1-4:  30 passed, 0 xfailed
# expected after P1-5:  30 passed, 0 xfailed
# expected after P2-1:  30 passed, 0 xfailed (also subsumes P1-5)
# expected after P2-2:  30 passed, 0 xfailed
# expected after P2-3:  30 passed, 0 xfailed
# expected after P2-4:  unchanged (live smoke only)

.venv/bin/pytest  # full suite
# expected: 92 passed, 0 xfailed, 1 warning
```

If any P0/P1 patch breaks an existing test, **stop and surface the
regression** before continuing.

---

## 7. Out of scope (explicit)

- **Frontend.** All changes are in `backend/`. The dashboard reads
  `/api/concepts/{user_id}` (already implemented), so once the backend is
  fixed, no frontend change is required for the fixes in this plan.
- **Auth (P1-4 from the audit).** Already closed by the OAuth refactor
  (every router uses `Depends(get_current_user)` and reads `user["id"]`
  from the bearer token). The `user_id` strings still flow into
  `redis_client.py` as plain arguments — that's the internal helper
  contract, not an auth bypass.
- **P1-2 `starlette.testclient` httpx deprecation.** Cosmetic; no code
  change available until `httpx2` ships.
- **P2-3 (real Sentry DSN in `.env.local.example`).** Frontend, out of scope.
- **P2-5 (drop `PyGithub` from requirements).** Independent; do it
  separately.
- **P2-6 (verify Poke / Browserbase URLs live).** Requires workshop access;
  not a Redis task.
- **P1-5 (Browserbase session close).** Not Redis.
- **P1-1 (sentry `description=` → `name=`).** Five one-liners in
  non-Redis files; do it in a separate commit.
- **Production Redis sharding / replication / cluster.** Hackathon runs
  one Redis Cloud instance; cluster is post-hackathon.
- **TTS, mascot, calendar UX.** Out of scope per the demo readiness plan.

---

## 8. Files likely to change (summary)

| File | Action | Tasks |
|---|---|---|
| `backend/routers/quiz.py` | **modify** — wrap `update_sm2_state` in `HTTPException(404)` | P0-1 |
| `backend/routers/schedule.py` | **modify** — same wrap, if `update_sm2_state` is called there | P0-1 |
| `backend/services/redis_client.py` | **modify** — SINGLETON comment; pipeline `mark_pr_processed`; clamp quality; pipeline `add_user_repo`; orphan breadcrumb (or subsumed by P2-1); pipeline `get_due_concepts`; concept_id schema comment | P1-1, P1-2, P1-3, P1-4, P1-5, P2-1, P2-3 |
| `backend/services/sm2.py` | **modify** — env-driven `DEMO_MODE` + warning | P2-2 |
| `backend/scripts/check_redis.py` | **modify** — 10ms hot-path timing assertion | P2-4 |

No new files. No deletes. No frontend changes.

---

## 9. Total effort

- **P0 fixes:** ~5 min
- **P1 fixes:** ~20 min
- **P2 fixes:** ~30 min
- **Verification:** ~5 min between each step

**Total wall time if you do everything: ~55 minutes** (plus a smoke run at
the end).

**Minimum bar for the demo:** P0-1 + P1-1 + P1-3 (~10 min total). Closes
the user-visible 500 risk, the highest-severity open audit issue, and the
real bug that the new xfailed test surfaces.

---

## 10. Rollback plan

Each fix is independent and isolated to a single function (or single
router call site). To roll back any single fix:

1. `git revert <commit>` (if you committed per-task)
2. Re-run `pytest backend/tests/test_redis.py backend/tests/test_sm2.py -v`
3. Re-run `pytest` for the full suite

No migrations, no data backfill, no Redis key surgery required for any
fix in this plan. The schema and key formats are unchanged.
