// Shared types — shaped to the FastAPI backend contracts in backend/routers.

/** A single CS concept extracted from a PR diff or a single commit.
 *  Mirrors QuizConcept + SM-2 state. */
export interface Concept {
  id: string; // concept_id: "{user_id}:{pr_number}:{slug}" or "{user_id}:c-{sha_short}:{slug}"
  concept: string; // human-readable name, e.g. "Memoization"
  roast_text: string; // savage-but-educational roast of the code
  question_text: string; // the quiz question
  answer_hint: string; // comma-separated keywords used for grading
  next_review: string; // ISO timestamp
  interval: number; // SM-2 interval, days
  ease_factor: number; // SM-2 ease factor
  repetitions: number; // successful reviews so far
  // Provenance (for the eyebrow / "from PR #42" or "commit abc1234" chip).
  pr_number?: number; // 0 for commit-sourced concepts
  repo?: string;
  pr_title?: string;
  source_type?: "pr" | "commit"; // undefined / "pr" for legacy data
  commit_sha?: string; // full SHA when source_type="commit"
  merged_at?: string; // ISO timestamp from user:{u}:prs (PR-sourced only); undefined = unknown
  // Code excerpt shown alongside the question for advanced/code-specific concepts.
  // Empty string / undefined = basic concept question, no snippet shown.
  code_snippet?: string;
  file_path?: string; // path/to/file.py relative to repo root
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
  // SM-2 state post-grade. interval is in logical "days" regardless of
  // demo-mode time scaling — use these (not daysUntil(next_review)) for
  // mastery percentage calculations.
  interval: number;
  repetitions: number;
}

/** Request body for POST /api/grade. */
export interface GradeRequest {
  // Trace 2 H3 (Quiz #3): user_id was a dead field. The backend
  // silently dropped it (GradeRequest only declares concept_id +
  // transcript; the server derives user_id from get_current_user).
  // The frontend's user_id = id.split(":")[0] documented a wrong
  // trust boundary — anyone reading the call site might think the
  // server trusts the URL's first colon-segment, which it doesn't.
  concept_id: string;
  transcript: string;
}
