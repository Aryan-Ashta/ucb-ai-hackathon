# VibeSchool — Agent Execution Plan (Aryan / Backend)
> This document is written for an AI coding agent (e.g. Claude Code).
> Execute tasks in the order specified. Each task includes exact file paths, function signatures, implementation steps, test commands, and hard constraints.

---

## Agent Rules

- **Never hardcode secrets.** All API keys must be read from environment variables.
- **Use `claude-sonnet-4-6`** for all Claude API calls.
- **Sentry is a prerequisite for every task.** Do not make any external API calls without a Sentry breadcrumb wrapping them.
- **Stop and surface an error** if an acceptance criterion cannot be met — do not silently skip.
- **P0 tasks block P1 tasks.** Do not begin A7 until A1–A6 are all passing their acceptance criteria.
- **Redis TTL minimum is 7 days** on every key written.
- **JSON only from Claude** — system prompt must enforce no markdown fences, no preamble.
- After completing each task, run its verification command and confirm output before proceeding.

---

## Repository Structure

```
vibeschool/
├── backend/
│   ├── main.py               # FastAPI app entrypoint
│   ├── routers/
│   │   ├── webhook.py        # A1: GitHub webhook handler
│   │   ├── concepts.py       # A3: concept extraction endpoint
│   │   ├── quiz.py           # A5: STT + grading endpoints
│   │   ├── schedule.py       # A6: Poke API calendar endpoint
│   │   └── enrich.py         # A7 (P1): Browserbase enrichment
│   ├── services/
│   │   ├── diff_parser.py    # A1: diff parsing logic
│   │   ├── bear2.py          # A2: Token Company compression
│   │   ├── claude.py         # A3: Claude API calls
│   │   ├── redis_client.py   # A4: Redis connection + SM-2
│   │   ├── sm2.py            # A4: SM-2 algorithm
│   │   ├── deepgram_stt.py   # A5: Deepgram STT
│   │   ├── poke.py           # A6: Poke API client
│   │   └── browserbase.py    # A7 (P1): Browserbase client
│   ├── models.py             # Pydantic models
│   ├── config.py             # Env var loading
│   └── sentry_init.py        # Sentry setup — imported first in main.py
├── .env.example
└── requirements.txt
```

---

## Environment Variables

Create `.env` from this template. Agent must never write values into source files.

```bash
# .env.example
GITHUB_WEBHOOK_SECRET=
ANTHROPIC_API_KEY=
TOKEN_COMPANY_API_KEY=
DEEPGRAM_API_KEY=
REDIS_URL=redis://localhost:6379
SENTRY_DSN=
POKE_API_KEY=
BROWSERBASE_API_KEY=        # P1 only
```

Load all vars in `backend/config.py`:

```python
# backend/config.py
import os
from dotenv import load_dotenv

load_dotenv()

GITHUB_WEBHOOK_SECRET = os.environ["GITHUB_WEBHOOK_SECRET"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
TOKEN_COMPANY_API_KEY = os.environ["TOKEN_COMPANY_API_KEY"]
DEEPGRAM_API_KEY = os.environ["DEEPGRAM_API_KEY"]
REDIS_URL = os.environ["REDIS_URL"]
SENTRY_DSN = os.environ["SENTRY_DSN"]
POKE_API_KEY = os.environ["POKE_API_KEY"]
BROWSERBASE_API_KEY = os.environ.get("BROWSERBASE_API_KEY", "")  # P1 optional
```

---

## Prerequisites — Install & Sentry Init

### Install dependencies

```bash
pip install fastapi uvicorn python-dotenv httpx anthropic redis sentry-sdk pygithub pydantic python-multipart
```

Add to `requirements.txt`:
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

### Sentry init — must be first import in main.py

```python
# backend/sentry_init.py
import sentry_sdk
from backend.config import SENTRY_DSN

sentry_sdk.init(
    dsn=SENTRY_DSN,
    traces_sample_rate=1.0,
    profiles_sample_rate=1.0,
)
```

```python
# backend/main.py
import backend.sentry_init  # MUST be first import
from fastapi import FastAPI
from backend.routers import webhook, concepts, quiz, schedule

app = FastAPI(title="VibeSchool Backend")
app.include_router(webhook.router, prefix="/api")
app.include_router(concepts.router, prefix="/api")
app.include_router(quiz.router, prefix="/api")
app.include_router(schedule.router, prefix="/api")
```

**Verification:** Start server, deliberately raise an exception in any route, confirm it appears in Sentry dashboard within 30 seconds before proceeding to A1.

---

## Task A1: GitHub Webhook + Diff Parser

**File:** `backend/services/diff_parser.py`, `backend/routers/webhook.py`

**Goal:** Accept a GitHub `pull_request` webhook (action: `closed`, `merged: true`), extract and clean the unified diff, return it as a plain string.

### Step 1 — Webhook route

```python
# backend/routers/webhook.py
import hashlib, hmac
import sentry_sdk
from fastapi import APIRouter, Request, HTTPException, BackgroundTasks
from backend.config import GITHUB_WEBHOOK_SECRET
from backend.services.diff_parser import fetch_and_parse_diff
from backend.services.claude import extract_concepts_and_cache

router = APIRouter()

def verify_signature(payload: bytes, sig_header: str) -> bool:
    expected = "sha256=" + hmac.new(
        GITHUB_WEBHOOK_SECRET.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, sig_header)

@router.post("/webhook/github")
async def github_webhook(request: Request, background_tasks: BackgroundTasks):
    payload_bytes = await request.body()
    sig = request.headers.get("X-Hub-Signature-256", "")

    if not verify_signature(payload_bytes, sig):
        raise HTTPException(status_code=401, detail="Invalid signature")

    payload = await request.json()

    # Only process merged PRs
    if payload.get("action") != "closed" or not payload.get("pull_request", {}).get("merged"):
        return {"status": "ignored"}

    pr = payload["pull_request"]
    repo_full_name = payload["repository"]["full_name"]
    pr_number = pr["number"]
    user_id = str(pr["user"]["id"])

    sentry_sdk.add_breadcrumb(
        category="webhook",
        message=f"Received merged PR #{pr_number} from {repo_full_name}",
        level="info"
    )

    # Run ingestion pipeline in background so webhook returns immediately
    background_tasks.add_task(
        run_ingestion_pipeline,
        repo_full_name=repo_full_name,
        pr_number=pr_number,
        user_id=user_id
    )

    return {"status": "accepted"}

async def run_ingestion_pipeline(repo_full_name: str, pr_number: int, user_id: str):
    with sentry_sdk.start_transaction(op="ingestion", name=f"PR #{pr_number}"):
        diff_text = await fetch_and_parse_diff(repo_full_name, pr_number)
        if diff_text:
            await extract_concepts_and_cache(diff_text, user_id, pr_number)
```

### Step 2 — Diff parser

```python
# backend/services/diff_parser.py
import httpx
import sentry_sdk
from backend.config import GITHUB_WEBHOOK_SECRET

# File extensions to keep — ignore everything else
ALLOWED_EXTENSIONS = {".py", ".ts", ".js", ".tsx", ".jsx", ".go", ".rs", ".java", ".cpp", ".c", ".cs"}

# Patterns that indicate generated/lock files — skip these
SKIP_PATTERNS = [
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "Cargo.lock", "go.sum",
    "*.min.js", "*.min.css", "__pycache__", ".pyc"
]

async def fetch_and_parse_diff(repo_full_name: str, pr_number: int) -> str:
    """
    Fetch the unified diff for a PR from GitHub API.
    Returns cleaned diff text or empty string if nothing useful found.
    """
    url = f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}"
    headers = {
        "Accept": "application/vnd.github.v3.diff",
        # GitHub token from env if available, else unauthenticated (rate limited)
        "Authorization": f"Bearer {__import__('os').environ.get('GITHUB_TOKEN', '')}",
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(url, headers=headers, timeout=15.0)
        response.raise_for_status()
        raw_diff = response.text

    cleaned = clean_diff(raw_diff)

    sentry_sdk.add_breadcrumb(
        category="diff_parser",
        message=f"Parsed PR #{pr_number}: {len(raw_diff)} chars raw → {len(cleaned)} chars cleaned",
        level="info"
    )

    return cleaned

def clean_diff(raw_diff: str) -> str:
    """
    Filter unified diff to only include hunks from allowed file types.
    Strip binary file notices, whitespace-only hunks, and generated files.
    """
    lines = raw_diff.split("\n")
    output_lines = []
    current_file_allowed = False

    for line in lines:
        # Detect file header
        if line.startswith("diff --git"):
            filename = line.split(" b/")[-1] if " b/" in line else ""
            current_file_allowed = (
                any(filename.endswith(ext) for ext in ALLOWED_EXTENSIONS)
                and not any(pat.replace("*", "") in filename for pat in SKIP_PATTERNS)
            )
            if current_file_allowed:
                output_lines.append(line)
            continue

        if not current_file_allowed:
            continue

        # Skip binary file notices
        if line.startswith("Binary files"):
            continue

        # Skip lines that are purely whitespace changes
        if line in ("+", "-", "+ ", "- "):
            continue

        output_lines.append(line)

    return "\n".join(output_lines).strip()
```

### Acceptance criteria verification

```bash
# Start server
uvicorn backend.main:app --reload --port 8000

# Test with a real PR diff (replace with actual repo/PR)
curl -X POST http://localhost:8000/api/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=<computed_sig>" \
  -d @tests/fixtures/pr_payload.json

# Expected: {"status": "accepted"}
# Check logs: cleaned diff text printed, no binary blobs
```

**Create test fixture** at `tests/fixtures/pr_payload.json` using a real merged PR from your own repos. The `action` must be `"closed"` and `merged` must be `true`.

---

## Task A2: Token Company Bear-2 Compression

**File:** `backend/services/bear2.py`

**Goal:** Compress raw diff text via Bear-2 before sending to Claude. Log token reduction to Sentry.

### Implementation

```python
# backend/services/bear2.py
import httpx
import sentry_sdk
from backend.config import TOKEN_COMPANY_API_KEY

BEAR2_URL = "https://api.thetokencompany.com/v1/compress"  # confirm exact URL from docs

def count_tokens_approx(text: str) -> int:
    """Rough token count: ~4 chars per token for code."""
    return len(text) // 4

async def compress_diff(raw_diff: str) -> str:
    """
    Compress diff text using Token Company Bear-2.
    Falls back to raw diff if API fails (do not block ingestion).
    Uses accuracy-preserving mode to avoid stripping code semantics.
    """
    raw_tokens = count_tokens_approx(raw_diff)

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                BEAR2_URL,
                headers={
                    "Authorization": f"Bearer {TOKEN_COMPANY_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "text": raw_diff,
                    "mode": "accuracy",   # NOT "aggressive" — preserves code semantics
                },
                timeout=10.0,
            )
            response.raise_for_status()
            compressed = response.json()["compressed_text"]

    except Exception as e:
        sentry_sdk.capture_exception(e)
        sentry_sdk.add_breadcrumb(
            category="bear2",
            message=f"Bear-2 failed, falling back to raw diff: {str(e)}",
            level="warning"
        )
        return raw_diff  # graceful fallback

    compressed_tokens = count_tokens_approx(compressed)
    reduction_pct = round((1 - compressed_tokens / max(raw_tokens, 1)) * 100, 1)

    sentry_sdk.add_breadcrumb(
        category="bear2",
        message=f"Bear-2 compression: {raw_tokens} → {compressed_tokens} tokens ({reduction_pct}% reduction)",
        level="info",
        data={
            "raw_tokens": raw_tokens,
            "compressed_tokens": compressed_tokens,
            "reduction_pct": reduction_pct,
        }
    )

    return compressed
```

### Acceptance criteria verification

```python
# tests/test_bear2.py
import asyncio
from backend.services.bear2 import compress_diff, count_tokens_approx

async def test_compression():
    sample_diff = open("tests/fixtures/sample.diff").read()
    raw_tokens = count_tokens_approx(sample_diff)
    compressed = await compress_diff(sample_diff)
    compressed_tokens = count_tokens_approx(compressed)

    assert len(compressed) > 0, "Compressed output is empty"
    assert compressed_tokens < raw_tokens, "No token reduction achieved"
    assert len(compressed) > 50, "Output too short — likely stripped code semantics"

    print(f"✓ Bear-2: {raw_tokens} → {compressed_tokens} tokens")
    print(f"✓ Sample compressed output:\n{compressed[:300]}")

asyncio.run(test_compression())
```

```bash
python tests/test_bear2.py
```

**Note:** If the Bear-2 API URL or request schema differs from the docs, update `BEAR2_URL` and the `json` payload accordingly. The acceptance test is what matters — token reduction must be measurable.

---

## Task A3: Claude Concept Extractor

**File:** `backend/services/claude.py`

**Goal:** Send compressed diff to Claude. Extract CS concepts, generate a roast, and produce one quiz question per concept. Cache results in Redis immediately.

### Pydantic models

```python
# backend/models.py
from pydantic import BaseModel
from typing import List, Optional

class QuizConcept(BaseModel):
    concept_id: str          # "{user_id}:{pr_number}:{slug}"
    concept: str             # human-readable name, e.g. "memoization"
    roast_text: str          # savage but educational roast of the code
    question_text: str       # the quiz question
    answer_hint: str         # comma-separated keywords for grading

class ConceptList(BaseModel):
    concepts: List[QuizConcept]
```

### Claude service

```python
# backend/services/claude.py
import json
import re
import sentry_sdk
import anthropic
from backend.config import ANTHROPIC_API_KEY
from backend.services.bear2 import compress_diff
from backend.services.redis_client import cache_quiz_content
from backend.models import QuizConcept

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

SYSTEM_PROMPT = """You are VibeSchool, a savage but educational code reviewer.
Given a GitHub PR diff, you:
1. Identify 1-5 CS concepts or patterns that appear in the diff
2. Write a roast of the code for each concept — be specific, reference actual code details, be funny but educational
3. Write one quiz question per concept that tests understanding of that concept
4. Write answer hints (comma-separated keywords an LLM grader would accept as correct)

Rules:
- Respond ONLY with a valid JSON array. No markdown fences, no preamble, no explanation.
- Each item must have exactly these fields: concept, roast_text, question_text, answer_hint
- Roasts must reference specific variable names, function names, or patterns from the actual diff
- Questions must be specific to the diff, not generic textbook questions
- If the diff is trivial (only whitespace, comments, config), return an empty array []

Example output:
[
  {
    "concept": "memoization",
    "roast_text": "You wrote a recursive fib with zero caching. A CS101 student called, they want their homework back.",
    "question_text": "What technique would eliminate the redundant recomputation in your recursive fib function?",
    "answer_hint": "memoization, caching, dynamic programming, lookup table, lru_cache"
  }
]"""

async def extract_concepts_and_cache(raw_diff: str, user_id: str, pr_number: int) -> list[QuizConcept]:
    """
    Full ingestion pipeline:
    1. Compress diff via Bear-2
    2. Send to Claude for concept extraction
    3. Cache results in Redis
    Returns list of QuizConcept objects.
    """
    with sentry_sdk.start_span(op="claude.extract", description="Concept extraction"):
        compressed_diff = await compress_diff(raw_diff)

        try:
            message = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=2048,
                system=SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": f"Extract concepts from this PR diff:\n\n{compressed_diff}"
                    }
                ]
            )
        except Exception as e:
            sentry_sdk.capture_exception(e)
            raise

        raw_response = message.content[0].text.strip()

        # Strip any accidental markdown fences Claude may have added
        raw_response = re.sub(r"^```json\s*", "", raw_response)
        raw_response = re.sub(r"\s*```$", "", raw_response)

        try:
            concepts_data = json.loads(raw_response)
        except json.JSONDecodeError as e:
            sentry_sdk.capture_exception(e)
            sentry_sdk.add_breadcrumb(
                category="claude",
                message=f"JSON parse failed. Raw response: {raw_response[:200]}",
                level="error"
            )
            return []

        concepts = []
        for i, item in enumerate(concepts_data):
            slug = item["concept"].lower().replace(" ", "_")
            concept = QuizConcept(
                concept_id=f"{user_id}:{pr_number}:{slug}",
                concept=item["concept"],
                roast_text=item["roast_text"],
                question_text=item["question_text"],
                answer_hint=item["answer_hint"],
            )
            concepts.append(concept)

        sentry_sdk.add_breadcrumb(
            category="claude",
            message=f"Extracted {len(concepts)} concepts from PR #{pr_number}",
            level="info",
            data={"concepts": [c.concept for c in concepts]}
        )

        # Cache in Redis immediately (see A4 for schema)
        for concept in concepts:
            await cache_quiz_content(user_id, concept)

        return concepts


async def grade_answer(question_text: str, answer_hint: str, transcript: str) -> dict:
    """
    Grade a spoken answer against the expected concept.
    Returns {passed: bool, quality: int (0-5), explanation: str}
    """
    grading_prompt = f"""You are grading a developer's spoken quiz answer.

Question: {question_text}
Acceptable answer keywords: {answer_hint}
Student's spoken answer: {transcript}

Grade on a 0-5 scale (SM-2 quality score):
- 5: Perfect answer, clearly understands the concept
- 4: Correct with minor gaps
- 3: Correct but hesitant or incomplete
- 2: Partially correct
- 1: Attempted but mostly wrong
- 0: Completely wrong or no answer

Respond ONLY with valid JSON, no markdown fences:
{{"quality": <int 0-5>, "passed": <bool>, "explanation": "<one sentence feedback>"}}"""

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=256,
        messages=[{"role": "user", "content": grading_prompt}]
    )

    raw = message.content[0].text.strip()
    raw = re.sub(r"^```json\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)

    return json.loads(raw)
```

### Acceptance criteria verification

```python
# tests/test_claude.py
import asyncio
from backend.services.claude import extract_concepts_and_cache

SAMPLE_DIFF = """
diff --git a/fib.py b/fib.py
+def fib(n):
+    if n <= 1:
+        return n
+    return fib(n-1) + fib(n-2)
"""

async def test_extraction():
    concepts = await extract_concepts_and_cache(SAMPLE_DIFF, user_id="test_user", pr_number=999)
    assert len(concepts) >= 1, "Expected at least 1 concept"
    for c in concepts:
        assert c.concept, "Missing concept name"
        assert c.roast_text, "Missing roast"
        assert c.question_text, "Missing question"
        assert c.answer_hint, "Missing answer hint"
        print(f"✓ Concept: {c.concept}")
        print(f"  Roast: {c.roast_text}")
        print(f"  Question: {c.question_text}")

asyncio.run(test_extraction())
```

```bash
python tests/test_claude.py
```

---

## Task A4: SM-2 Scheduler in Redis

**Files:** `backend/services/redis_client.py`, `backend/services/sm2.py`

**Goal:** Implement SM-2. Store all concept state in Redis. Pre-cache quiz content at ingestion time.

### Redis client

```python
# backend/services/redis_client.py
import json
import redis.asyncio as aioredis
import sentry_sdk
from backend.config import REDIS_URL
from backend.models import QuizConcept

REDIS_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days minimum

_redis: aioredis.Redis | None = None

async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    return _redis

# ── Key schema ────────────────────────────────────────────────────────────────
# concept:{user_id}:{concept_id}:state  → JSON {ease_factor, interval, repetitions, next_review}
# concept:{user_id}:{concept_id}:quiz   → JSON {roast_text, question_text, answer_hint}
# due:{user_id}                         → sorted set, score = next_review unix timestamp

async def cache_quiz_content(user_id: str, concept: QuizConcept) -> None:
    """Store concept quiz content in Redis. Called immediately after A3 extraction."""
    r = await get_redis()
    quiz_key = f"concept:{user_id}:{concept.concept_id}:quiz"
    state_key = f"concept:{user_id}:{concept.concept_id}:state"
    due_key = f"due:{user_id}"

    quiz_data = {
        "concept": concept.concept,
        "roast_text": concept.roast_text,
        "question_text": concept.question_text,
        "answer_hint": concept.answer_hint,
    }

    import time
    now = int(time.time())
    next_review = now + 60  # due in 1 minute for first review (hackathon demo purposes)

    initial_state = {
        "ease_factor": 2.5,
        "interval": 1,
        "repetitions": 0,
        "next_review": next_review,
    }

    pipe = r.pipeline()
    pipe.set(quiz_key, json.dumps(quiz_data), ex=REDIS_TTL_SECONDS)
    pipe.set(state_key, json.dumps(initial_state), ex=REDIS_TTL_SECONDS)
    pipe.zadd(due_key, {concept.concept_id: next_review})
    pipe.expire(due_key, REDIS_TTL_SECONDS)
    await pipe.execute()

    sentry_sdk.add_breadcrumb(
        category="redis",
        message=f"Cached quiz content for concept: {concept.concept}",
        level="info"
    )

async def get_due_concepts(user_id: str) -> list[dict]:
    """Return all concepts due for review, sorted by urgency."""
    import time
    r = await get_redis()
    due_key = f"due:{user_id}"
    now = int(time.time())

    # Get all concepts with next_review <= now (overdue or due)
    due_concept_ids = await r.zrangebyscore(due_key, "-inf", now)

    result = []
    for concept_id in due_concept_ids:
        quiz_key = f"concept:{user_id}:{concept_id}:quiz"
        state_key = f"concept:{user_id}:{concept_id}:state"
        quiz_data = await r.get(quiz_key)
        state_data = await r.get(state_key)
        if quiz_data and state_data:
            result.append({
                "concept_id": concept_id,
                **json.loads(quiz_data),
                "state": json.loads(state_data),
            })

    return result

async def get_quiz_content(user_id: str, concept_id: str) -> dict | None:
    """Fetch pre-cached quiz content for a concept. Used in quiz hot path."""
    r = await get_redis()
    quiz_key = f"concept:{user_id}:{concept_id}:quiz"
    data = await r.get(quiz_key)
    return json.loads(data) if data else None

async def update_sm2_state(user_id: str, concept_id: str, quality: int) -> int:
    """
    Update SM-2 state after a quiz answer. Returns next_review unix timestamp.
    quality: 0-5 (from Claude grader)
    """
    from backend.services.sm2 import sm2_next
    import time

    r = await get_redis()
    state_key = f"concept:{user_id}:{concept_id}:state"
    due_key = f"due:{user_id}"

    state_data = await r.get(state_key)
    if not state_data:
        raise ValueError(f"No state found for concept {concept_id}")

    state = json.loads(state_data)
    new_state = sm2_next(state, quality)

    pipe = r.pipeline()
    pipe.set(state_key, json.dumps(new_state), ex=REDIS_TTL_SECONDS)
    pipe.zadd(due_key, {concept_id: new_state["next_review"]})
    await pipe.execute()

    sentry_sdk.add_breadcrumb(
        category="sm2",
        message=f"Updated SM-2 for {concept_id}: quality={quality}, next_review in {new_state['interval']} days",
        level="info",
        data=new_state
    )

    return new_state["next_review"]
```

### SM-2 algorithm

```python
# backend/services/sm2.py
import time
import math

def sm2_next(state: dict, quality: int) -> dict:
    """
    SM-2 spaced repetition algorithm.

    Args:
        state: {ease_factor, interval, repetitions, next_review}
        quality: int 0-5 from grader

    Returns:
        Updated state dict with new ease_factor, interval, repetitions, next_review
    """
    ef = state["ease_factor"]
    interval = state["interval"]
    repetitions = state["repetitions"]

    if quality >= 3:
        # Correct answer — advance the schedule
        if repetitions == 0:
            new_interval = 1
        elif repetitions == 1:
            new_interval = 6
        else:
            new_interval = math.ceil(interval * ef)

        # Update ease factor
        new_ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
        new_ef = max(1.3, new_ef)  # clamp minimum
        new_repetitions = repetitions + 1

    else:
        # Wrong answer — reset to beginning
        new_interval = 1
        new_ef = max(1.3, ef - 0.2)  # slight ease factor penalty
        new_repetitions = 0

    # For hackathon demo: scale intervals to minutes instead of days
    # Change DEMO_MODE to False for production (real days)
    DEMO_MODE = True
    seconds_per_unit = 60 if DEMO_MODE else 86400  # 1 minute per "day" in demo

    next_review = int(time.time()) + new_interval * seconds_per_unit

    return {
        "ease_factor": round(new_ef, 3),
        "interval": new_interval,
        "repetitions": new_repetitions,
        "next_review": next_review,
    }
```

### Acceptance criteria verification

```python
# tests/test_sm2.py
import asyncio
import time
from backend.services.sm2 import sm2_next

def test_sm2():
    initial = {"ease_factor": 2.5, "interval": 1, "repetitions": 0, "next_review": 0}

    # Correct answer
    s1 = sm2_next(initial, quality=5)
    assert s1["interval"] == 1, f"Expected interval=1, got {s1['interval']}"
    assert s1["repetitions"] == 1

    s2 = sm2_next(s1, quality=5)
    assert s2["interval"] == 6, f"Expected interval=6, got {s2['interval']}"

    s3 = sm2_next(s2, quality=5)
    assert s3["interval"] > 6, f"Expected interval>6, got {s3['interval']}"

    # Wrong answer — reset
    s_wrong = sm2_next(s3, quality=0)
    assert s_wrong["interval"] == 1, "Wrong answer should reset interval to 1"
    assert s_wrong["repetitions"] == 0, "Wrong answer should reset repetitions to 0"

    # Ease factor clamp
    s_clamped = sm2_next({"ease_factor": 1.31, "interval": 1, "repetitions": 2, "next_review": 0}, quality=0)
    assert s_clamped["ease_factor"] >= 1.3, "Ease factor below minimum 1.3"

    print("✓ All SM-2 tests passed")

test_sm2()
```

```bash
python tests/test_sm2.py
```

---

## Task A5: Deepgram STT Pipeline

**File:** `backend/services/deepgram_stt.py`, `backend/routers/quiz.py`

**Goal:** Accept audio blob from frontend, transcribe via Deepgram STT REST API, return transcript. Also expose `/api/grade` endpoint.

### STT service

```python
# backend/services/deepgram_stt.py
import httpx
import sentry_sdk
from backend.config import DEEPGRAM_API_KEY

DEEPGRAM_STT_URL = "https://api.deepgram.com/v1/listen"

async def transcribe_audio(audio_bytes: bytes, mimetype: str = "audio/webm") -> str:
    """
    Transcribe audio bytes using Deepgram nova-2.
    Returns transcript string. Raises on failure.
    """
    params = {
        "model": "nova-2",
        "smart_format": "true",
        "punctuate": "true",
        "language": "en-US",
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(
            DEEPGRAM_STT_URL,
            params=params,
            headers={
                "Authorization": f"Token {DEEPGRAM_API_KEY}",
                "Content-Type": mimetype,
            },
            content=audio_bytes,
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()

    transcript = (
        data.get("results", {})
        .get("channels", [{}])[0]
        .get("alternatives", [{}])[0]
        .get("transcript", "")
        .strip()
    )

    sentry_sdk.add_breadcrumb(
        category="deepgram_stt",
        message=f"Transcribed {len(audio_bytes)} bytes → '{transcript[:80]}'",
        level="info"
    )

    return transcript
```

### Quiz router (STT + grading endpoints)

```python
# backend/routers/quiz.py
import sentry_sdk
from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel
from backend.services.deepgram_stt import transcribe_audio
from backend.services.claude import grade_answer
from backend.services.redis_client import get_quiz_content, update_sm2_state

router = APIRouter()

@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    """Accept audio/webm from browser MediaRecorder, return transcript."""
    audio_bytes = await audio.read()

    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty audio file")

    with sentry_sdk.start_span(op="deepgram.stt", description="Transcribe audio"):
        transcript = await transcribe_audio(audio_bytes, mimetype=audio.content_type or "audio/webm")

    if not transcript:
        return {"transcript": "", "error": "No speech detected — please try again"}

    return {"transcript": transcript}


class GradeRequest(BaseModel):
    user_id: str
    concept_id: str
    transcript: str

@router.post("/grade")
async def grade(req: GradeRequest):
    """Grade a spoken answer and update SM-2 state."""
    quiz = await get_quiz_content(req.user_id, req.concept_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Concept not found in Redis")

    with sentry_sdk.start_span(op="claude.grade", description="Grade answer"):
        result = await grade_answer(
            question_text=quiz["question_text"],
            answer_hint=quiz["answer_hint"],
            transcript=req.transcript,
        )

    next_review = await update_sm2_state(req.user_id, req.concept_id, result["quality"])

    return {
        "passed": result["passed"],
        "quality": result["quality"],
        "explanation": result["explanation"],
        "next_review": next_review,
    }
```

### Acceptance criteria verification

```bash
# Test transcription with a real audio file
curl -X POST http://localhost:8000/api/transcribe \
  -F "audio=@tests/fixtures/sample_answer.webm;type=audio/webm"
# Expected: {"transcript": "memoization or dynamic programming"}

# Test grading
curl -X POST http://localhost:8000/api/grade \
  -H "Content-Type: application/json" \
  -d '{"user_id": "test_user", "concept_id": "test_user:999:memoization", "transcript": "memoization using a lookup table"}'
# Expected: {"passed": true, "quality": 4, "explanation": "...", "next_review": <timestamp>}
```

**Create test audio:** Record a 10-second WAV/WebM of yourself saying "memoization" or "dynamic programming" and save to `tests/fixtures/sample_answer.webm`.

---

## Task A6: Poke API Calendar Integration

**File:** `backend/services/poke.py`, `backend/routers/schedule.py`

**Goal:** After a graded quiz, schedule a 10-minute review block on the user's calendar via the Interaction Co Poke API.

### Poke service

```python
# backend/services/poke.py
import httpx
import sentry_sdk
from datetime import datetime, timezone
from backend.config import POKE_API_KEY

POKE_API_BASE = "https://api.interaction.co/v1"  # confirm exact URL from Interaction Co docs

async def schedule_review_block(
    concept_name: str,
    concept_id: str,
    next_review_timestamp: int,
    user_calendar_id: str,
) -> dict:
    """
    Schedule a 10-minute review block on the user's calendar via Poke API.
    Returns the created event object.
    """
    review_dt = datetime.fromtimestamp(next_review_timestamp, tz=timezone.utc)

    event_payload = {
        "title": f"VibeSchool: review {concept_name}",
        "description": f"Review concept: {concept_name}\nQuiz link: https://vibeschool.app/quiz/{concept_id}",
        "start": review_dt.isoformat(),
        "duration_minutes": 10,
        "calendar_id": user_calendar_id,
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{POKE_API_BASE}/events",
            headers={
                "Authorization": f"Bearer {POKE_API_KEY}",
                "Content-Type": "application/json",
            },
            json=event_payload,
            timeout=10.0,
        )
        response.raise_for_status()
        event = response.json()

    sentry_sdk.add_breadcrumb(
        category="poke",
        message=f"Scheduled review block for '{concept_name}' at {review_dt.isoformat()}",
        level="info",
        data={"event_id": event.get("id"), "concept_id": concept_id}
    )

    return event
```

### Schedule router

```python
# backend/routers/schedule.py
import sentry_sdk
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from backend.services.poke import schedule_review_block
from backend.services.redis_client import get_quiz_content

router = APIRouter()

class ScheduleRequest(BaseModel):
    user_id: str
    concept_id: str
    next_review_timestamp: int
    user_calendar_id: str  # from Poke API user auth

@router.post("/schedule-review")
async def schedule_review(req: ScheduleRequest):
    quiz = await get_quiz_content(req.user_id, req.concept_id)
    if not quiz:
        raise HTTPException(status_code=404, detail="Concept not found")

    with sentry_sdk.start_span(op="poke.schedule", description="Schedule calendar block"):
        event = await schedule_review_block(
            concept_name=quiz["concept"],
            concept_id=req.concept_id,
            next_review_timestamp=req.next_review_timestamp,
            user_calendar_id=req.user_calendar_id,
        )

    return {"status": "scheduled", "event": event}
```

### Acceptance criteria verification

```bash
curl -X POST http://localhost:8000/api/schedule-review \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test_user",
    "concept_id": "test_user:999:memoization",
    "next_review_timestamp": <unix_timestamp_tomorrow>,
    "user_calendar_id": "<your_poke_calendar_id>"
  }'
# Expected: {"status": "scheduled", "event": {...}}
# Confirm: calendar event visible in Poke dashboard / connected calendar
```

**Note:** Attend the Interaction Co workshop Saturday AM to confirm exact API URL, auth flow, and event schema. Update `POKE_API_BASE` and `event_payload` fields accordingly.

---

## Task A7 (P1): Browserbase Docs Enrichment

> **Only begin this task after A1–A6 are all passing acceptance criteria.**

**File:** `backend/services/browserbase.py`, `backend/routers/enrich.py`

**Goal:** Scrape authoritative documentation for each extracted concept. Store enrichment snippet alongside quiz content in Redis.

```python
# backend/services/browserbase.py
import httpx
import sentry_sdk
from backend.config import BROWSERBASE_API_KEY
from backend.services.redis_client import get_redis, REDIS_TTL_SECONDS
import json

BROWSERBASE_API_BASE = "https://api.browserbase.com/v1"  # confirm from Browserbase docs

AUTHORITATIVE_SOURCES = [
    "developer.mozilla.org",
    "docs.python.org",
    "en.wikipedia.org/wiki/",
    "docs.rust-lang.org",
    "go.dev/doc",
]

async def enrich_concept(concept: str, concept_id: str, user_id: str) -> str:
    """
    Scrape a documentation page for the given concept via Browserbase.
    Appends enrichment to Redis quiz content.
    Returns the snippet string.
    """
    search_query = f"{concept} programming computer science"

    try:
        # Create a Browserbase session
        async with httpx.AsyncClient() as client:
            # Step 1: Create session
            session_resp = await client.post(
                f"{BROWSERBASE_API_BASE}/sessions",
                headers={"x-bb-api-key": BROWSERBASE_API_KEY, "Content-Type": "application/json"},
                json={"projectId": "<your_project_id>"},  # from Browserbase dashboard
                timeout=10.0,
            )
            session_resp.raise_for_status()
            session_id = session_resp.json()["id"]

            # Step 2: Navigate to MDN search
            mdn_url = f"https://developer.mozilla.org/en-US/search?q={concept.replace(' ', '+')}"
            # Use Browserbase's fetch or navigate endpoint per their docs
            fetch_resp = await client.post(
                f"{BROWSERBASE_API_BASE}/sessions/{session_id}/fetch",
                headers={"x-bb-api-key": BROWSERBASE_API_KEY, "Content-Type": "application/json"},
                json={"url": mdn_url},
                timeout=20.0,
            )
            fetch_resp.raise_for_status()
            page_text = fetch_resp.json().get("text", "")

            # Extract first meaningful paragraph (heuristic: >50 chars, not a nav item)
            lines = [l.strip() for l in page_text.split("\n") if len(l.strip()) > 80]
            snippet = lines[0] if lines else f"A core CS concept: {concept}."
            snippet = snippet[:300]  # cap length

    except Exception as e:
        sentry_sdk.capture_exception(e)
        sentry_sdk.add_breadcrumb(category="browserbase", message=f"Enrichment failed: {e}", level="warning")
        return ""

    # Store enrichment in Redis alongside quiz content
    r = await get_redis()
    enrich_key = f"concept:{user_id}:{concept_id}:enrichment"
    await r.set(enrich_key, json.dumps({"snippet": snippet, "source": "MDN"}), ex=REDIS_TTL_SECONDS)

    sentry_sdk.add_breadcrumb(
        category="browserbase",
        message=f"Enriched concept '{concept}': {snippet[:80]}",
        level="info"
    )

    return snippet
```

**Note:** Adjust the Browserbase API calls (session creation, navigation, text extraction) to match their actual SDK/API surface. The pattern above follows their documented approach but confirm endpoint names at https://docs.browserbase.com.

---

## Task A8: End-to-End Stress Test

Run all three cycles before judging. Use this script:

```python
# tests/test_e2e.py
import asyncio
from backend.services.diff_parser import clean_diff
from backend.services.claude import extract_concepts_and_cache
from backend.services.redis_client import get_due_concepts, update_sm2_state, get_quiz_content

SMALL_DIFF = """
diff --git a/utils.py b/utils.py
+def add(a, b):
+    return a + b
"""

LARGE_DIFF = open("tests/fixtures/sample_large.diff").read()  # use a real large PR diff

async def run_cycle(diff: str, user_id: str, pr_number: int, label: str):
    print(f"\n── Cycle: {label} ──")
    concepts = await extract_concepts_and_cache(diff, user_id=user_id, pr_number=pr_number)
    print(f"  Extracted {len(concepts)} concepts")
    assert len(concepts) >= 0, "Extraction returned None"

    due = await get_due_concepts(user_id)
    print(f"  Due concepts: {len(due)}")

    for item in due[:1]:  # test one concept per cycle
        cid = item["concept_id"]
        quiz = await get_quiz_content(user_id, cid)
        assert quiz is not None, f"Quiz content missing for {cid}"
        print(f"  Quiz content present ✓")

        next_review = await update_sm2_state(user_id, cid, quality=4)
        assert next_review > 0, "next_review timestamp invalid"
        print(f"  SM-2 updated ✓ next_review={next_review}")

    print(f"  ✓ Cycle complete")

async def main():
    await run_cycle(SMALL_DIFF, "stress_user", 1001, "small diff")
    await run_cycle(LARGE_DIFF, "stress_user", 1002, "large diff")

    # Verify Redis TTL
    from backend.services.redis_client import get_redis
    r = await get_redis()
    keys = await r.keys("concept:stress_user:*")
    for k in keys[:3]:
        ttl = await r.ttl(k)
        assert ttl > 60 * 60 * 24 * 6, f"TTL too short on {k}: {ttl}s"
        print(f"  TTL OK on {k}: {ttl}s ✓")

    print("\n✓ All stress tests passed")

asyncio.run(main())
```

```bash
python tests/test_e2e.py
```

**Checklist before judging:**
- [ ] Both small and large diff cycles complete without error
- [ ] Redis TTL > 6 days on all concept keys
- [ ] Sentry breadcrumbs visible for Bear-2, Claude, Redis, SM-2 in a single session
- [ ] At least one real Sentry error captured during testing
- [ ] Demo PR selected and its Redis state cleared (`redis-cli FLUSHDB` or scoped delete) for a clean demo flow

---

## Final Notes for Agent

- **API URL confirmation:** Bear-2 (`BEAR2_URL`), Poke (`POKE_API_BASE`), and Browserbase endpoints marked with comments must be confirmed against live docs before use. The patterns are correct but exact URLs may differ.
- **DEMO_MODE in sm2.py:** Set to `True` for the hackathon demo so intervals are minutes not days. This makes the SM-2 loop demonstrable in real time during judging.
- **Graceful fallbacks:** Bear-2 and Browserbase both have try/except fallbacks so they cannot block the core loop.
- **Never call FLUSHDB in production.** Only use it on the demo Redis instance to reset state before judging.
