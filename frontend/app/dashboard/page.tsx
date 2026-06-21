"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getMockPRs, type DashboardPR } from "@/lib/mock";
import type { Concept } from "@/lib/types";
import { api, USING_MOCK } from "@/lib/api";

type PR = DashboardPR;

// --- Time helpers ---

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function getDueStatus(nextReview: string): "overdue" | "today" | "upcoming" {
  const diff = new Date(nextReview).getTime() - Date.now();
  if (diff < 0) return "overdue";
  if (diff < DAY) return "today";
  return "upcoming";
}

function formatDue(nextReview: string): string {
  const diff = new Date(nextReview).getTime() - Date.now();
  if (diff < 0) {
    const ago = Math.abs(diff);
    if (ago < HOUR) return `${Math.floor(ago / MIN)}m overdue`;
    if (ago < DAY) return `${Math.floor(ago / HOUR)}h overdue`;
    return `${Math.floor(ago / DAY)}d overdue`;
  }
  if (diff < HOUR) return `in ${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `in ${Math.floor(diff / HOUR)}h`;
  return `in ${Math.floor(diff / DAY)}d`;
}

function mergedAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < HOUR) return "just now";
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const d = Math.floor(diff / DAY);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

function masteryPct(interval: number): number {
  return Math.min(Math.round((interval / 30) * 100), 100);
}

/** Group a flat concept list into DashboardPRs by pr_number. */
function groupByPR(concepts: Concept[]): PR[] {
  const order: number[] = [];
  const byPr: Record<number, Concept[]> = {};
  for (const c of concepts) {
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
      merged_at: new Date(Date.now() - 2 * DAY).toISOString(),
      concepts: cs,
    };
  });
}

// --- Components ---

/**
 * Due-queue card — styled like a git diff hunk.
 * Left accent bar: coral = overdue, marigold = due today.
 */
function DueCard({ concept }: { concept: Concept & { prTitle: string } }) {
  const status = getDueStatus(concept.next_review);
  const isOverdue = status === "overdue";

  return (
    <a
      href={`/quiz/${concept.id}`}
      className={`group flex items-center gap-4 rounded-xl bg-surface-1 border border-line border-l-2 px-4 py-3.5 hover:bg-surface-2 transition-colors ${
        isOverdue ? "border-l-coral" : "border-l-marigold"
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-ink group-hover:text-marigold transition-colors truncate">
          {concept.concept}
        </p>
        <p className="font-mono text-[11px] text-ink-faint truncate mt-0.5">
          {concept.repo}#{concept.pr_number} · {concept.prTitle}
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
function ConceptRow({ concept }: { concept: Concept }) {
  const status = getDueStatus(concept.next_review);
  const pct = masteryPct(concept.interval);

  return (
    <a
      href={`/quiz/${concept.id}`}
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
function PRBlock({ pr }: { pr: PR }) {
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

/** Section divider: mono eyebrow + hairline rule. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint whitespace-nowrap">
        {children}
      </span>
      <div className="flex-1 h-px bg-line" />
    </div>
  );
}

// --- Page ---

export default function Dashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [prs, setPrs] = useState<PR[]>(USING_MOCK ? getMockPRs() : []);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(!USING_MOCK);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
  }, [status, router]);

  // Live backend: fetch due concepts and group into PRs
  useEffect(() => {
    if (USING_MOCK || status !== "authenticated" || !session?.accessToken) return;
    const ctrl = new AbortController();
    setFetching(true);
    setFetchError(null);
    api
      .listDueConcepts(session.accessToken, ctrl.signal)
      .then((data) => setPrs(groupByPR(data.due)))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setFetchError(err instanceof Error ? err.message : "Failed to load concepts");
      })
      .finally(() => setFetching(false));
    return () => ctrl.abort();
  }, [status, session?.accessToken]);

  if (status === "loading" || !session) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <span className="font-mono text-sm text-ink-faint animate-pulse">loading…</span>
      </div>
    );
  }

  const dueItems = prs
    .flatMap((pr) =>
      pr.concepts
        .filter((c) => getDueStatus(c.next_review) !== "upcoming")
        .map((c) => ({ ...c, prTitle: pr.title }))
    )
    .sort((a, b) => new Date(a.next_review).getTime() - new Date(b.next_review).getTime());

  const overdueCount = dueItems.filter((c) => getDueStatus(c.next_review) === "overdue").length;
  const totalConcepts = prs.reduce((n, pr) => n + pr.concepts.length, 0);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line">
        <div className="max-w-3xl mx-auto px-5 py-3 flex items-center gap-3">
          <span className="font-display text-lg font-bold tracking-tight">VibeSchool</span>
          <div className="flex-1" />
          {session.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt={session.user.name ?? "avatar"}
              className="w-7 h-7 rounded-full border border-line"
            />
          )}
          <span className="text-sm text-ink-dim hidden sm:block">{session.user?.name}</span>
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="font-mono text-xs text-ink-faint hover:text-ink-dim transition-colors"
          >
            sign out
          </button>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-5 py-10 flex flex-col gap-12">
        {/* Hero */}
        <div className="animate-rise">
          <div className="flex items-end gap-3 mb-3">
            <span className="font-display text-[4.5rem] leading-none font-extrabold text-marigold tabular-nums tracking-tightest">
              {fetching ? "…" : dueItems.length}
            </span>
            <span className="font-display text-2xl font-bold text-ink-dim pb-2">
              {dueItems.length === 1 ? "concept to review" : "concepts to review"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {overdueCount > 0 && (
              <span className="font-mono text-xs bg-coral/10 border border-coral/25 text-coral px-2.5 py-1 rounded-lg">
                {overdueCount} overdue
              </span>
            )}
            {totalConcepts > 0 && (
              <span className="font-mono text-xs bg-surface-2 border border-line text-ink-dim px-2.5 py-1 rounded-lg">
                {totalConcepts} concepts tracked
              </span>
            )}
            {prs.length > 0 && (
              <span className="font-mono text-xs bg-surface-2 border border-line text-ink-dim px-2.5 py-1 rounded-lg">
                {prs.length} PRs
              </span>
            )}
          </div>
        </div>

        {/* Fetch error */}
        {fetchError && (
          <div className="rounded-2xl bg-surface-1 border border-coral/30 px-5 py-4">
            <p className="font-mono text-xs text-coral mb-1">failed to load concepts</p>
            <p className="font-mono text-[11px] text-ink-faint">{fetchError}</p>
          </div>
        )}

        {/* Due queue */}
        <section>
          <SectionLabel>
            {dueItems.length > 0 ? `due now · ${dueItems.length}` : "due now"}
          </SectionLabel>
          {fetching ? (
            <div className="py-10 text-center font-mono text-sm text-ink-faint animate-pulse">
              loading…
            </div>
          ) : dueItems.length > 0 ? (
            <div className="flex flex-col gap-2">
              {dueItems.map((c) => (
                <DueCard key={c.id} concept={c} />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl bg-surface-1 border border-line px-6 py-10 text-center">
              <p className="font-display text-2xl font-bold text-ink mb-1">All clear.</p>
              <p className="text-sm text-ink-dim">
                Nothing due right now — check back later, or browse your concept bank below.
              </p>
            </div>
          )}
        </section>

        {/* All concepts, grouped by PR */}
        {prs.length > 0 && (
          <section>
            <SectionLabel>concept bank · {totalConcepts}</SectionLabel>
            <div className="flex flex-col gap-4">
              {prs.map((pr) => (
                <PRBlock key={pr.pr_number} pr={pr} />
              ))}
            </div>
          </section>
        )}
      </div>

      {USING_MOCK && (
        <div className="pointer-events-none fixed bottom-2 right-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          mock data
        </div>
      )}
    </div>
  );
}
