/**
 * API layer. Talks to the FastAPI backend when NEXT_PUBLIC_BACKEND_URL is set;
 * serves mock responses when it's absent so the UI is fully demoable offline.
 * Swapping to the real backend is a single env var — no UI changes required.
 */
import { findMockConcept, mockGrade } from "./mock";
import type { Concept, GradeRequest, GradeResult, TranscribeResult } from "./types";

// Re-export so files can import Concept/GradeResult from either @/lib/api or @/lib/types.
export type { Concept, GradeResult };

const BACKEND = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "").replace(/\/$/, "");
export const USING_MOCK = BACKEND === "";

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

export interface SyncStatusResponse {
  user: { id: string; login: string };
  last_sync: number | null;
  last_sync_iso: string | null;
}

/** Typed endpoint object for direct use in components that need live-only calls. */
export const api = {
  listDueConcepts: (token: string) =>
    apiFetch<ListDueResponse>("/api/concepts", { accessToken: token }),

  gradeAnswer: (token: string, conceptId: string, transcript: string) =>
    apiFetch<GradeResult>("/api/grade", {
      method: "POST",
      accessToken: token,
      body: JSON.stringify({ concept_id: conceptId, transcript }),
    }),

  triggerSync: (token: string) =>
    apiFetch<SyncTriggerResponse>("/api/sync", {
      method: "POST",
      accessToken: token,
    }),

  syncStatus: (token: string) =>
    apiFetch<SyncStatusResponse>("/api/sync/status", { accessToken: token }),

  transcribeAudio: async (
    token: string,
    blob: Blob,
    filename = "answer.webm",
  ): Promise<{ transcript: string; error?: string }> => {
    const fd = new FormData();
    fd.append("audio", blob, filename);
    const res = await fetch(`${BACKEND}/api/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(res.status, body, `API ${res.status} on POST /api/transcribe`);
    }
    return (await res.json()) as { transcript: string; error?: string };
  },
};

// --- Quiz-UI compatible functions (mock or live) ---

/** Fetch a single concept by id. In live mode, pulls the due list and finds by id. */
export async function getConcept(id: string, accessToken?: string): Promise<Concept | null> {
  if (USING_MOCK) {
    await delay(300);
    return (findMockConcept(id) as Concept | undefined) ?? null;
  }
  const data = await api.listDueConcepts(accessToken ?? "");
  return data.due.find((c) => c.id === id) ?? null;
}

/** Transcribe recorded audio. In live mode, sends bearer-authed multipart to backend. */
export async function transcribeAudio(
  audio: Blob,
  accessToken?: string,
): Promise<TranscribeResult> {
  if (USING_MOCK) {
    await delay(1100);
    return { transcript: MOCK_TRANSCRIPT };
  }
  return api.transcribeAudio(accessToken ?? "", audio);
}

/** Grade a transcript against a concept. In live mode, calls /api/grade with bearer auth. */
export async function gradeAnswer(
  req: GradeRequest,
  concept: Concept,
  accessToken?: string,
): Promise<GradeResult> {
  if (USING_MOCK) {
    await delay(1300);
    return mockGrade(concept, req.transcript);
  }
  return api.gradeAnswer(accessToken ?? "", concept.id, req.transcript);
}

// A plausible spoken answer, used only in mock mode when the user records audio.
const MOCK_TRANSCRIPT =
  "I'd use memoization to cache the results of each subproblem in a lookup table, " +
  "so repeated calls return instantly instead of recomputing. That's basically dynamic programming.";
