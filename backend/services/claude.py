import json
import re

import anthropic
import sentry_sdk

import backend.config as config
from backend.models import QuizConcept
from backend.services.bear2 import compress_diff
from backend.services.concept_ids import build_concept_id_seed
from backend.services.redis_client import cache_quiz_content
from backend.services import vector_store

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


# Suffix appended to the system prompt when prior_examples are
# available. The few-shot anchor matches the user's existing voice
# so new roasts feel like they came from the same examiner.
_PRIOR_EXAMPLES_SUFFIX = """

PRIOR EXAMPLES FROM THIS USER'S HISTORY
(These are the user's previous concepts and roasts on related topics.
Match the voice, vocabulary, and level of specificity. Do NOT duplicate
the exact wording — write a fresh roast that fits the new diff.)

{examples_block}
"""


def _format_prior_examples(examples) -> str:
    """Render a list of similar-concept dicts into a few-shot block.

    Examples are kept short (concept name + first 200 chars of roast)
    so the total prompt grows by ~1KB even at k=5.
    """
    if not examples:
        return ""
    lines: list[str] = []
    for ex in examples:
        name = ex.get("concept_name", "(unnamed)")
        roast = (ex.get("roast_text", "") or "")[:200]
        src = ex.get("source_type", "")
        prov = ex.get("pr_number_or_sha", "")
        repo = ex.get("repo", "")
        score = ex.get("score", 0)
        lines.append(
            f"- {name} (similarity={score:.2f}, {src} {prov}, {repo}): {roast}"
        )
    return "\n".join(lines)


def _strip_fences(text: str) -> str:
    text = re.sub(r"^```json\s*", "", text)
    text = re.sub(r"^```\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _parse_json_envelope(raw_text: str, *, breadcrumb_label: str) -> object | None:
    """Strip Claude's occasional markdown fences and JSON-decode the result.

    On parse failure: capture the exception to Sentry, emit a breadcrumb
    tagged with `breadcrumb_label` so the team can tell which call site
    produced the malformed response, and return None so the caller can
    pick its own fallback (extraction returns [], grading returns a
    generic fail).

    Pure function (no I/O beyond Sentry SDK calls) — testable in isolation.
    """
    raw_response = _strip_fences(raw_text.strip())
    try:
        return json.loads(raw_response)
    except json.JSONDecodeError as e:
        sentry_sdk.capture_exception(e)
        sentry_sdk.add_breadcrumb(
            category="claude",
            message=f"JSON parse failed [{breadcrumb_label}]. Raw response: {raw_response[:200]}",
            level="error",
        )
        return None


async def extract_concepts_and_cache(
    raw_diff: str, user_id: str, source_id: int | str,
    repo: str = "", pr_title: str = "",
    prior_examples: list | None = None,
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
    concept_id_seed, source_type, commit_sha = build_concept_id_seed(user_id, source_id)

    # Build the system prompt with optional prior_examples appended as
    # few-shot anchors. When prior_examples is None or empty, this is
    # a no-op — the prompt is the original SYSTEM_PROMPT.
    system_prompt = SYSTEM_PROMPT
    if prior_examples:
        examples_block = _format_prior_examples(prior_examples)
        system_prompt = SYSTEM_PROMPT + _PRIOR_EXAMPLES_SUFFIX.format(
            examples_block=examples_block
        )

    with sentry_sdk.start_span(op="claude.extract", name="Concept extraction"):
        compressed_diff = await compress_diff(raw_diff)

        try:
            message = await client.messages.create(
                model=MODEL,
                max_tokens=2048,
                system=system_prompt,
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

        parsed = _parse_json_envelope(message.content[0].text, breadcrumb_label="extract")
        if not isinstance(parsed, list):
            # Empty list (trivially parseable but no concepts) is also fine;
            # this branch only catches JSON failures (parsed is None) and
            # unexpected shapes (a JSON object instead of a list).
            return []

        concepts = []
        for item in parsed:
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

        # Cache each concept's quiz content (per-concept Redis keys for
        # due-set + state, can't batch — each has its own SM-2 slot).
        for concept in concepts:
            await cache_quiz_content(user_id, concept)

        # Batch-index ALL extracted concepts in a single vector-store
        # write → one Voyage HTTP call per source item instead of N
        # (Trace 1 H2). HSET is idempotent so re-running on the same
        # source is safe.
        if concepts:
            index_items = []
            for c in concepts:
                # The vector-store contract expects a flat dict per item.
                # Pull source_type + pr_number_or_sha out of the concept_id
                # so the index row matches what _schedule_vector_index used
                # to write before the batch refactor.
                cid = c.concept_id
                # cid shape: "{user_id}:{pr_number|c-sha_short}:{slug}"
                segs = cid.split(":")
                if len(segs) >= 3 and segs[1].isdigit():
                    pr_or_sha = str(segs[1])
                elif len(segs) >= 3 and segs[1].startswith("c-"):
                    pr_or_sha = segs[1][2:]
                else:
                    pr_or_sha = ""
                index_items.append({
                    "concept_id": c.concept_id,
                    "concept_name": c.concept,
                    "roast_text": c.roast_text,
                    "question_text": c.question_text,
                    "source_type": c.source_type,
                    "pr_number_or_sha": pr_or_sha,
                    "repo": c.repo,
                })
            try:
                await vector_store.index_concepts_batch(user_id, index_items)
            except Exception as e:
                # vector_store already captures to Sentry; this is a final
                # safety net so a vector failure never blocks ingestion.
                sentry_sdk.capture_exception(e)

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

    parsed = _parse_json_envelope(message.content[0].text, breadcrumb_label="grade")
    if not isinstance(parsed, dict):
        return {"passed": False, "quality": 0, "explanation": "Grading failed — please try again."}

    result = parsed
    q = max(0, min(5, int(result["quality"])))
    result["quality"] = q
    result["passed"] = bool(result.get("passed", q >= 3))
    return result
