import type { Mood } from "@/components/Mascot";

// ---------------------------------------------------------------------------
// Concept-graph layout + state model.
//
// The graph LAYOUT (x/y of each node, and which edges exist) is a fixed design
// decision keyed by a stable concept `id` (slug). The node STATE
// (mastered / due / progress / locked) is what you derive from your real SM-2
// data — see deriveState() at the bottom.
//
// To wire this to your backend: keep this CONCEPTS array as the canonical
// layout, then in the dashboard merge each node with the matching live concept
// (by id/slug) and overwrite `state` via deriveState(liveConcept).
// ---------------------------------------------------------------------------

export type ConceptState = "mastered" | "due" | "progress" | "locked";

export interface GraphConcept {
  id: string;
  label: string;
  x: number;
  y: number;
  state: ConceptState;
  pr: number;
  prTitle: string;
  /** Examiner line shown in the mascot bubble when this node is selected. */
  line: string;
}

// viewBox is 0 0 820 520. Columns: 80 / 290 / 500 / 700 (basics → advanced).
export const CONCEPTS: GraphConcept[] = [
  { id: "arrays", label: "Arrays", x: 80, y: 90, state: "mastered", pr: 28, prTitle: "Initial data-structures pass",
    line: "Arrays — mastered. You index from zero like a professional. Nothing to roast here. Unsettling." },
  { id: "recursion", label: "Recursion", x: 80, y: 250, state: "mastered", pr: 28, prTitle: "Initial data-structures pass",
    line: "Recursion: solved. To understand it, see 'Recursion.' You finally nailed the base case." },
  { id: "hashmaps", label: "Hash Maps", x: 80, y: 410, state: "mastered", pr: 28, prTitle: "Initial data-structures pass",
    line: "Hash maps — locked in. O(1) lookups and you didn't even gloat. Personal growth." },
  { id: "timecomplexity", label: "Time Complexity", x: 290, y: 160, state: "mastered", pr: 42, prTitle: "Add memoization to recursive functions",
    line: "Big-O? Mastered. You stopped writing O(2^n) and calling it 'fast enough.'" },
  { id: "hashing", label: "Hashing", x: 290, y: 400, state: "mastered", pr: 28, prTitle: "Initial data-structures pass",
    line: "Hashing: clean. Collisions handled, nothing in plaintext. I'm almost proud." },
  { id: "memoization", label: "Memoization", x: 500, y: 100, state: "due", pr: 42, prTitle: "Add memoization to recursive functions",
    line: "You wrote a recursive fib() with zero caching. A CS101 student called — they want their homework back." },
  { id: "caching", label: "Caching", x: 500, y: 280, state: "progress", pr: 35, prTitle: "Add Redis caching layer",
    line: "Caching: halfway there. You cache things. Whether they SHOULD be cached is between you and your TTL." },
  { id: "jwt", label: "JWT Verification", x: 500, y: 440, state: "due", pr: 39, prTitle: "Refactor auth middleware",
    line: "You're not checking the alg field. Congrats on your brand-new algorithm-confusion vulnerability." },
  { id: "dynamicprog", label: "Dynamic Programming", x: 700, y: 100, state: "progress", pr: 42, prTitle: "Add memoization to recursive functions",
    line: "Dynamic programming: the table's half-filled. Like your understanding. Keep filling it in." },
  { id: "cacheinvalidation", label: "Cache Invalidation", x: 700, y: 280, state: "locked", pr: 35, prTitle: "Add Redis caching layer",
    line: "Cache invalidation — one of the two hard problems. Master Caching first, then we'll talk." },
  { id: "middleware", label: "Middleware", x: 700, y: 440, state: "locked", pr: 39, prTitle: "Refactor auth middleware",
    line: "Four middlewares doing the job of one. Locked until you pass JWT Verification." },
];

export const EDGES: ReadonlyArray<[string, string]> = [
  ["arrays", "timecomplexity"],
  ["recursion", "timecomplexity"],
  ["recursion", "memoization"],
  ["timecomplexity", "memoization"],
  ["memoization", "dynamicprog"],
  ["hashmaps", "hashing"],
  ["hashing", "caching"],
  ["hashing", "jwt"],
  ["caching", "cacheinvalidation"],
  ["jwt", "middleware"],
];

export interface StateStyle {
  fill: string;
  stroke: string;
  label: string;
  dot: string;
  mood: Mood;
  statusText: string;
}

export const STATE_STYLE: Record<ConceptState, StateStyle> = {
  mastered: { fill: "#26331f", stroke: "#5fcf8e", label: "#cdbfa6", dot: "#5fcf8e", mood: "happy", statusText: "mastered" },
  due:      { fill: "#3a2c12", stroke: "#ffb627", label: "#f6efe2", dot: "#ff6f5e", mood: "angry", statusText: "due for review" },
  progress: { fill: "#2a231b", stroke: "#ffb627", label: "#ab9d86", dot: "#ffb627", mood: "thinking", statusText: "still learning" },
  locked:   { fill: "#1b1712", stroke: "#3a3128", label: "#6f6555", dot: "#6f6555", mood: "thinking", statusText: "locked" },
};

/**
 * Derive a node's visual state from your live SM-2 concept fields.
 * Tune the thresholds to taste.
 *
 *   nextReview  — ISO timestamp (overdue/soon ⇒ "due")
 *   interval    — SM-2 interval in days (high ⇒ "mastered")
 *   repetitions — successful reviews so far (0 with no schedule ⇒ "locked")
 */
export function deriveState(opts: {
  nextReview?: string;
  interval?: number;
  repetitions?: number;
  unlocked?: boolean;
}): ConceptState {
  const { nextReview, interval = 0, repetitions = 0, unlocked = true } = opts;
  if (!unlocked) return "locked";
  const due = nextReview ? new Date(nextReview).getTime() - Date.now() < 24 * 60 * 60 * 1000 : false;
  if (due) return "due";
  if (interval >= 21 && repetitions >= 2) return "mastered";
  return "progress";
}
