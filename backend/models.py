from typing import List

from pydantic import BaseModel


class QuizConcept(BaseModel):
    concept_id: str          # "{user_id}:{pr_number}:{slug}"
    concept: str             # human-readable name, e.g. "memoization"
    roast_text: str          # savage but educational roast of the code
    question_text: str       # the quiz question
    answer_hint: str         # comma-separated keywords for grading
    repo: str = ""           # "{owner}/{repo}" — stored for the dashboard PR grouping
    pr_title: str = ""       # PR title — stored for display


class ConceptList(BaseModel):
    concepts: List[QuizConcept]
