"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMockPRs, type DashboardPR } from "@/lib/mock";
import type { Concept } from "@/lib/types";
import { api, USING_MOCK } from "@/lib/api";
import { apiErrorToMessage } from "@/lib/api-error";
import { formatDue, getDueStatus, masteryPct, mergedAgo } from "@/lib/format";

type PR = DashboardPR;

/** A rolled-up commit group: same repo, all commits in it. */
interface CommitGroup {
  repo: string;
  concepts: Concept[];
}

/** Group a flat concept list into PRs by pr_number (PR-sourced only).
 *  Commit-sourced concepts are excluded here — groupByCommit handles them. */
function groupByPR(concepts: Concept[]): PR[] {
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
      merged_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      concepts: cs,
    };
  });
}

/** Group commit-sourced concepts by repo (commits don't have a natural
 *  numeric grouping key the way PRs do, so we roll them up by repo).
 *  Sorted by most-recently-due concept first within each group. */
function groupByCommit(concepts: Concept[]): CommitGroup[] {
  const byRepo: Record<string, Concept[]> = {};
  for (const c of concepts) {
    if (c.source_type !== "commit") continue;
    const repo = c.repo ?? "(unknown repo)";
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(c);
  }
  // Stable order: most-recent commit first within each repo (the dashboard
  // sorts by next_review anyway, but we keep a deterministic order here so
  // re-renders don't shuffle).
  for (const repo of Object.keys(byRepo)) {
    byRepo[repo].sort((a, b) => a.commit_sha?.localeCompare(b.commit_sha ?? "") ?? 0);
  }
  return Object.entries(byRepo).map(([repo, concepts]) => ({ repo, concepts }));
}

/**
 * Map a dashboard fetch failure to a friendly user-facing message.
 * Thin wrapper around the shared apiErrorToMessage — kept as a named
 * helper so the call site reads as "the dashboard fetch failed" instead
 * of the more generic "ctx".
 */
function friendlyFetchError(err: unknown): string {
  return apiErrorToMessage(err, "dashboard listDueConcepts");
}

// --- Components ---

/**
 * Due-queue card — styled like a git diff hunk.
 * Left accent bar: coral = overdue, marigold = due today.
 */
function DueCard({ concept }: { concept: Concept & { prTitle: string } }) {
  const status = getDueStatus(concept.next_review);
  const isOverdue = status === "overdue";
  const isCommit = concept.source_type === "commit";
  const shortSha = concept.commit_sha ? concept.commit_sha.slice(0, 7) : "";
  const provenance = isCommit
    ? `${concept.repo}@${shortSha}`
    : `${concept.repo}#${concept.pr_number}`;

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

/** Commit block: leaner than PRBlock — no merged-at date, just commit
 *  SHAs as the unit of provenance. Multiple commits from the same repo
 *  roll up into one block so a user with 100 commits doesn't see 100
 *  separate cards. */
function CommitBlock({ group }: { group: CommitGroup }) {
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
function CommitRow({ concept }: { concept: Concept }) {
  const status = getDueStatus(concept.next_review);
  const pct = masteryPct(concept.interval);
  const shortSha = concept.commit_sha ? concept.commit_sha.slice(0, 7) : "";

  return (
    <a
      href={`/quiz/${concept.id}`}
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
  // due-only list — drives the "due now" queue
  const [prs, setPrs] = useState<PR[]>(USING_MOCK ? getMockPRs() : []);
  // all synced concepts — drives the concept bank (includes future-scheduled)
  const [allPrs, setAllPrs] = useState<PR[]>(USING_MOCK ? getMockPRs() : []);
  // commit-sourced concepts, rolled up by repo (separate section in concept bank)
  const [commitGroups, setCommitGroups] = useState<CommitGroup[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(!USING_MOCK);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Auto-sync once per session when the user has no due concepts (first-run
  // OR caught-up). Re-sync is cheap (per-PR hash dedupes; no GitHub fetch
  // for already-seen PRs), so we don't gate on last_sync — we just trust
  // the user's intent ("show me my concepts") over a last-write timestamp.
  const hasAutoSyncedRef = useRef(false);
  // In-flight guard (avoids re-creating triggerSync when `syncing` flips).
  const syncingRef = useRef(false);

  useEffect(() => {
    // P1-F5: preserve the original path as callbackUrl so the user lands back
    // here after signing in (instead of being dumped on / with no context).
    if (status === "unauthenticated") {
      const here = typeof window !== "undefined" ? window.location.pathname : "/dashboard";
      const cb = encodeURIComponent(here);
      router.replace(`/?callbackUrl=${cb}`);
    }
  }, [status, router]);

  // Manual + auto sync trigger. Caller passes the bearer token explicitly
  // (no `session!.accessToken!` non-null assertion per P1-F1).
  const triggerSync = useCallback(async (token: string) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError(null);
    try {
      await api.triggerSync(token);
      // Re-fetch both lists so the UI updates immediately when sync completes.
      const [dueData, allData] = await Promise.all([
        api.listDueConcepts(token),
        api.listAllConcepts(token),
      ]);
      setPrs(groupByPR(dueData.due));
      setAllPrs(groupByPR(allData.concepts));
      setCommitGroups(groupByCommit(allData.concepts));
    } catch (err) {
      const msg = apiErrorToMessage(err, "dashboard sync");
      setSyncError(msg);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // Live backend: fetch due concepts and group into PRs. Auto-trigger a sync
  // when the user has nothing due (covers first-run AND caught-up cases — re-sync
  // is idempotent so the cost is bounded).
  useEffect(() => {
    if (USING_MOCK || status !== "authenticated" || !session?.accessToken) return;
    const ctrl = new AbortController();
    const token = session.accessToken;
    setFetching(true);
    setFetchError(null);

    Promise.all([
      api.listDueConcepts(token, ctrl.signal),
      api.listAllConcepts(token, ctrl.signal),
    ])
      .then(([dueData, allData]) => {
        setPrs(groupByPR(dueData.due));
        setAllPrs(groupByPR(allData.concepts));
        setCommitGroups(groupByCommit(allData.concepts));
        if (dueData.due.length === 0 && !hasAutoSyncedRef.current) {
          hasAutoSyncedRef.current = true;
          void triggerSync(token);
        }
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setFetchError(friendlyFetchError(err));
      })
      .finally(() => setFetching(false));
    return () => ctrl.abort();
  }, [status, session?.accessToken, triggerSync]);

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
  const totalConcepts = allPrs.reduce((n, pr) => n + pr.concepts.length, 0);

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
          {session?.accessToken && !USING_MOCK && (
            <div className="flex items-center gap-2">
              {syncError && (
                <span
                  className="font-mono text-[11px] text-coral"
                  title={syncError}
                >
                  sync failed — click to retry
                </span>
              )}
              <button
                onClick={() => triggerSync(session.accessToken!)}
                disabled={syncing}
                className="font-mono text-xs px-2 py-1 rounded border border-line bg-surface-1 text-ink hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {syncing ? "syncing…" : "sync"}
              </button>
            </div>
          )}
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
            {allPrs.length > 0 && (
              <span className="font-mono text-xs bg-surface-2 border border-line text-ink-dim px-2.5 py-1 rounded-lg">
                {allPrs.length} PRs
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

        {/* All concepts, grouped by source (PRs + commits) */}
        {allPrs.length > 0 && (
          <section>
            <SectionLabel>concept bank · {totalConcepts}</SectionLabel>
            <div className="flex flex-col gap-4">
              {allPrs.map((pr) => (
                <PRBlock key={pr.pr_number} pr={pr} />
              ))}
            </div>
          </section>
        )}

        {/* Commit-sourced concepts, rolled up by repo. Renders below the PR
            bank so solo-repo users still see something here without
            needing to scroll through merged-PR-only repos. */}
        {commitGroups.length > 0 && (
          <section>
            <SectionLabel>
              recent commits · {commitGroups.reduce((n, g) => n + g.concepts.length, 0)}
            </SectionLabel>
            <div className="flex flex-col gap-4">
              {commitGroups.map((g) => (
                <CommitBlock key={g.repo} group={g} />
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
