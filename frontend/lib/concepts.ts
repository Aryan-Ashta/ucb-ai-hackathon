import type { Mood } from "@/components/Mascot";

export type ConceptState = "mastered" | "due" | "progress" | "locked";

export interface GraphConcept {
  id: string;
  label: string;
  x: number;
  y: number;
  state: ConceptState;
  pr: number;
  prTitle: string;
}

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
 * Derive a node's visual state from live SM-2 concept fields.
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
