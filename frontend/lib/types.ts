// Shared types — shaped to the FastAPI backend contracts in backend/routers.

/** A single CS concept extracted from a PR diff. Mirrors QuizConcept + SM-2 state. */
export interface Concept {
  id: string; // concept_id: "{user_id}:{pr_number}:{slug}"
  concept: string; // human-readable name, e.g. "Memoization"
  roast_text: string; // savage-but-educational roast of the code
  question_text: string; // the quiz question
  answer_hint: string; // comma-separated keywords used for grading
  next_review: string; // ISO timestamp
  interval: number; // SM-2 interval, days
  ease_factor: number; // SM-2 ease factor
  repetitions: number; // successful reviews so far
  // Provenance (for the eyebrow / "from PR #42" chip).
  pr_number?: number;
  repo?: string;
  pr_title?: string;
}

/** Response from POST /api/transcribe. */
export interface TranscribeResult {
  transcript: string;
  error?: string;
}

/** Response from POST /api/grade. */
export interface GradeResult {
  passed: boolean;
  quality: number; // SM-2 quality score, 0–5
  explanation: string; // one-sentence examiner feedback
  next_review: string; // ISO timestamp of the next scheduled review
}

/** Request body for POST /api/grade. */
export interface GradeRequest {
  user_id: string;
  concept_id: string;
  transcript: string;
}
