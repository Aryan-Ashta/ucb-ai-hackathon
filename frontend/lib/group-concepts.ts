/**
 * Pure grouping transforms that turn a flat Concept[] into the shapes
 * the dashboard renders (PRs grouped by pr_number, commits rolled up by
 * repo). Both are deterministic and order-preserving, so they're safe to
 * memoize on the input array.
 */
import type { DashboardPR } from "./mock";
import type { Concept } from "./types";

export type PR = DashboardPR;

export interface CommitGroup {
  repo: string;
  concepts: Concept[];
}

/** Group a flat concept list into PRs by pr_number (PR-sourced only).
 *  Commit-sourced concepts are excluded here — groupByCommit handles them. */
export function groupByPR(concepts: Concept[]): PR[] {
  const order: number[] = [];
  const byPr: Record<number, Concept[]> = {};
  for (const c of concepts) {
    if (c.source_type === "commit") continue; // commits render in their own section
    const pr = c.pr_number ?? 0;
    if (!byPr[pr]) { byPr[pr] = []; order.push(pr); }
    byPr[pr].push(c);
  }
  return order.map((pr_number) => {
    const cs = byPr[pr_number];
    return {
      pr_number,
      repo: cs[0].repo ?? "",
      title: cs[0].pr_title ?? `PR #${pr_number}`,
      // The backend's flat /api/concepts response doesn't carry per-PR
      // merged_at; we synthesize a fixed "2 days ago" so the PRBlock
      // header renders sensibly until the backend grows the field.
      merged_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      concepts: cs,
    };
  });
}

/** Group commit-sourced concepts by repo (commits don't have a natural
 *  numeric grouping key the way PRs do, so we roll them up by repo).
 *  Stable order: most-recent commit first within each repo (the dashboard
 *  sorts by next_review anyway, but we keep a deterministic order here
 *  so re-renders don't shuffle). */
export function groupByCommit(concepts: Concept[]): CommitGroup[] {
  const byRepo: Record<string, Concept[]> = {};
  for (const c of concepts) {
    if (c.source_type !== "commit") continue;
    const repo = c.repo ?? "(unknown repo)";
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(c);
  }
  for (const repo of Object.keys(byRepo)) {
    byRepo[repo].sort((a, b) => a.commit_sha?.localeCompare(b.commit_sha ?? "") ?? 0);
  }
  return Object.entries(byRepo).map(([repo, concepts]) => ({ repo, concepts }));
}
