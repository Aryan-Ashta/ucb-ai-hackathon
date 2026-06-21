"""Single source of truth for concept_id encoding.

A concept_id encodes (user, source, slug) into one string. Two valid shapes:

  PR:     "{user_id}:{pr_number}:{slug}"
  commit: "{user_id}:c-{sha_short}:{slug}"

The "c-" prefix on commit ids is the disambiguator that lets the existing
pr_number extraction in the dashboard / quiz code fall through cleanly:
the middle segment is "c-abc1234", not an int, so `parse_concept_id`
returns pr_number=0 for commit-sourced concepts.

This module owns the contract — both the encoder (`build_concept_id_seed`)
and the decoder (`parse_concept_id`) live here so the two halves can
never drift apart.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class ConceptIdParts:
    """Decoded view of a concept_id."""
    pr_number: int  # 0 for commit-sourced concepts
    commit_sha: str  # full SHA when source_type="commit", else ""
    source_type: str  # "pr" or "commit"


def build_concept_id_seed(user_id: str, source_id: int | str) -> tuple[str, str, str]:
    """Build (concept_id_seed, source_type, commit_sha) from a source identifier.

    A source_id is either:
      - an int (PR number)            → source_type="pr",     commit_sha=""
      - a string (full commit SHA)    → source_type="commit", commit_sha=<sha>

    The concept_id seed is the per-source identifier that gets the slug
    appended to form the full concept_id (e.g. "42:caching",
    "42:c-abc1234:caching").

    Returns (seed, source_type, commit_sha). Callers append ":{slug}"
    themselves so they can keep the slug derivation next to the LLM
    response handling.
    """
    if isinstance(source_id, int):
        return (f"{user_id}:{source_id}", "pr", "")
    return (f"{user_id}:c-{source_id[:7]}", "commit", source_id)


def parse_concept_id(concept_id: str) -> ConceptIdParts:
    """Extract (pr_number, commit_sha, source_type) from a concept_id.

    Two valid shapes:
      - PR:    "{user_id}:{pr_number}:{slug}"             → (int, "", "pr")
      - commit:"{user_id}:c-{sha_short}:{slug}"          → (0, sha_short, "commit")

    Returns pr_number=0, commit_sha="", source_type="pr" for malformed
    inputs (preserves the legacy behavior the dashboard relies on).
    """
    parts = concept_id.split(":")
    if len(parts) >= 3 and parts[1].isdigit():
        return ConceptIdParts(int(parts[1]), "", "pr")
    if len(parts) >= 3 and parts[1].startswith("c-"):
        return ConceptIdParts(0, parts[1][2:], "commit")
    return ConceptIdParts(0, "", "pr")


def is_commit_source(concept_id: str) -> bool:
    """Fast-path check used by the dashboard groupByCommit filter."""
    parts = concept_id.split(":")
    return len(parts) >= 3 and parts[1].startswith("c-")


def is_pr_source(concept_id: str) -> bool:
    """Fast-path check used by the dashboard groupByPR filter."""
    parts = concept_id.split(":")
    return len(parts) >= 3 and parts[1].isdigit()
