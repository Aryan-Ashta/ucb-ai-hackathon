from typing import List

from pydantic import BaseModel


class QuizConcept(BaseModel):
    concept_id: str          # "{user_id}:{pr_number}:{slug}" or "{user_id}:c-{sha_short}:{slug}"
    concept: str             # human-readable name, e.g. "memoization"
    roast_text: str          # savage but educational roast of the code
    question_text: str       # the quiz question
    answer_hint: str         # comma-separated keywords for grading
    repo: str = ""           # "{owner}/{repo}" — stored for the dashboard PR grouping
    pr_title: str = ""       # PR title — stored for display
    # P2: distinguish PR-sourced concepts from commit-sourced concepts so the
    # dashboard can render leaner cards for commits and the demo doesn't
    # require merged-PR-only repos. Both kinds flow through the same Bear-2 →
    # Claude → Redis pipeline; the only difference is provenance.
    source_type: str = "pr"  # "pr" or "commit"
    commit_sha: str = ""     # full SHA when source_type="commit"; empty for PRs


class ConceptList(BaseModel):
    concepts: List[QuizConcept] | None = None
