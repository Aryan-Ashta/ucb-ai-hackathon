"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMockPRs } from "@/lib/mock";
import { api, USING_MOCK, ApiError } from "@/lib/api";
import { apiErrorToMessage, isAbortError } from "@/lib/api-error";
import { getDueStatus } from "@/lib/format";
import { type PR, type CommitGroup, groupByPR, groupByCommit } from "@/lib/group-concepts";
import { CommitBlock, DueCard, PRBlock, SectionLabel } from "./components";

/**
 * Thin wrapper around apiErrorToMessage for this page's fetch path —
 * keeps the call site readable as "the dashboard fetch failed" instead
 * of the more generic "ctx".
 */
function friendlyFetchError(err: unknown): string {
  return apiErrorToMessage(err, "dashboard listDueConcepts");
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
        if (isAbortError(err)) return;
        // P2-D1 (Trace H1): an expired-token 401 used to leave the user
        // stranded on a broken dashboard. Now we bounce them back to
        // sign-in via signOut() rather than just rendering a banner.
        // Use signOut (not router.replace) so the next session starts
        // with a clean cookie + NextAuth JWT state.
        if (err instanceof ApiError && err.status === 401) {
          void signOut({ callbackUrl: "/" });
          return;
        }
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
