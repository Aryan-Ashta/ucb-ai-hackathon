import { deriveState, type ConceptState } from "./concepts";
import type { Concept } from "./types";

export interface GraphNode {
  id: string;
  label: string;
  x: number;
  y: number;
  state: ConceptState;
  pr: number;
  prTitle: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: [string, string][];
}

const VIEW_W = 820;
const ROW_SPACING = 80;
const START_Y = 90;

/** Build a PR-column concept graph from synced concepts (skips commit-sourced rows). */
export function buildGraphFromConcepts(concepts: Concept[]): GraphData {
  const prConcepts = concepts.filter((c) => c.source_type !== "commit");
  if (prConcepts.length === 0) {
    return { nodes: [], edges: [] };
  }

  const byPr = new Map<number, Concept[]>();
  for (const c of prConcepts) {
    const pr = c.pr_number ?? 0;
    const group = byPr.get(pr);
    if (group) group.push(c);
    else byPr.set(pr, [c]);
  }

  const prNumbers = Array.from(byPr.keys()).sort((a, b) => a - b);
  const colCount = prNumbers.length;
  const colSpacing = colCount > 1 ? VIEW_W / (colCount + 1) : VIEW_W / 2;

  const nodes: GraphNode[] = [];
  const edges: [string, string][] = [];

  for (let colIdx = 0; colIdx < prNumbers.length; colIdx++) {
    const prNum = prNumbers[colIdx]!;
    const group = byPr.get(prNum)!;
    const x = colSpacing * (colIdx + 1);

    for (let rowIdx = 0; rowIdx < group.length; rowIdx++) {
      const concept = group[rowIdx]!;
      nodes.push({
        id: concept.id,
        label: concept.concept,
        x,
        y: START_Y + rowIdx * ROW_SPACING,
        state: deriveState({
          nextReview: concept.next_review,
          interval: concept.interval,
          repetitions: concept.repetitions,
        }),
        pr: prNum,
        prTitle: concept.pr_title ?? "",
      });
    }

    for (let i = 0; i < group.length - 1; i++) {
      edges.push([group[i]!.id, group[i + 1]!.id]);
    }
  }

  return { nodes, edges };
}
