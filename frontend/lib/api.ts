import { findMockConcept, mockGrade } from "./mock";
import type { Concept, GradeRequest, GradeResult, TranscribeResult } from "./types";

// API client. Talks to the FastAPI backend when NEXT_PUBLIC_API_BASE_URL is
// set; otherwise serves mock responses so the UI is fully demoable offline.
// Swapping to the real backend is a single env var — no UI changes required.

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";
export const USING_MOCK = API_BASE === "";

// Mock latency so loading/transition states are exercised in development.
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a single concept by id.
 * Real backend: there is no GET /api/concept/{id} yet — the closest endpoint is
 * GET /api/concepts/{user_id} (the due queue). When wired up, derive the id from
 * that list or add a dedicated endpoint; the mock returns the concept directly.
 */
export async function getConcept(id: string): Promise<Concept | null> {
  if (USING_MOCK) {
    await delay(300);
    return findMockConcept(id) ?? null;
  }
  const [userId] = id.split(":");
  const res = await fetch(`${API_BASE}/api/concepts/${encodeURIComponent(userId)}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { due: Concept[] };
  return data.due.find((c) => c.id === id) ?? null;
}

/** POST /api/transcribe — multipart audio in, transcript out. */
export async function transcribeAudio(audio: Blob): Promise<TranscribeResult> {
  if (USING_MOCK) {
    await delay(1100);
    return { transcript: MOCK_TRANSCRIPT };
  }
  const form = new FormData();
  form.append("audio", audio, "answer.webm");
  const res = await fetch(`${API_BASE}/api/transcribe`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
  return (await res.json()) as TranscribeResult;
}

/** POST /api/grade — transcript in, SM-2 grade out. */
export async function gradeAnswer(req: GradeRequest, concept: Concept): Promise<GradeResult> {
  if (USING_MOCK) {
    await delay(1300);
    return mockGrade(concept, req.transcript);
  }
  const res = await fetch(`${API_BASE}/api/grade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Grading failed (${res.status})`);
  return (await res.json()) as GradeResult;
}

// A plausible spoken answer, used only in mock mode when the user records.
const MOCK_TRANSCRIPT =
  "I'd use memoization to cache the results of each subproblem in a lookup table, " +
  "so repeated calls return instantly instead of recomputing. That's basically dynamic programming.";
