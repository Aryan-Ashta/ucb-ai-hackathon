/**
 * Time + display formatting helpers shared by the dashboard and quiz pages.
 *
 * All functions are pure — no React, no Date.now() side effects beyond what
 * `formatDue` / `getDueStatus` deliberately use for "overdue Xm ago" strings.
 * Tested in format.test.ts.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** Coarse due-status bucket used to colorize cards (overdue / today / upcoming). */
export function getDueStatus(nextReview: string): "overdue" | "today" | "upcoming" {
  const diff = new Date(nextReview).getTime() - Date.now();
  if (diff < 0) return "overdue";
  if (diff < DAY) return "today";
  return "upcoming";
}

/** Human-readable "in 3m / in 2h / in 5d / 12m overdue" string. */
export function formatDue(nextReview: string): string {
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

/** "merged 3h ago / yesterday / 5d ago" — for PR block headers. */
export function mergedAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < HOUR) return "just now";
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const d = Math.floor(diff / DAY);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

/**
 * SM-2 state → 0..100 mastery percent. Capped at 100.
 * Interval drives 85% of the score (30 days = full mastery); the first
 * few repetitions contribute up to 15 pts so the bar visibly moves even
 * on rep 0→1 when interval stays at 1 day.
 */
export function masteryPct(intervalDays: number, repetitions = 0): number {
  const intervalScore = (intervalDays / 30) * 85;
  const repScore = Math.min(repetitions, 4) * 3.75; // 0–15 pts from reps
  return Math.min(Math.round(intervalScore + repScore), 100);
}

/** "mm:ss" timer for the recording UI. */
export function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Fractional days from now until an ISO timestamp (clamped to ≥ 0). */
export function daysUntil(iso: string): number {
  return Math.max(0, (new Date(iso).getTime() - Date.now()) / DAY);
}

/** Result-panel "tomorrow / in 3 days / in about an hour" string. */
export function formatNextReview(iso: string): string {
  const d = daysUntil(iso);
  if (d < 1) {
    const h = Math.round(d * 24);
    return h <= 1 ? "in about an hour" : `in ${h} hours`;
  }
  const days = Math.round(d);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}
