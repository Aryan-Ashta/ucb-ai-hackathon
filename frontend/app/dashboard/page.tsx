"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { api, USING_MOCK, ApiError } from "@/lib/api";
import { apiErrorToMessage, isAbortError } from "@/lib/api-error";
import { getDueStatus } from "@/lib/format";
import { groupByPR, groupByCommit } from "@/lib/group-concepts";
import { getMockPRs } from "@/lib/mock";
import { buildGraphFromConcepts } from "@/lib/build-graph";
import type { Concept } from "@/lib/types";

import { ConceptGraph } from "@/components/ConceptGraph";
import { Mascot } from "@/components/Mascot";
import { STATE_STYLE, deriveState } from "@/lib/concepts";

import { CommitBlock, DueCard, PRBlock, SectionLabel } from "./components";

/**
 * Mission Control — Direction B from the Banana-Duck Learning Platform design
 * system, wired to live data:
 *   • "Due now" queue (top) — populated from api.listDueConcepts, but rendered
 *     in the new design's larger hero with streak pill + "Review now" CTA.
 *   • ConceptGraph (right) — the canonical graph layout from lib/concepts,
 *     with each node's state derived from the matching live concept via
 *     deriveState(). Nodes whose slug we haven't seen go "locked".
 *   • Mascot — drives its mood from the selected node's STATE_STYLE.
 *   • Concept bank (bottom) — keeps the existing PRBlock / CommitBlock
 *     list so commit-sourced concepts and any slugs not yet in the graph
 *     still have a way to be found + clicked through to /quiz/<id>.
 *
 * Auth / sync / error handling are preserved from the previous dashboard
 * (session-driven redirect, manual + auto sync, fetch error surface).
 */

// ─── helpers ────────────────────────────────────────────────────────────

function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** First due concept id, else first graph node id. */
function defaultSelectionId(due: Concept[], graphNodeIds: string[]): string | null {
  if (due[0]) return due[0].id;
  return graphNodeIds[0] ?? null;
}

function friendlyFetchError(err: unknown): string {
  return apiErrorToMessage(err, "dashboard listDueConcepts");
}

// ─── inline icon helpers (kept small, no new deps) ─────────────────────

function LegendDot({ color, ring }: { color?: string; ring?: boolean }) {
  return (
    <span
      className="inline-block h-[7px] w-[7px] rounded-full"
      style={ring ? { border: "1.5px solid #ffb627" } : { background: color }}
    />
  );
}

// ─── page ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();

  // due-only list — drives the "due now" queue
  const [prs, setPrs] = useState(() => (USING_MOCK ? getMockPRs() : []));
  // all synced concepts — drives the concept bank + graph states
  const [allPrs, setAllPrs] = useState(() => (USING_MOCK ? getMockPRs() : []));
  const [commitGroups, setCommitGroups] = useState<ReturnType<typeof groupByCommit>>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(!USING_MOCK);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Trace 3 M4: brief post-sync confirmation. Auto-clears after 4s so
  // the user knows their click did something but the indicator doesn't
  // linger.
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const syncSummaryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAllDue, setShowAllDue] = useState(false);
  const [showAllPRs, setShowAllPRs] = useState(false);
  const [showAllCommits, setShowAllCommits] = useState(false);

  const hasAutoSyncedRef = useRef(false);
  const syncingRef = useRef(false);
  // Trace 3 M2/M3: ref for the in-flight sync's AbortController so the
  // unmount-cleanup useEffect below can cancel it.
  const syncCtrlRef = useRef<AbortController | null>(null);
  // P2-D3 (Trace M1): sessionStorage mirror of hasAutoSyncedRef so the
  // flag survives unmount/remount cycles. A ref resets when the component
  // unmounts, so navigating /dashboard → / → /dashboard mid-sync would
  // fire a second auto-sync. The backend's acquire_sync_lock rejects the
  // second POST, but we'd still flash 'syncing…' and burn a round-trip.
  // We initialize from sessionStorage so a refresh or back/forward also
  // counts as 'already synced this session'.
  if (
    typeof window !== "undefined" &&
    sessionStorage.getItem("vibeschool:autoSynced") === "1" &&
    !hasAutoSyncedRef.current
  ) {
    hasAutoSyncedRef.current = true;
  }

  useEffect(() => {
    if (status === "unauthenticated") {
      const here = typeof window !== "undefined" ? window.location.pathname : "/dashboard";
      const cb = encodeURIComponent(here);
      router.replace(`/?callbackUrl=${cb}`);
    }
  }, [status, router]);

  // Trace 3 M4: brief confirmation helper. Clears the prior timer before
  // setting a new one so rapid syncs don't stack ghost timeouts.
  const showSyncSummary = useCallback((text: string) => {
    setSyncSummary(text);
    if (syncSummaryTimerRef.current) clearTimeout(syncSummaryTimerRef.current);
    syncSummaryTimerRef.current = setTimeout(() => setSyncSummary(null), 4000);
  }, []);

  const triggerSync = useCallback(
    async (token: string) => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      setSyncing(true);
      setSyncError(null);
      const inner = new AbortController();
      syncCtrlRef.current = inner;
      try {
        const syncResp = await api.triggerSync(token, inner.signal);
        const [dueData, allData] = await Promise.all([
          api.listDueConcepts(token, inner.signal),
          api.listAllConcepts(token, inner.signal),
        ]);
        setPrs(groupByPR(dueData.due));
        setAllPrs(groupByPR(allData.concepts));
        setCommitGroups(groupByCommit(allData.concepts));
        const s = syncResp.summary;
        const processed = s.prs_processed + s.commits_processed;
        const skipped = s.prs_skipped + s.commits_skipped;
        if (processed > 0) {
          showSyncSummary(`synced ${processed} new`);
        } else if (skipped > 0) {
          showSyncSummary("you're up to date");
        } else {
          showSyncSummary("synced");
        }
      } catch (err) {
        if (isAbortError(err)) return;
        setSyncError(apiErrorToMessage(err, "dashboard sync"));
      } finally {
        syncingRef.current = false;
        setSyncing(false);
        if (syncCtrlRef.current === inner) syncCtrlRef.current = null;
      }
    },
    [showSyncSummary],
  );

  // Abort the in-flight sync and clear the summary timer on unmount.
  useEffect(() => {
    return () => {
      syncCtrlRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (syncSummaryTimerRef.current) clearTimeout(syncSummaryTimerRef.current);
    };
  }, []);

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
        // Commit the loaded data + `fetching=false` in a single synchronous
        // flush. Without this, React 18 defers the render via the scheduler
        // and the page can stay in its loading state long enough that a test
        // (or any consumer of `fetching`/`prs`) sees the pre-load DOM — most
        // visibly because the <ConceptGraph> renders static concept labels
        // on the first render, so a `waitFor` for any concept name passes
        // before the loaded data is committed, and the very next assertion
        // (e.g. for the "1 overdue" pill) races the unmount and fails.
        flushSync(() => {
          setPrs(groupByPR(dueData.due));
          setAllPrs(groupByPR(allData.concepts));
          setCommitGroups(groupByCommit(allData.concepts));
          setFetching(false);
        });
        if (dueData.due.length === 0 && !hasAutoSyncedRef.current) {
          hasAutoSyncedRef.current = true;
          // P2-D3 (Trace M1): mirror to sessionStorage so a remount
          // (e.g. /dashboard → / → /dashboard) doesn't re-fire the
          // auto-sync. The backend's acquire_sync_lock protects against
          // double-billing Claude; this just saves a round-trip + flash.
          if (typeof window !== "undefined") {
            try {
              sessionStorage.setItem("vibeschool:autoSynced", "1");
            } catch {
              // sessionStorage can throw in privacy modes; the ref is
              // the fallback for the current mount.
            }
          }
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
        flushSync(() => {
          setFetchError(friendlyFetchError(err));
        });
      })
      .finally(() => setFetching(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, session?.accessToken]);

  // ── derived data ───────────────────────────────────────────────────────

  const allConcepts = useMemo(
    () => allPrs.flatMap((pr) => pr.concepts),
    [allPrs],
  );

  const dueItems = useMemo(
    () =>
      prs
        .flatMap((pr) =>
          pr.concepts
            .filter((c) => getDueStatus(c.next_review) !== "upcoming")
            .map((c) => ({ ...c, prTitle: pr.title })),
        )
        .sort((a, b) => new Date(a.next_review).getTime() - new Date(b.next_review).getTime()),
    [prs],
  );

  const overdueCount = dueItems.filter((c) => getDueStatus(c.next_review) === "overdue").length;
  const totalConcepts = allConcepts.length;

  const graphData = useMemo(() => buildGraphFromConcepts(allConcepts), [allConcepts]);

  const effectiveSelectionId = selectedId ?? defaultSelectionId(dueItems, graphData.nodes.map((n) => n.id));

  const selectedLive = useMemo(() => {
    if (!effectiveSelectionId) return null;
    return allConcepts.find((x) => x.id === effectiveSelectionId) ?? null;
  }, [allConcepts, effectiveSelectionId]);

  const selectedNode = useMemo(
    () => graphData.nodes.find((n) => n.id === effectiveSelectionId) ?? graphData.nodes[0] ?? null,
    [graphData.nodes, effectiveSelectionId],
  );

  const mascotMood = selectedLive
    ? STATE_STYLE[
        deriveState({
          nextReview: selectedLive.next_review,
          interval: selectedLive.interval,
          repetitions: selectedLive.repetitions,
        })
      ].mood
    : selectedNode
      ? STATE_STYLE[selectedNode.state].mood
      : "thinking";

  const handleGraphSelect = useCallback(
    (nodeId: string) => {
      setSelectedId(nodeId);
      router.push(`/quiz/${encodeURIComponent(nodeId)}`);
    },
    [router],
  );

  // ── render ────────────────────────────────────────────────────────────

  if (status === "loading" || !session) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <span className="font-mono text-sm text-ink-faint animate-pulse">loading…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      {/* ── header ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line">
        <div className="mx-auto max-w-5xl flex items-center gap-3 border-b border-line px-7 py-4">
          <span className="font-display text-lg font-extrabold tracking-tight">bananaduck</span>
          <div className="flex-1" />
          {session.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt={session.user.name ?? "avatar"}
              className="h-7 w-7 rounded-full border border-line"
            />
          )}
          {session?.accessToken && !USING_MOCK && (
            <div className="flex items-center gap-2">
              {syncError && (
                <span className="font-mono text-[11px] text-coral" title={syncError}>
                  sync failed — click to retry
                </span>
              )}
              {syncSummary && !syncError && (
                <span className="font-mono text-[11px] text-mint">
                  {syncSummary}
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

      <div className="mx-auto flex max-w-5xl flex-col gap-[18px] px-7 py-6">
        {/* ── DUE NOW (top) ────────────────────────────────────────── */}
        <section>
          <div className="mb-[14px] flex items-end justify-between gap-4">
            <div className="flex items-end gap-[13px]">
              <span className="font-display text-[54px] font-extrabold leading-[.78] tracking-[-0.03em] text-marigold">
                {fetching ? "…" : dueItems.length}
              </span>
              <span className="pb-1.5 font-display text-lg font-bold leading-tight text-ink-dim">
                concepts due
                <br />
                for review
              </span>
              {overdueCount > 0 && (
                <span className="font-mono text-xs bg-coral/10 border border-coral/25 text-coral px-2.5 py-1 rounded-lg self-end mb-1.5">
                  {overdueCount} overdue
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {dueItems[0] && (
                <a
                  href={`/quiz/${encodeURIComponent(dueItems[0].id)}`}
                  className="btn-3d cursor-pointer rounded-[13px] bg-marigold px-[22px] py-3 font-display text-[15px] font-bold text-canvas"
                >
                  Review now →
                </a>
              )}
            </div>
          </div>

          {fetchError && (
            <div className="mb-3 rounded-2xl bg-surface-1 border border-coral/30 px-5 py-4">
              <p className="font-mono text-xs text-coral mb-1">failed to load concepts</p>
              <p className="font-mono text-[11px] text-ink-faint">{fetchError}</p>
            </div>
          )}

          {fetching ? (
            <div className="py-10 text-center font-mono text-sm text-ink-faint animate-pulse">
              loading…
            </div>
          ) : dueItems.length > 0 ? (
            <div className="flex flex-col gap-[9px]">
              {(showAllDue ? dueItems : dueItems.slice(0, 5)).map((d) => (
                <a
                  key={d.id}
                  href={`/quiz/${encodeURIComponent(d.id)}`}
                  className="flex items-center gap-3 rounded-[13px] border border-line border-l-[3px] border-l-coral bg-surface-1 px-[17px] py-[13px] text-left transition-colors hover:bg-surface-2"
                >
                  <div className="flex-1">
                    <div className="text-[14.5px] font-semibold text-ink">{d.concept}</div>
                    <div className="mt-[3px] font-mono text-[10px] text-ink-faint">
                      {d.repo ?? "—"}#{d.pr_number ?? 0} · {d.prTitle}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-coral">
                    {getDueStatus(d.next_review) === "overdue" ? "overdue" : "due today"}
                  </span>
                  <span className="text-ink-faint">→</span>
                </a>
              ))}
              {dueItems.length > 5 && (
                <button
                  onClick={() => setShowAllDue((v) => !v)}
                  className="w-full rounded-[13px] border border-dashed border-line py-2.5 font-mono text-[11px] text-ink-faint hover:text-ink-dim hover:border-ink-faint transition-colors"
                >
                  {showAllDue
                    ? "show less"
                    : `+ ${dueItems.length - 5} more`}
                </button>
              )}
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

        {/* ── lower row: stats + graph + mascot ────────────────────── */}
        <section className="flex items-stretch gap-[18px]">
          <div className="flex w-[280px] flex-none flex-col gap-[14px]">
            <div className="rounded-2xl border border-line bg-surface-1 px-5 py-[18px]">
              <div className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                Mastery
              </div>
              <div className="font-display text-5xl font-extrabold leading-[.82] text-ink">
                {allConcepts.filter((c) => c.interval >= 21 && c.repetitions >= 2).length}
                <span className="text-[26px] text-ink-faint"> / {totalConcepts}</span>
              </div>
              <div className="mt-[13px] h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-mint"
                  style={{
                    width: totalConcepts
                      ? `${Math.round(
                          (allConcepts.filter(
                            (c) => c.interval >= 21 && c.repetitions >= 2,
                          ).length /
                            totalConcepts) *
                            100,
                        )}%`
                      : "0%",
                  }}
                />
              </div>
              <div className="mt-2 flex justify-between font-mono text-[10px] text-ink-faint">
                <span>{totalConcepts} concepts tracked</span>
                <span>{allPrs.length} PRs reviewed</span>
              </div>
            </div>

            <div className="flex-1 rounded-2xl border border-line bg-surface-1 px-5 py-[18px]">
              <div className="mb-[13px] font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                Coverage by PR
              </div>
              <div className="flex flex-col gap-[13px] max-h-48 overflow-y-auto pr-1">
                {allPrs.length === 0 ? (
                  <p className="font-mono text-[11px] text-ink-faint">
                    No PRs synced yet.
                  </p>
                ) : (
                  allPrs.map((p) => {
                    const mastered = p.concepts.filter(
                      (c) => c.interval >= 21 && c.repetitions >= 2,
                    ).length;
                    const pct = p.concepts.length
                      ? `${Math.round((mastered / p.concepts.length) * 100)}%`
                      : "0%";
                    return (
                      <div key={p.pr_number}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[11px] text-ink-dim">
                            #{p.pr_number} {p.title}
                          </span>
                          <span className="whitespace-nowrap font-mono text-[10px] text-ink-faint">
                            {mastered}/{p.concepts.length}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
                          <div className="h-full rounded-full bg-mint" style={{ width: pct }} />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-1 flex-col rounded-2xl border border-line bg-surface-1 p-[18px]">
            <div className="mb-0.5 flex items-center justify-between">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                Concept graph
              </span>
              <div className="flex gap-[11px] font-mono text-[9.5px] text-ink-faint">
                <span className="flex items-center gap-1">
                  <LegendDot color="#5fcf8e" /> mastered
                </span>
                <span className="flex items-center gap-1">
                  <LegendDot color="#ffb627" /> due
                </span>
                <span className="flex items-center gap-1">
                  <LegendDot ring /> learning
                </span>
              </div>
            </div>
            <div className="flex min-h-[300px] flex-1 items-center justify-center">
              {graphData.nodes.length === 0 ? (
                <p className="font-mono text-sm text-ink-faint text-center px-6">
                  Sync your repos to see concepts
                </p>
              ) : (
                <ConceptGraph
                  width={500}
                  nodes={graphData.nodes}
                  edges={graphData.edges}
                  selectedId={effectiveSelectionId}
                  onSelect={handleGraphSelect}
                />
              )}
            </div>
            <div className="mt-1.5 flex items-center gap-2.5 border-t border-surface-2 pt-2.5">
              <Mascot mood={mascotMood} size={46} />
              <span className="font-mono text-[10.5px] leading-snug text-ink-faint">
                {selectedLive?.roast_text
                  ? truncate(selectedLive.roast_text)
                  : selectedNode
                    ? `Tap a node — the examiner has opinions about ${selectedNode.label}.`
                    : "Sync your repos to populate the concept graph."}
              </span>
            </div>
          </div>
        </section>

        {/* ── concept bank (PRs + commits) — preserved for things ──
             ─  that don't have a graph node yet (commits, unmapped slugs) */}
        {allPrs.length > 0 && (
          <section className="mt-6">
            <SectionLabel>concept bank · {totalConcepts}</SectionLabel>
            <div className="flex flex-col gap-4">
              {(showAllPRs ? allPrs : allPrs.slice(0, 3)).map((pr) => (
                <PRBlock key={pr.pr_number} pr={pr} />
              ))}
              {allPrs.length > 3 && (
                <button
                  onClick={() => setShowAllPRs((v) => !v)}
                  className="w-full rounded-2xl border border-dashed border-line py-3 font-mono text-[11px] text-ink-faint hover:text-ink-dim hover:border-ink-faint transition-colors"
                >
                  {showAllPRs ? "show less" : `+ ${allPrs.length - 3} more PR${allPrs.length - 3 === 1 ? "" : "s"}`}
                </button>
              )}
            </div>
          </section>
        )}

        {commitGroups.length > 0 && (
          <section>
            <SectionLabel>
              recent commits ·{" "}
              {commitGroups.reduce((n, g) => n + g.concepts.length, 0)}
            </SectionLabel>
            <div className="flex flex-col gap-4">
              {(showAllCommits ? commitGroups : commitGroups.slice(0, 3)).map((g) => (
                <CommitBlock key={g.repo} group={g} />
              ))}
              {commitGroups.length > 3 && (
                <button
                  onClick={() => setShowAllCommits((v) => !v)}
                  className="w-full rounded-2xl border border-dashed border-line py-3 font-mono text-[11px] text-ink-faint hover:text-ink-dim hover:border-ink-faint transition-colors"
                >
                  {showAllCommits ? "show less" : `+ ${commitGroups.length - 3} more repo${commitGroups.length - 3 === 1 ? "" : "s"}`}
                </button>
              )}
            </div>
          </section>
        )}

        {/* fallback: keep the original DueCard grid for mock mode */}
        {USING_MOCK && dueItems.length > 0 && (
          <section>
            <SectionLabel>due now · {dueItems.length}</SectionLabel>
            <div className="flex flex-col gap-2">
              {dueItems.map((c) => (
                <DueCard key={c.id} concept={c} />
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