"""Encoding contract for concept_id.

The contract: a concept_id encodes (user, source, slug) into one string.
Two shapes — PR ("{u}:{n}:{slug}") and commit ("{u}:c-{sha_short}:{slug}").
The "c-" prefix disambiguates commits from PRs (whose middle segment is
an integer). Both halves of the contract (encoder + decoder) live in
the same module so they cannot drift.
"""
from backend.services.concept_ids import (
    ConceptIdParts,
    build_concept_id_seed,
    is_commit_source,
    is_pr_source,
    parse_concept_id,
)


class TestBuildConceptIdSeed:
    def test_int_source_yields_pr_seed_with_no_commit_sha(self):
        seed, source_type, commit_sha = build_concept_id_seed("u_1", 42)
        assert seed == "u_1:42"
        assert source_type == "pr"
        assert commit_sha == ""

    def test_string_source_yields_commit_seed_with_c_prefix_and_full_sha(self):
        seed, source_type, commit_sha = build_concept_id_seed("u_1", "abc1234567890def")
        assert seed == "u_1:c-abc1234"
        assert source_type == "commit"
        assert commit_sha == "abc1234567890def"

    def test_pr_and_commit_seeds_are_disjoint(self):
        pr_seed, _, _ = build_concept_id_seed("u", 1)
        cm_seed, _, _ = build_concept_id_seed("u", "1")
        assert pr_seed != cm_seed
        assert ":" not in cm_seed.split(":")[1].lstrip("c-") or cm_seed.split(":")[1].startswith("c-")


class TestParseConceptId:
    def test_pr_shape_returns_int_pr_number(self):
        assert parse_concept_id("u_1:42:caching") == ConceptIdParts(42, "", "pr")

    def test_commit_shape_returns_zero_pr_and_sha(self):
        assert parse_concept_id("u_1:c-abc1234:caching") == ConceptIdParts(0, "abc1234", "commit")

    def test_malformed_returns_pr_zero(self):
        # Legacy fallback: treat unknown shapes as PRs with pr_number=0.
        assert parse_concept_id("garbage").source_type == "pr"
        assert parse_concept_id("garbage").pr_number == 0

    def test_too_few_segments_returns_pr_zero(self):
        assert parse_concept_id("u_1:42").source_type == "pr"
        assert parse_concept_id("u_1:42").pr_number == 0


class TestFastPaths:
    def test_is_commit_source(self):
        assert is_commit_source("u:c-abc1234:slug") is True
        assert is_commit_source("u:42:slug") is False
        assert is_commit_source("garbage") is False

    def test_is_pr_source(self):
        assert is_pr_source("u:42:slug") is True
        assert is_pr_source("u:c-abc1234:slug") is False
        assert is_pr_source("garbage") is False


class TestRoundTrip:
    """Encoder → decoder should preserve (pr_number_or_zero, source_type)."""

    def test_pr_round_trip(self):
        seed, source_type, _ = build_concept_id_seed("u_1", 42)
        decoded = parse_concept_id(f"{seed}:slug")
        assert decoded.pr_number == 42
        assert decoded.source_type == source_type
        assert decoded.commit_sha == ""

    def test_commit_round_trip(self):
        full_sha = "abcdef0123456789"
        seed, source_type, _ = build_concept_id_seed("u_1", full_sha)
        decoded = parse_concept_id(f"{seed}:slug")
        assert decoded.pr_number == 0
        assert decoded.source_type == source_type
        assert decoded.commit_sha == full_sha[:7]
