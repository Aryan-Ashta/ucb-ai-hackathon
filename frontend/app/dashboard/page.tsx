"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Concept, type ListDueResponse } from "@/lib/api";

// --- Helpers ---

function getDueStatus(nextReview: string): "overdue" | "today" | "upcoming" {
  const now = Date.now();
  const diff = new Date(nextReview).getTime() - now;
  if (diff < 0) return "overdue";
  if (diff < 86_400_000) return "today";
  return "upcoming";
}

function formatNextReview(nextReview: string): string {
  const now = Date.now();
  const diff = new Date(nextReview).getTime() - now;
  if (diff < 0) {
    const ago = Math.abs(diff);
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m overdue`;
    if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h overdue`;
    return `${Math.floor(ago / 86_400_000)}d overdue`;
  }
  if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h`;
  return `in ${Math.floor(diff / 86_400_000)}d`;
}

function masteryPct(interval: number): number {
  return Math.min(Math.round((interval / 30) * 100), 100);
}

// --- Components ---

function DueQueueItem({ concept }: { concept: Concept }) {
  const status = getDueStatus(concept.next_review);
  return (
    <div
      className={`flex items-center justify-between p-3 rounded-xl border text-sm ${
        status === "overdue"
          ? "bg-red-50 border-red-200"
          : "bg-yellow-50 border-yellow-200"
      }`}
    >
      <div className="min-w-0">
        <p className="font-semibold text-gray-900 truncate">{concept.concept}</p>
      </div>
      <div className="flex items-center gap-2 ml-3 shrink-0">
        <span
          className={`text-xs font-medium ${
            status === "overdue" ? "text-red-600" : "text-yellow-700"
          }`}
        >
          {formatNextReview(concept.next_review)}
        </span>
        <a
          href={`/quiz/${concept.id}`}
          className="p-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white transition"
          title="Start quiz"
        >
          🎤
        </a>
      </div>
    </div>
  );
}

function ConceptCard({ concept }: { concept: Concept }) {
  const status = getDueStatus(concept.next_review);
  const pct = masteryPct(concept.interval);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold text-gray-900">{concept.concept}</h3>
        <span
          className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${
            status === "overdue"
              ? "bg-red-100 text-red-700"
              : status === "today"
              ? "bg-yellow-100 text-yellow-700"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          {formatNextReview(concept.next_review)}
        </span>
      </div>

      <p className="text-sm text-gray-600 italic line-clamp-2">
        &ldquo;{concept.roast_text}&rdquo;
      </p>

      {/* Mastery bar */}
      <div>
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>Mastery</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-yellow-400 rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-gray-400">
          {concept.repetitions === 0
            ? "Never reviewed"
            : `${concept.repetitions} review${concept.repetitions > 1 ? "s" : ""}`}
        </span>
        <a
          href={`/quiz/${concept.id}`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-700 text-white text-xs font-medium transition"
        >
          🎤 <span>Quiz me</span>
        </a>
      </div>
    </div>
  );
}

// --- Page ---

export default function Dashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [conceptData, setConceptData] = useState<ListDueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated" || !session?.accessToken) return;
    setLoading(true);
    setFetchError(null);
    api
      .listDueConcepts(session.accessToken)
      .then(setConceptData)
      .catch((err) => setFetchError(err instanceof Error ? err.message : "Failed to load concepts"))
      .finally(() => setLoading(false));
  }, [status, session?.accessToken]);

  if (status === "loading" || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-yellow-50">
        <span className="text-4xl animate-bounce">🦆</span>
      </div>
    );
  }

  const concepts = conceptData?.due ?? [];
  const dueItems = concepts
    .filter((c) => getDueStatus(c.next_review) !== "upcoming")
    .sort((a, b) => new Date(a.next_review).getTime() - new Date(b.next_review).getTime());

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🦆</span>
          <span className="font-bold text-gray-900">VibeSchool</span>
        </div>
        <div className="flex items-center gap-3">
          {session.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt={session.user.name ?? "avatar"}
              className="w-7 h-7 rounded-full"
            />
          )}
          <span className="text-sm text-gray-600 hidden sm:block">
            {session.user?.name}
          </span>
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-xs text-gray-400 hover:text-gray-600 transition"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-8 flex gap-6">
        {/* Main — concept list */}
        <main className="flex-1 min-w-0 flex flex-col gap-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Your Concepts</h1>
            {!loading && !fetchError && (
              <p className="text-sm text-gray-500 mt-0.5">
                {concepts.length} concept{concepts.length !== 1 ? "s" : ""} tracked
              </p>
            )}
          </div>

          {loading && (
            <div className="flex items-center justify-center py-20 text-gray-400">
              <span className="text-4xl animate-bounce">🦆</span>
            </div>
          )}

          {fetchError && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
              <p className="font-semibold mb-1">Could not load concepts</p>
              <p className="font-mono text-xs">{fetchError}</p>
            </div>
          )}

          {!loading && !fetchError && concepts.length === 0 && (
            <div className="text-center py-20 text-gray-400">
              <div className="text-5xl mb-3">🦆</div>
              <p className="font-medium text-gray-600">No concepts yet</p>
              <p className="text-sm mt-1">Sync your GitHub PRs to get started.</p>
            </div>
          )}

          {!loading && !fetchError && concepts.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {concepts.map((c) => (
                <ConceptCard key={c.id} concept={c} />
              ))}
            </div>
          )}
        </main>

        {/* Sidebar — Due queue */}
        <aside className="w-72 shrink-0 hidden lg:block">
          <div className="sticky top-20">
            <h2 className="font-bold text-gray-900 mb-3">
              Due today
              {dueItems.length > 0 && (
                <span className="ml-2 text-xs bg-red-100 text-red-600 font-semibold px-2 py-0.5 rounded-full">
                  {dueItems.length}
                </span>
              )}
            </h2>
            {loading ? (
              <div className="text-center py-10 text-sm text-gray-400">
                <span className="text-2xl animate-bounce">🦆</span>
              </div>
            ) : dueItems.length === 0 ? (
              <div className="text-center py-10 text-sm text-gray-400">
                <div className="text-3xl mb-2">🦆</div>
                All caught up!
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {dueItems.map((c) => (
                  <DueQueueItem key={c.id} concept={c} />
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
