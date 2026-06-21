/**
 * API layer. Talks to the FastAPI backend when NEXT_PUBLIC_BACKEND_URL is set;
 * serves mock responses when it's absent so the UI is fully demoable offline.
 * Swapping to the real backend is a single env var — no UI changes required.
 *
 * P1-F4: in production, refuse to start without NEXT_PUBLIC_BACKEND_URL set —
 * the mock fallback is for local demos only. Falling back to mock in prod
 * would silently leak users into the demo data path.
 */
import { findMockConcept, mockGrade } from "./mock";
import type { Concept, GradeRequest, GradeResult, TranscribeResult } from "./types";

// Re-export so files can import Concept/GradeResult from either @/lib/api or @/lib/types.
export type { Concept, GradeResult };

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "").replace(/\/$/, "");
export const USING_MOCK = BACKEND === "";

// P1-F4: fail loud in production if the env var is missing. In development
// we still allow mock mode so contributors can run the UI without a backend.
if (
  typeof process !== "undefined" &&
  process.env.NODE_ENV === "production" &&
  BACKEND === ""
) {
  throw new Error(
    "NEXT_PUBLIC_BACKEND_URL is required in production. " +
      "The mock fallback is for local demos only; running it in prod would " +
      "silently route users into the demo data path. " +
      "Set NEXT_PUBLIC_BACKEND_URL in frontend/.env.local and rebuild.",
  );
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Live backend infrastructure ---

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "ApiError";
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "headers"> {
  accessToken?: string;
  headers?: HeadersInit;
}

export async function apiFetch<T = unknown>(
  path: string,
  { accessToken, headers, ...init }: ApiFetchOptions = {},
): Promise<T> {
  const finalHeaders = new Headers(headers);
  if (!finalHeaders.has("Content-Type") && init.body) {
    finalHeaders.set("Content-Type", "application/json");
  }
  if (accessToken) {
    finalHeaders.set("Authorization", `Bearer ${accessToken}`);
  }
  const url = path.startsWith("http") ? path : `${BACKEND}${path}`;
  const res = await fetch(url, { ...init, headers: finalHeaders });
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(
      res.status,
      body,
      `API ${res.status} ${res.statusText} on ${init.method ?? "GET"} ${path}`,
    );
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

// --- Typed response interfaces ---

export interface ListDueResponse {
  user_id: string;
  due: Concept[];
  count: number;
}

export interface ListAllResponse {
  user_id: string;
  concepts: Concept[];
  count: number;
}

export interface SyncSummary {
  status: string;
  repos_seen: number;
  prs_seen: number;
  prs_processed: number;
  prs_skipped: number;
  errors: string[];
}

export interface SyncTriggerResponse {
  user: { id: string; login: string };
  summary: SyncSummary;
}

/** Typed endpoint object for direct use in components that need live-only calls. */
export const api = {
  listDueConcepts: (token: string, signal?: AbortSignal) =>
    apiFetch<ListDueResponse>("/api/concepts", { accessToken: token, ...(signal ? { signal } : {}) }),

  listAllConcepts: (token: string, signal?: AbortSignal) =>
    apiFetch<ListAllResponse>("/api/concepts/all", { accessToken: token, ...(signal ? { signal } : {}) }),

  getConceptById: (token: string, conceptId: string, signal?: AbortSignal) =>
    apiFetch<{ user_id: string; concept: Concept }>(
      `/api/concepts/${encodeURIComponent(conceptId)}`,
      { accessToken: token, ...(signal ? { signal } : {}) },
    ),

  gradeAnswer: (token: string, conceptId: string, transcript: string, signal?: AbortSignal) =>
    apiFetch<GradeResult>("/api/grade", {
      method: "POST",
      accessToken: token,
      body: JSON.stringify({ concept_id: conceptId, transcript }),
      ...(signal ? { signal } : {}),
    }),

  // Used by frontend/app/dashboard/page.tsx (auto-sync + manual sync button).
  triggerSync: (token: string, signal?: AbortSignal) =>
    apiFetch<SyncTriggerResponse>("/api/sync", {
      method: "POST",
      accessToken: token,
      ...(signal ? { signal } : {}),
    }),

  transcribeAudio: async (
    token: string,
    blob: Blob,
    filename = "answer.webm",
    signal?: AbortSignal,
  ): Promise<{ transcript: string; error?: string }> => {
    const fd = new FormData();
    fd.append("audio", blob, filename);
    const res = await fetch(`${BACKEND}/api/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body, `API ${res.status} on POST /api/transcribe`);
    }
    return (await res.json()) as { transcript: string; error?: string };
  },

  // H1 (Trace 2): calendar event hook. Backend pulls the calendar_id from
  // server-side config — the client only sends (concept_id, next_review_timestamp).
  // Failures here are non-fatal (grade + SM-2 already succeeded); the backend
  // returns {status: "failed", error: ...} with HTTP 200, so we just log.
  scheduleReview: async (
    token: string,
    body: { concept_id: string; next_review_timestamp: number },
    signal?: AbortSignal,
  ): Promise<{ status: string; event?: unknown; error?: string }> => {
    try {
      return await apiFetch<{ status: string; event?: unknown; error?: string }>(
        "/api/schedule-review",
        {
          method: "POST",
          accessToken: token,
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        },
      );
    } catch (err) {
      // Calendar side-effect should never poison the grade UX.
      // eslint-disable-next-line no-console
      console.warn("[scheduleReview] failed:", err);
      return { status: "failed", error: String(err) };
    }
  },
};

// --- Quiz-UI compatible functions (mock or live) ---

/** Fetch a single concept by id. In live mode, tries the single-concept endpoint first
 * (works regardless of due status) and falls back to the due-list on 404 for backwards compat. */
export async function getConcept(
  id: string,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<Concept | null> {
  if (USING_MOCK) {
    await delay(300);
    return (findMockConcept(id) as Concept | undefined) ?? null;
  }
  // Try the single-concept endpoint first — works even if concept isn't due.
  try {
    const data = await api.getConceptById(accessToken ?? "", id, signal);
    return data.concept;
  } catch (err) {
    // 404 → fall through to due-list lookup (backwards compat).
    if (err instanceof ApiError && err.status === 404) {
      const data = await api.listDueConcepts(accessToken ?? "", signal);
      return data.due.find((c) => c.id === id) ?? null;
    }
    throw err;
  }
}

/** Transcribe recorded audio. In live mode, sends bearer-authed multipart to backend. */
export async function transcribeAudio(
  audio: Blob,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  if (USING_MOCK) {
    await delay(1100);
    return { transcript: MOCK_TRANSCRIPT };
  }
  return api.transcribeAudio(accessToken ?? "", audio, "answer.webm", signal);
}

/** Grade a transcript against a concept. In live mode, calls /api/grade with bearer auth. */
export async function gradeAnswer(
  req: GradeRequest,
  concept: Concept,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<GradeResult> {
  if (USING_MOCK) {
    await delay(1300);
    return mockGrade(concept, req.transcript);
  }
  return api.gradeAnswer(accessToken ?? "", concept.id, req.transcript, signal);
}

// A plausible spoken answer, used only in mock mode when the user records audio.
const MOCK_TRANSCRIPT =
  "I'd use memoization to cache the results of each subproblem in a lookup table, " +
  "so repeated calls return instantly instead of recomputing. That's basically dynamic programming.";

// Top-level re-export for components that import via named bindings
// (the quiz page uses `import { scheduleReview } from "@/lib/api"`) while
// the dashboard namespace still uses `api.scheduleReview(...)`. Keeps
// both call-site shapes working without a refactor.
export const scheduleReview = api.scheduleReview;
