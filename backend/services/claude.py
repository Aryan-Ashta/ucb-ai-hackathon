import json
import re

import anthropic
import sentry_sdk

from backend.config import ANTHROPIC_API_KEY
from backend.models import QuizConcept
from backend.services.bear2 import compress_diff
from backend.services.redis_client import cache_quiz_content

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

MODEL = "claude-sonnet-4-6"

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


def _strip_fences(text: str) -> str:
    text = re.sub(r"^```json\s*", "", text)
    text = re.sub(r"^```\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


async def extract_concepts_and_cache(
    raw_diff: str, user_id: str, pr_number: int
) -> list[QuizConcept]:
    """
    Full ingestion pipeline:
    1. Compress diff via Bear-2
    2. Send to Claude for concept extraction
    3. Cache results in Redis
    Returns a list of QuizConcept objects.
    """
    with sentry_sdk.start_span(op="claude.extract", name="Concept extraction"):
        compressed_diff = await compress_diff(raw_diff)

        try:
            message = client.messages.create(
                model=MODEL,
                max_tokens=2048,
                system=SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": f"Extract concepts from this PR diff:\n\n{compressed_diff}",
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
                    concept_id=f"{user_id}:{pr_number}:{slug}",
                    concept=item["concept"],
                    roast_text=item["roast_text"],
                    question_text=item["question_text"],
                    answer_hint=item["answer_hint"],
                )
            )

        sentry_sdk.add_breadcrumb(
            category="claude",
            message=f"Extracted {len(concepts)} concepts from PR #{pr_number}",
            level="info",
            data={"concepts": [c.concept for c in concepts]},
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

    message = client.messages.create(
        model=MODEL,
        max_tokens=256,
        messages=[{"role": "user", "content": grading_prompt}],
    )

    return json.loads(_strip_fences(message.content[0].text.strip()))
