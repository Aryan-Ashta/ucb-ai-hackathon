import json
import re

import anthropic
import sentry_sdk

import backend.config as config
from backend.models import QuizConcept
from backend.services.bear2 import compress_diff
from backend.services.redis_client import cache_quiz_content

# Client construction is conditional on USE_TOKENROUTER (see backend/config.py):
#   • USE_TOKENROUTER unset/false → direct Anthropic (api.anthropic.com)
#   • USE_TOKENROUTER=true        → tokenrouter.com (Anthropic-compatible proxy)
# The SDK auto-appends /v1/messages to base_url, so we pass the bare origin.
client = anthropic.AsyncAnthropic(
    api_key=config.TOKENROUTER_API_KEY if config.USE_TOKENROUTER else config.ANTHROPIC_API_KEY,
    base_url=config.TOKENROUTER_BASE_URL if config.USE_TOKENROUTER else None,
)

# Model name is env-overridable so tokenrouter-prefixed names (e.g.
# "anthropic/claude-sonnet-4-6") can be set without touching code.
MODEL = config.ANTHROPIC_MODEL

SYSTEM_PROMPT = """You are VibeSchool, a savage but educational code reviewer.
Given a GitHub diff (either a PR or a single commit), you:
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


def _strip_fences(text: str) -> str:
    text = re.sub(r"^```json\s*", "", text)
    text = re.sub(r"^```\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _build_concept_id(user_id: str, source_id: int | str) -> tuple[str, str, str]:
    """Build (concept_id_seed, source_type, commit_sha) from a source identifier.

    A source_id is either:
      - an int (PR number)            → source_type="pr",     commit_sha=""
      - a string (full commit SHA)    → source_type="commit", commit_sha=<sha>

    The concept_id seed is the per-source identifier that gets the slug
    appended to form the full concept_id (e.g. "42:101:caching",
    "42:c-abc1234:caching"). The "c-" prefix on commit ids prevents the
    existing pr_number extraction in redis_client.py from choking — the
    middle segment is "c-abc1234", not an int, so pr_number falls through
    to 0 cleanly.
    """
    if isinstance(source_id, int):
        return (f"{user_id}:{source_id}", "pr", "")
    return (f"{user_id}:c-{source_id[:7]}", "commit", source_id)


async def extract_concepts_and_cache(
    raw_diff: str, user_id: str, source_id: int | str,
    repo: str = "", pr_title: str = "",
) -> list[QuizConcept]:
    """
    Full ingestion pipeline:
    1. Compress diff via Bear-2
    2. Send to Claude for concept extraction
    3. Cache results in Redis
    Returns a list of QuizConcept objects.

    `source_id` discriminates PR from commit:
      - int   → PR number; concepts are tagged source_type="pr"
      - str   → full commit SHA; concepts are tagged source_type="commit"
    """
    concept_id_seed, source_type, commit_sha = _build_concept_id(user_id, source_id)

    with sentry_sdk.start_span(op="claude.extract", name="Concept extraction"):
        compressed_diff = await compress_diff(raw_diff)

        try:
            message = await client.messages.create(
                model=MODEL,
                max_tokens=2048,
                system=SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": f"Extract concepts from this diff:\n\n{compressed_diff}",
                    }
                ],
            )
        except Exception as e:
            sentry_sdk.capture_exception(e)
            raise

        raw_response = _strip_fences(message.content[0].text.strip())

        try:
            concepts_data = json.loads(raw_response)
        except json.JSONDecodeError as e:
            sentry_sdk.capture_exception(e)
            sentry_sdk.add_breadcrumb(
                category="claude",
                message=f"JSON parse failed. Raw response: {raw_response[:200]}",
                level="error",
            )
            return []

        concepts = []
        for item in concepts_data:
            slug = item["concept"].lower().replace(" ", "_")
            concepts.append(
                QuizConcept(
                    concept_id=f"{concept_id_seed}:{slug}",
                    concept=item["concept"],
                    roast_text=item["roast_text"],
                    question_text=item["question_text"],
                    answer_hint=item["answer_hint"],
                    repo=repo,
                    pr_title=pr_title,
                    source_type=source_type,
                    commit_sha=commit_sha,
                )
            )

        sentry_sdk.add_breadcrumb(
            category="claude",
            message=f"Extracted {len(concepts)} concepts from {source_type} {source_id}",
            level="info",
            data={"concepts": [c.concept for c in concepts], "source_type": source_type},
        )

        for concept in concepts:
            await cache_quiz_content(user_id, concept)

        return concepts


async def grade_answer(question_text: str, answer_hint: str, transcript: str) -> dict:
    """
    Grade a spoken answer against the expected concept.
    Returns {passed: bool, quality: int (0-5), explanation: str}.
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

    message = await client.messages.create(
        model=MODEL,
        max_tokens=256,
        messages=[{"role": "user", "content": grading_prompt}],
    )

    raw_response = _strip_fences(message.content[0].text.strip())
    try:
        result = json.loads(raw_response)
    except json.JSONDecodeError as e:
        sentry_sdk.capture_exception(e)
        sentry_sdk.add_breadcrumb(
            category="claude",
            message=f"JSON parse failed. Raw response: {raw_response[:200]}",
            level="error",
        )
        return {"passed": False, "quality": 0, "explanation": "Grading failed — please try again."}

    q = max(0, min(5, int(result["quality"])))
    result["quality"] = q
    result["passed"] = bool(result.get("passed", q >= 3))
    return result
