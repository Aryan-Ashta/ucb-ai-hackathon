import { describe, expect, it } from "vitest";
import type { Concept } from "./types";
import { buildGraphFromConcepts } from "./build-graph";
import { deriveState } from "./concepts";

const base = (overrides: Partial<Concept> = {}): Concept => ({
  id: "u_1:42:memoization",
  concept: "Memoization",
  roast_text: "r",
  question_text: "q",
  answer_hint: "h",
  next_review: new Date(Date.now() - 60_000).toISOString(),
  interval: 5,
  ease_factor: 2.5,
  repetitions: 1,
  repo: "octo/cat",
  pr_number: 42,
  pr_title: "add LRU cache",
  source_type: "pr",
  ...overrides,
});

describe("buildGraphFromConcepts", () => {
  it("returns empty nodes and edges for an empty input", () => {
    expect(buildGraphFromConcepts([])).toEqual({ nodes: [], edges: [] });
  });

  it("skips commit-sourced concepts", () => {
    const cs = [
      base({ id: "u_1:c-abc:trace", source_type: "commit", pr_number: 0 }),
      base({ id: "u_1:42:caching", concept: "Caching", pr_number: 42 }),
    ];
    const { nodes, edges } = buildGraphFromConcepts(cs);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe("u_1:42:caching");
    expect(edges).toEqual([]);
  });

  it("groups concepts by PR into columns with consecutive edges", () => {
    const cs = [
      base({ id: "u_1:42:a", concept: "Alpha", pr_number: 42 }),
      base({ id: "u_1:42:b", concept: "Beta", pr_number: 42 }),
      base({ id: "u_1:7:c", concept: "Gamma", pr_number: 7, pr_title: "other" }),
    ];
    const { nodes, edges } = buildGraphFromConcepts(cs);
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.label)).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(edges).toEqual([
      ["u_1:42:a", "u_1:42:b"],
    ]);
    const pr42 = nodes.filter((n) => n.pr === 42);
    expect(pr42[0]!.x).toBe(pr42[1]!.x);
    expect(pr42[0]!.y).toBeLessThan(pr42[1]!.y);
  });

  it("derives node state from SM-2 fields", () => {
    const mastered = base({
      interval: 21,
      repetitions: 2,
      next_review: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const { nodes } = buildGraphFromConcepts([mastered]);
    expect(nodes[0]!.state).toBe(deriveState({
      nextReview: mastered.next_review,
      interval: mastered.interval,
      repetitions: mastered.repetitions,
    }));
    expect(nodes[0]!.state).toBe("mastered");
  });

  it("uses full concept id as node id", () => {
    const { nodes } = buildGraphFromConcepts([base()]);
    expect(nodes[0]!.id).toBe("u_1:42:memoization");
  });
});
