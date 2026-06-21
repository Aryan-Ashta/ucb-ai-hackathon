/**
 * Reusable UI components for the dashboard. Each one is a small, pure
 * "looks like..." card. No state, no effects — the dashboard passes
 * already-computed data in.
 */
import type { Concept } from "@/lib/types";
import type { PR, CommitGroup } from "@/lib/group-concepts";
import { formatDue, getDueStatus, masteryPct, mergedAgo } from "@/lib/format";

/**
 * Due-queue card — styled like a git diff hunk.
 * Left accent bar: coral = overdue, marigold = due today.
 */
export function DueCard({ concept }: { concept: Concept & { prTitle: string } }) {
  const status = getDueStatus(concept.next_review);
  const isOverdue = status === "overdue";
  // Trace 3 L2: legacy data has source_type undefined. Fall back to the
  // c- prefix in the concept_id to disambiguate commit-sourced rows that
  // were ingested before source_type was written.
  const isCommit = concept.source_type === "commit" || concept.id.includes(":c-");
  const shortSha = concept.commit_sha ? concept.commit_sha.slice(0, 7) : "";
  const provenance = isCommit
    ? `${concept.repo}@${shortSha}`
    : `${concept.repo}#${concept.pr_number}`;

  return (
    <a
      href={`/quiz/${encodeURIComponent(concept.id)}`}
      className={`group flex items-center gap-4 rounded-xl bg-surface-1 border border-line border-l-2 px-4 py-3.5 hover:bg-surface-2 transition-colors ${
        isOverdue ? "border-l-coral" : "border-l-marigold"
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-ink group-hover:text-marigold transition-colors truncate">
          {concept.concept}
        </p>
        <p className="font-mono text-[11px] text-ink-faint truncate mt-0.5">
          {provenance} · {concept.prTitle}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`font-mono text-xs tabular-nums ${isOverdue ? "text-coral" : "text-marigold"}`}>
          {formatDue(concept.next_review)}
        </span>
        <span className="text-ink-faint group-hover:text-ink transition-colors text-sm">→</span>
      </div>
    </a>
  );
}

/** Compact concept row inside a PR block. */
export function ConceptRow({ concept }: { concept: Concept }) {
  const status = getDueStatus(concept.next_review);
  const pct = masteryPct(concept.interval);

  return (
    <a
      href={`/quiz/${encodeURIComponent(concept.id)}`}
      className="group flex items-center gap-3 rounded-lg bg-surface-2 hover:bg-line border border-line px-3 py-2.5 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink group-hover:text-marigold transition-colors truncate">
          {concept.concept}
        </p>
        <div className="flex items-center gap-2 mt-1.5">
          <div className="h-[3px] w-20 rounded-full bg-canvas overflow-hidden">
            <div
              className="h-full rounded-full bg-marigold transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="font-mono text-[10px] text-ink-faint tabular-nums">{pct}%</span>
        </div>
      </div>
      <span
        className={`font-mono text-[11px] shrink-0 tabular-nums ${
          status === "overdue" ? "text-coral" : status === "today" ? "text-marigold" : "text-ink-faint"
        }`}
      >
        {formatDue(concept.next_review)}
      </span>
    </a>
  );
}

/** PR block: compact header + concept rows. */
export function PRBlock({ pr }: { pr: PR }) {
  return (
    <div className="rounded-2xl bg-surface-1 border border-line overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-line">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-ink-faint mb-0.5">
            {pr.repo}
            <span className="text-ink-dim"> #{pr.pr_number}</span>
            {" · "}merged {mergedAgo(pr.merged_at)}
          </p>
          <h2 className="font-semibold text-ink text-sm truncate">{pr.title}</h2>
        </div>
        <span className="shrink-0 font-mono text-[11px] bg-surface-2 text-ink-faint px-2 py-0.5 rounded border border-line">
          {pr.concepts.length}c
        </span>
      </div>
      <div className="p-3 flex flex-col gap-2">
        {pr.concepts.map((c) => (
          <ConceptRow key={c.id} concept={c} />
        ))}
      </div>
    </div>
  );
}

/** Commit block: leaner than PRBlock — no merged-at date, just commit
 *  SHAs as the unit of provenance. Multiple commits from the same repo
 *  roll up into one block so a user with 100 commits doesn't see 100
 *  separate cards. */
export function CommitBlock({ group }: { group: CommitGroup }) {
  return (
    <div className="rounded-2xl bg-surface-1 border border-line overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-line">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-ink-faint">
            {group.repo}
            <span className="text-ink-dim"> · recent commits</span>
          </p>
          <h2 className="font-semibold text-ink text-sm truncate">
            {group.concepts.length} commit{group.concepts.length === 1 ? "" : "s"} ingested
          </h2>
        </div>
        <span className="shrink-0 font-mono text-[11px] bg-surface-2 text-ink-faint px-2 py-0.5 rounded border border-line">
          {group.concepts.length}c
        </span>
      </div>
      <div className="p-3 flex flex-col gap-2">
        {group.concepts.map((c) => (
          <CommitRow key={c.id} concept={c} />
        ))}
      </div>
    </div>
  );
}

/** Compact concept row inside a CommitBlock — shows the short SHA prominently
 *  since there's no PR number to anchor the row. */
export function CommitRow({ concept }: { concept: Concept }) {
  const status = getDueStatus(concept.next_review);
  const pct = masteryPct(concept.interval);
  const shortSha = concept.commit_sha ? concept.commit_sha.slice(0, 7) : "";

  return (
    <a
      href={`/quiz/${encodeURIComponent(concept.id)}`}
      className="group flex items-center gap-3 rounded-lg bg-surface-2 hover:bg-line border border-line px-3 py-2.5 transition-colors"
    >
      <span className="font-mono text-[11px] text-marigold shrink-0 tabular-nums" title={concept.commit_sha}>
        {shortSha}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink group-hover:text-marigold transition-colors truncate">
          {concept.concept}
        </p>
        <div className="flex items-center gap-2 mt-1.5">
          <div className="h-[3px] w-20 rounded-full bg-canvas overflow-hidden">
            <div
              className="h-full rounded-full bg-marigold transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="font-mono text-[10px] text-ink-faint tabular-nums">{pct}%</span>
        </div>
      </div>
      <span
        className={`font-mono text-[11px] shrink-0 tabular-nums ${
          status === "overdue" ? "text-coral" : status === "today" ? "text-marigold" : "text-ink-faint"
        }`}
      >
        {formatDue(concept.next_review)}
      </span>
    </a>
  );
}

/** Section divider: mono eyebrow + hairline rule. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint whitespace-nowrap">
        {children}
      </span>
      <div className="flex-1 h-px bg-line" />
    </div>
  );
}
