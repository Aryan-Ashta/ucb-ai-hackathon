import { describe, expect, it } from "vitest";
import type { Concept } from "./types";
import { groupByCommit, groupByPR } from "./group-concepts";

const base = (overrides: Partial<Concept> = {}): Concept => ({
  id: "u_1:42:caching",
  concept: "Memoization",
  roast_text: "r",
  question_text: "q",
  answer_hint: "h",
  next_review: new Date().toISOString(),
  interval: 1,
  ease_factor: 2.5,
  repetitions: 0,
  ...overrides,
});

describe("groupByPR", () => {
  it("returns [] for an empty input", () => {
    expect(groupByPR([])).toEqual([]);
  });

  it("groups PR-sourced concepts by pr_number and preserves order", () => {
    const cs: Concept[] = [
      base({ id: "u:42:a", pr_number: 42 }),
      base({ id: "u:42:b", pr_number: 42 }),
      base({ id: "u:7:c", pr_number: 7 }),
    ];
    const groups = groupByPR(cs);
    expect(groups.map((g) => g.pr_number)).toEqual([42, 7]);
    expect(groups[0].concepts).toHaveLength(2);
    expect(groups[1].concepts).toHaveLength(1);
  });

  it("skips commit-sourced concepts", () => {
    const cs: Concept[] = [
      base({ id: "u:c-aa:c", source_type: "commit", pr_number: 0, repo: "r" }),
      base({ id: "u:5:b", pr_number: 5 }),
    ];
    const groups = groupByPR(cs);
    expect(groups.map((g) => g.pr_number)).toEqual([5]);
  });

  it("uses the first concept's repo and title for the group", () => {
    const cs: Concept[] = [
      base({ id: "u:1:a", pr_number: 1, repo: "owner/repo", pr_title: "First" }),
      base({ id: "u:1:b", pr_number: 1, repo: "owner/repo", pr_title: "ignored" }),
    ];
    const [g] = groupByPR(cs);
    expect(g.repo).toBe("owner/repo");
    expect(g.title).toBe("First");
  });

  it("prefers the backend's real merged_at over the fallback placeholder", () => {
    // P2-D2 (Trace H2): when the backend includes merged_at on at least
    // one concept (e.g. the first), the group must use it instead of
    // synthesizing a fixed "2 days ago".
    const real = "2026-06-20T09:30:00+00:00";
    const cs: Concept[] = [
      base({ id: "u:7:a", pr_number: 7, repo: "r", pr_title: "PR", merged_at: real }),
      base({ id: "u:7:b", pr_number: 7, repo: "r", pr_title: "PR" }),
    ];
    const [g] = groupByPR(cs);
    expect(g.merged_at).toBe(real);
  });

  it("falls back to '2 days ago' placeholder when no concept carries merged_at", () => {
    // Legacy concepts (pre-merged_at ingestion) have no merged_at field.
    // The group must still produce a non-empty ISO string so the PRBlock
    // header renders sensibly.
    const before = Date.now();
    const cs: Concept[] = [
      base({ id: "u:8:a", pr_number: 8, repo: "r", pr_title: "PR" }),
    ];
    const [g] = groupByPR(cs);
    expect(g.merged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Roughly 2 days ago (allow a few seconds of drift).
    const ts = new Date(g.merged_at).getTime();
    expect(ts).toBeGreaterThan(before - 2 * 24 * 60 * 60 * 1000 - 5000);
    expect(ts).toBeLessThan(before - 2 * 24 * 60 * 60 * 1000 + 5000);
  });

  it("falls back to 'PR #N' when title is missing", () => {
    const [g] = groupByPR([base({ id: "u:9:x", pr_number: 9 })]);
    expect(g.title).toBe("PR #9");
  });
});

describe("groupByCommit", () => {
  it("returns [] when there are no commit-sourced concepts", () => {
    expect(groupByCommit([base({ source_type: "pr" })])).toEqual([]);
  });

  it("groups by repo, sorts SHAs ascending within each group", () => {
    const cs: Concept[] = [
      base({ id: "u:c-z:r1", source_type: "commit", repo: "r1", commit_sha: "z9z9z9z" }),
      base({ id: "u:c-a:r1", source_type: "commit", repo: "r1", commit_sha: "a1a1a1a" }),
      base({ id: "u:c-m:r1", source_type: "commit", repo: "r1", commit_sha: "m5m5m5m" }),
      base({ id: "u:c-q:r2", source_type: "commit", repo: "r2", commit_sha: "q0q0q0q" }),
    ];
    const groups = groupByCommit(cs);
    expect(groups.map((g) => g.repo)).toEqual(["r1", "r2"]);
    // Trace 3 L1: input order wins (deterministic from zrange), NOT alphabetical.
    // The previous localeCompare on commit_sha was alphabetical noise.
    expect(groups[0].concepts.map((c) => c.commit_sha)).toEqual(["z9z9z9z", "a1a1a1a", "m5m5m5m"]);
    expect(groups[1].concepts).toHaveLength(1);
  });

  it("treats a missing repo as '(unknown repo)'", () => {
    const [g] = groupByCommit([base({ id: "u:c-a:x", source_type: "commit", repo: undefined, commit_sha: "z" })]);
    expect(g.repo).toBe("(unknown repo)");
  });
});
