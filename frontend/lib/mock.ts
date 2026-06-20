import type { Concept } from "./types";

// Mock concept bank — same shape the real API returns, so the UI is identical
// whether it reads from here or from the backend. Used by the quiz flow until
// NEXT_PUBLIC_API_BASE_URL is set.

const now = Date.now();
const day = 24 * 60 * 60 * 1000;

export const MOCK_CONCEPTS: Concept[] = [
  {
    id: "demo:42:memoization",
    concept: "Memoization",
    roast_text:
      "You wrote a recursive `fib()` with zero caching. A CS101 student called — they want their homework back.",
    question_text:
      "What technique would eliminate the redundant recomputation in this recursive function?",
    answer_hint: "memoization, caching, dynamic programming, lookup table, lru_cache",
    next_review: new Date(now - 30 * 60 * 1000).toISOString(),
    interval: 1,
    ease_factor: 2.5,
    repetitions: 0,
    pr_number: 42,
    repo: "myorg/vibeschool",
    pr_title: "Add memoization to recursive functions",
  },
  {
    id: "demo:42:time_complexity",
    concept: "Time Complexity",
    roast_text: "O(2^n) in 2026. Bold choice. Genuinely bold.",
    question_text:
      "What is the time complexity of the original implementation versus the memoized version?",
    answer_hint: "O(2^n) vs O(n), exponential vs linear",
    next_review: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    interval: 1,
    ease_factor: 2.5,
    repetitions: 0,
    pr_number: 42,
    repo: "myorg/vibeschool",
    pr_title: "Add memoization to recursive functions",
  },
  {
    id: "demo:39:jwt_verification",
    concept: "JWT Verification",
    roast_text:
      "You're not checking the `alg` field. Congrats on your brand-new algorithm-confusion vulnerability.",
    question_text:
      "What field in a JWT header must be validated to prevent algorithm-confusion attacks?",
    answer_hint: "alg field, algorithm header, none algorithm",
    next_review: new Date(now - day).toISOString(),
    interval: 6,
    ease_factor: 2.3,
    repetitions: 1,
    pr_number: 39,
    repo: "myorg/vibeschool",
    pr_title: "Refactor auth middleware",
  },
  {
    id: "demo:39:middleware_composition",
    concept: "Middleware Composition",
    roast_text:
      "Four middlewares doing the job of one. Hope you enjoy debugging that call stack.",
    question_text:
      "How would you compose these four middleware functions into a single reusable pipeline?",
    answer_hint: "function composition, pipe, chain, higher-order functions",
    next_review: new Date(now + 3 * day).toISOString(),
    interval: 3,
    ease_factor: 2.5,
    repetitions: 1,
    pr_number: 39,
    repo: "myorg/vibeschool",
    pr_title: "Refactor auth middleware",
  },
  {
    id: "demo:35:cache_invalidation",
    concept: "Cache Invalidation",
    roast_text:
      "You cached everything with a 24h TTL and called it a day. Phil Karlton is rolling in his grave.",
    question_text:
      "What are the two hard problems in computer science, and how does your TTL strategy actually address cache invalidation?",
    answer_hint: "naming things, cache invalidation, off-by-one errors",
    next_review: new Date(now + 7 * day).toISOString(),
    interval: 7,
    ease_factor: 2.6,
    repetitions: 2,
    pr_number: 35,
    repo: "myorg/vibeschool",
    pr_title: "Add Redis caching layer",
  },
];

export function findMockConcept(id: string): Concept | undefined {
  return MOCK_CONCEPTS.find((c) => c.id === id);
}

// When each PR was merged, keyed by PR number — the one bit of PR-level state
// the concepts don't already carry.
const MERGED_AT: Record<number, string> = {
  42: new Date(now - day).toISOString(),
  39: new Date(now - 2 * day).toISOString(),
  35: new Date(now - 4 * day).toISOString(),
};

export interface DashboardPR {
  pr_number: number;
  repo: string;
  title: string;
  merged_at: string;
  concepts: Concept[];
}

/** Group the concept bank into PRs for the dashboard, preserving bank order. */
export function getMockPRs(): DashboardPR[] {
  const order: number[] = [];
  const byPr: Record<number, Concept[]> = {};
  for (const c of MOCK_CONCEPTS) {
    const pr = c.pr_number ?? 0;
    if (!byPr[pr]) {
      byPr[pr] = [];
      order.push(pr);
    }
    byPr[pr].push(c);
  }
  return order.map((pr_number) => {
    const concepts = byPr[pr_number];
    return {
      pr_number,
      repo: concepts[0].repo ?? "",
      title: concepts[0].pr_title ?? "",
      merged_at: MERGED_AT[pr_number] ?? new Date(now).toISOString(),
      concepts,
    };
  });
}

/**
 * A heuristic stand-in for Claude's grader. Rewards mentioning expected
 * keywords and a substantive answer; returns SM-2-shaped output identical to
 * the real /api/grade response.
 */
export function mockGrade(
  concept: Concept,
  transcript: string,
): { passed: boolean; quality: number; explanation: string; next_review: string } {
  const said = transcript.toLowerCase();
  const keywords = concept.answer_hint
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const hits = keywords.filter((k) => said.includes(k)).length;
  const words = transcript.trim().split(/\s+/).filter(Boolean).length;

  let quality: number;
  if (hits >= 2 && words >= 8) quality = 5;
  else if (hits >= 1 && words >= 8) quality = 4;
  else if (hits >= 1) quality = 3;
  else if (words >= 6) quality = 2;
  else if (words >= 1) quality = 1;
  else quality = 0;

  const passed = quality >= 3;

  // SM-2-ish next interval, mirroring how the backend would space it.
  const nextInterval =
    quality < 3 ? 1 : Math.max(1, Math.round(concept.interval * concept.ease_factor));
  const next_review = new Date(Date.now() + nextInterval * day).toISOString();

  const explanation = passed
    ? hits >= 2
      ? `Spot on — you named ${keywords[0]} and explained why it works.`
      : `Right idea. Tighten it by naming the core term explicitly.`
    : hits >= 1
      ? `On the right track, but the explanation was too thin to be sure you've got it.`
      : `Not quite — the answer didn't touch the key idea (${keywords[0]}).`;

  return { passed, quality, explanation, next_review };
}
