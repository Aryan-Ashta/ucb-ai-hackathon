# VibeSchool Backend — Implementation Plan

Reference doc for executing `AGENTS/vibeschool_agent_plan.md`.

---

## File Manifest

### Root-level
| File | Purpose |
|---|---|
| `requirements.txt` | pip dependencies for all P0 and P1 integrations |
| `.env.example` | Template for all required env vars (no values) |

### Core app
| File | Purpose |
|---|---|
| `main.py` | FastAPI app factory; imports sentry_init first, mounts all routers under `/api` |
| `config.py` | Reads all env vars via `os.environ`; fails fast at startup if any P0 var is missing |
| `sentry_init.py` | `sentry_sdk.init()` with `traces_sample_rate=1.0`; first module imported by `main.py` |
| `models.py` | Pydantic models: `QuizConcept`, `ConceptList` |

### Routers
| File | Purpose |
|---|---|
| `routers/webhook.py` | POST `/api/webhook/github` — HMAC-SHA256 verify, merged-PR detection, background ingestion |
| `routers/concepts.py` | Stub: `GET /api/concepts/{user_id}` — placeholder, return 501 |
| `routers/quiz.py` | POST `/api/transcribe` (audio → STT) and POST `/api/grade` (transcript → Claude grader + SM-2) |
| `routers/schedule.py` | POST `/api/schedule-review` — Poke API calendar event at SM-2 next_review |

### Services
| File | Purpose |
|---|---|
| `services/diff_parser.py` | `fetch_and_parse_diff(repo, pr_number)` — GitHub diff fetch, filter ALLOWED_EXTENSIONS, strip whitespace hunks |
| `services/bear2.py` | `compress_diff(raw_diff)` — Bear-2 POST with `mode:"accuracy"`; graceful fallback to raw diff |
| `services/claude.py` | `extract_concepts_and_cache()` and `grade_answer()`; both use `claude-sonnet-4-6` |
| `services/redis_client.py` | `cache_quiz_content`, `get_due_concepts`, `get_quiz_content`, `update_sm2_state`; TTL=604800s |
| `services/sm2.py` | `sm2_next(state, quality)` — pure SM-2 algorithm; `DEMO_MODE=True` (1 day = 60 sec) |
| `services/deepgram_stt.py` | `transcribe_audio(audio_bytes, mimetype)` — Deepgram `nova-2` REST |
| `services/poke.py` | `schedule_review_block(...)` — Poke API event creation |

### Tests
| File | Purpose |
|---|---|
| `tests/test_sm2.py` | Unit: SM-2 state transitions (correct/wrong/ease-clamp) |
| `tests/test_bear2.py` | Integration: compressed tokens < raw, output > 50 chars |
| `tests/test_claude.py` | Integration: fib diff → >= 1 concept with all required fields |
| `tests/test_e2e.py` | Full pipeline: small+large diff → extract → due → quiz → SM-2; TTL check |
| `tests/fixtures/pr_payload.json` | Real merged-PR webhook payload (action=closed, merged=true) |
| `tests/fixtures/sample.diff` | Small diff for bear2 test |
| `tests/fixtures/sample_large.diff` | Large diff for e2e stress test |
| `tests/fixtures/sample_answer.webm` | ~10 sec audio of "memoization" for STT test |

---

## Implementation Order

```
PREREQUISITES — no external deps, do first
  1. requirements.txt
  2. .env.example → copy to .env and fill keys
  3. config.py
  4. sentry_init.py
  5. models.py
  6. main.py (stub router includes until routers exist)

P0 — complete in order, each task depends on previous
  A4a: services/sm2.py          (pure algorithm, no deps — fastest win)
        → run tests/test_sm2.py
  A1a: services/diff_parser.py
  A2:  services/bear2.py
        → run tests/test_bear2.py
  A4b: services/redis_client.py  (depends on sm2, models)
  A3:  services/claude.py        (depends on bear2, redis_client, models)
        → run tests/test_claude.py
  A1b: routers/webhook.py        (depends on diff_parser, claude)
  A5a: services/deepgram_stt.py
  A5b: routers/quiz.py           (depends on deepgram_stt, claude, redis_client)
  A6a: services/poke.py
  A6b: routers/schedule.py       (depends on poke, redis_client)
  stub: routers/concepts.py
  → run tests/test_e2e.py        (requires local Redis)

P1 — only after ALL A1–A6 acceptance criteria pass
  _(no P1 tasks planned — A1–A6 cover the demo path)_
```

**Recommended single-sitting order:**
`requirements.txt` → `.env.example` → `config.py` → `sentry_init.py` → `models.py` → `sm2.py` → `test_sm2.py` → `redis_client.py` → `diff_parser.py` → `bear2.py` → `test_bear2.py` → `claude.py` → `test_claude.py` → `deepgram_stt.py` → `poke.py` → `main.py` + all routers → `test_e2e.py` → P1

---

## Pip Install

```bash
pip install fastapi uvicorn python-dotenv httpx anthropic redis sentry-sdk PyGithub pydantic python-multipart
```

`requirements.txt`:
```
fastapi
uvicorn
python-dotenv
httpx
anthropic
redis
sentry-sdk
PyGithub
pydantic
python-multipart
```

---

## Acceptance Criteria Checklists

### Prerequisites
- [ ] `pip install` completes without errors
- [ ] `python -c "from backend.config import ANTHROPIC_API_KEY"` passes (with .env populated)
- [ ] `uvicorn backend.main:app --reload --port 8000` starts cleanly
- [ ] Deliberate exception in any route appears in Sentry dashboard within 30 seconds

### A1 — GitHub Webhook + Diff Parser
- [ ] Invalid HMAC → HTTP 401
- [ ] `action=opened` (not merged) → `{"status": "ignored"}`
- [ ] `action=closed` + `merged=true` → `{"status": "accepted"}` within 200ms
- [ ] `clean_diff()` removes binary file notices
- [ ] `clean_diff()` strips files not in ALLOWED_EXTENSIONS
- [ ] `clean_diff()` removes lock file hunks (`package-lock.json`, `yarn.lock`, etc.)
- [ ] `clean_diff()` removes whitespace-only lines (`"+"`, `"-"`, `"+ "`, `"- "`)
- [ ] Sentry breadcrumb logged with raw vs cleaned char counts

### A2 — Bear-2 Compression
- [ ] Returns non-empty string
- [ ] `count_tokens_approx(compressed) < count_tokens_approx(raw)`
- [ ] Output length > 50 characters
- [ ] Unreachable or non-2xx API → returns raw diff unchanged (no exception)
- [ ] Sentry breadcrumb with `{raw_tokens, compressed_tokens, reduction_pct}`

### A3 — Claude Concept Extractor
- [ ] Returns a list (may be empty for trivial diffs)
- [ ] fib recursive sample → >= 1 concept
- [ ] Each concept has non-empty: `concept`, `roast_text`, `question_text`, `answer_hint`
- [ ] `roast_text` references something specific from the diff (not generic)
- [ ] Claude response is valid JSON, no markdown fences
- [ ] `grade_answer()` returns `{quality: int, passed: bool, explanation: str}`
- [ ] Model string is `"claude-sonnet-4-6"` in code
- [ ] Sentry breadcrumb with extracted concept names

### A4 — SM-2 + Redis
- [ ] `sm2_next(state, q=5)` at reps=0 → interval=1, reps=1
- [ ] `sm2_next(state, q=5)` at reps=1 → interval=6, reps=2
- [ ] `sm2_next(state, q=5)` at reps=2 → interval > 6
- [ ] `sm2_next(state, q=0)` → interval=1, reps=0 (reset)
- [ ] Ease factor never < 1.3
- [ ] `DEMO_MODE = True` in sm2.py
- [ ] `cache_quiz_content()` stores `:quiz` and `:state` keys with TTL >= 604800s
- [ ] `get_due_concepts()` returns concepts where `next_review <= now`
- [ ] `update_sm2_state()` updates `:state` key and `due:{user_id}` sorted set score
- [ ] All Redis keys have TTL >= 604800 (`redis-cli TTL <key>`)

### A5 — Deepgram STT + Quiz Router
- [ ] Empty audio → HTTP 400
- [ ] `sample_answer.webm` → `{transcript: "memoization"}` (or similar)
- [ ] POST `/api/grade` with valid payload → `{passed, quality, explanation, next_review}`
- [ ] Unknown concept_id → HTTP 404
- [ ] `quality` is int 0–5; `next_review` is future unix timestamp
- [ ] Sentry span logged for Deepgram call

### A6 — Poke API Calendar
- [ ] Unknown concept_id → HTTP 404
- [ ] Valid payload → `{"status": "scheduled", "event": {...}}`
- [ ] Calendar event visible in Poke dashboard
- [ ] Event title: `"VibeSchool: review <concept>"`
- [ ] Event duration: 10 minutes
- [ ] Event start matches `next_review_timestamp`
- [ ] Sentry breadcrumb with event_id and concept_id

### A8 — End-to-End
- [ ] Small diff cycle completes without exception
- [ ] Large diff cycle completes without exception
- [ ] All concept Redis keys have TTL > 518400s (6 days)
- [ ] Sentry breadcrumbs for Bear-2, Claude, Redis, SM-2 visible in one session trace
- [ ] At least one real Sentry error captured during testing
- [ ] Demo Redis state cleared (`redis-cli DEL <scoped keys>`) for clean demo

---

## API URLs Requiring Confirmation

These are best-guess placeholders. Verify against live docs before first call.

| Service | Placeholder | Where to confirm | Field to update |
|---|---|---|---|
| Bear-2 endpoint | `https://api.thetokencompany.com/v1/compress` | thetokencompany.com/docs | `BEAR2_URL` in `bear2.py` |
| Bear-2 request body | `{"text": ..., "mode": "accuracy"}` | Token Company docs | `json=` dict in `bear2.py` |
| Bear-2 response field | `response.json()["compressed_text"]` | Token Company docs | key in `bear2.py` |
| Poke API base | `https://api.interaction.co/v1` | Interaction Co workshop Sat AM | `POKE_API_BASE` in `poke.py` |
| Poke event schema | `{title, description, start, duration_minutes, calendar_id}` | Same | `event_payload` in `poke.py` |

**Before first Bear-2 call:** Run a manual `curl` with a short test string to confirm URL, request shape, and response key.

**Before Poke call:** Attend Interaction Co workshop Saturday AM to confirm auth scheme and event schema.

---

## Key Constraints (quick reference)

- Never hardcode secrets — all via `os.environ["KEY"]` in `config.py`
- Model string must be `"claude-sonnet-4-6"` everywhere
- Every outbound API call must have a `sentry_sdk.add_breadcrumb()` call
- Every Redis write must include `ex=REDIS_TTL_SECONDS` (= 604800)
- Claude prompts must say "Respond ONLY with valid JSON, no markdown fences"
- `DEMO_MODE = True` in `sm2.py` until after judging
- Bear-2 must use try/except with graceful fallback — never abort ingestion
- P1 tasks must not start until A1–A6 all pass acceptance criteria
- Never call `FLUSHDB` in production — only on the local demo Redis instance
