"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getMockPRs, type DashboardPR } from "@/lib/mock";
import type { Concept } from "@/lib/types";

// Single source of truth: the same concept bank the quiz flow reads, grouped by
// PR. Every "Quiz me" link therefore resolves to a real /quiz/[id].
type PR = DashboardPR;
const MOCK_PRS: PR[] = getMockPRs();

// --- Helpers ---

const now = Date.now();
const mins = (n: number) => n * 60 * 1000;
const hours = (n: number) => n * 60 * mins(1);
const days = (n: number) => n * 24 * hours(1);

function getDueStatus(nextReview: string): "overdue" | "today" | "upcoming" {
  const diff = new Date(nextReview).getTime() - now;
  if (diff < 0) return "overdue";
  if (diff < days(1)) return "today";
  return "upcoming";
}

function formatNextReview(nextReview: string): string {
  const diff = new Date(nextReview).getTime() - now;
  if (diff < 0) {
    const ago = Math.abs(diff);
    if (ago < hours(1)) return `${Math.floor(ago / mins(1))}m overdue`;
    if (ago < days(1)) return `${Math.floor(ago / hours(1))}h overdue`;
    return `${Math.floor(ago / days(1))}d overdue`;
  }
  if (diff < hours(1)) return `in ${Math.floor(diff / mins(1))}m`;
  if (diff < days(1)) return `in ${Math.floor(diff / hours(1))}h`;
  return `in ${Math.floor(diff / days(1))}d`;
}

function masteryPct(interval: number): number {
  return Math.min(Math.round((interval / 30) * 100), 100);
}

// --- Components ---

function DueQueueItem({ concept }: { concept: Concept & { prTitle: string } }) {
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
        <p className="text-xs text-gray-500 truncate">{concept.prTitle}</p>
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

function PRSection({ pr }: { pr: PR }) {
  const mergedDate = new Date(pr.merged_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-gray-400">
              {pr.repo}#{pr.pr_number}
            </span>
            <span className="text-xs text-gray-400">·</span>
            <span className="text-xs text-gray-400">{mergedDate}</span>
          </div>
          <h2 className="font-semibold text-gray-900 truncate">{pr.title}</h2>
        </div>
        <span className="shrink-0 text-xs bg-purple-100 text-purple-700 font-medium px-2 py-0.5 rounded-full">
          {pr.concepts.length} concept{pr.concepts.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {pr.concepts.map((c) => (
          <ConceptCard key={c.id} concept={c} />
        ))}
      </div>
    </section>
  );
}

// --- Page ---

export default function Dashboard() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
  }, [status, router]);

  if (status === "loading" || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-yellow-50">
        <span className="text-4xl animate-bounce">🦆</span>
      </div>
    );
  }

  // Build due queue: all concepts due now or today, sorted overdue-first then by timestamp
  const dueItems = MOCK_PRS.flatMap((pr) =>
    pr.concepts
      .filter((c) => getDueStatus(c.next_review) !== "upcoming")
      .map((c) => ({ ...c, prTitle: pr.title }))
  ).sort(
    (a, b) => new Date(a.next_review).getTime() - new Date(b.next_review).getTime()
  );

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
        {/* Main — PR list */}
        <main className="flex-1 min-w-0 flex flex-col gap-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Your PRs</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {MOCK_PRS.length} PRs · {MOCK_PRS.reduce((n, pr) => n + pr.concepts.length, 0)} concepts tracked
            </p>
          </div>
          {MOCK_PRS.map((pr) => (
            <PRSection key={pr.pr_number} pr={pr} />
          ))}
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
            {dueItems.length === 0 ? (
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
