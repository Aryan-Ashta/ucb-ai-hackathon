/**
 * Thin fetch wrapper that injects the NextAuth GitHub access token and
 * talks to the FastAPI backend. Every protected backend endpoint expects
 * `Authorization: Bearer <github-access-token>`.
 */
const BACKEND =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

export interface ApiFetchOptions extends Omit<RequestInit, "headers"> {
  accessToken?: string;
  headers?: HeadersInit;
}

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

export async function apiFetch<T = unknown>(
  path: string,
  { accessToken, headers, ...init }: ApiFetchOptions = {}
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
      `API ${res.status} ${res.statusText} on ${init.method ?? "GET"} ${path}`
    );
  }
  // 204 No Content
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

// Typed endpoints (one per backend route) ----------------------------------

export interface Concept {
  id: string;
  concept: string;
  roast_text: string;
  question_text: string;
  answer_hint: string;
  next_review: string;
  interval: number;
  ease_factor: number;
  repetitions: number;
}

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

export interface GradeResult {
  passed: boolean;
  quality: number;
  explanation: string;
  next_review: string;
}

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
};
