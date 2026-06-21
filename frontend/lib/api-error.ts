/**
 * Centralized frontend error → user-facing message mapping.
 *
 * Goals:
 *   • One place to decide what HTTP statuses mean for the user
 *     (401 = re-auth, 5xx = backend blip, TypeError = backend down).
 *   • Never leak raw "API 500 internal server error" strings into the UI —
 *     the dashboard was leaking `body` strings into a chip before this
 *     refactor; `friendlyFetchError` collapsed that.
 *   • Always log the raw error to console.warn so debugging visibility is
 *     preserved in the browser console (P2-F6 partially closed: friendly
 *     mapping; raw body still in console.warn, not UI).
 *   • One AbortError detector that handles both DOMException and the
 *     shape Next.js's fetch sometimes returns.
 */
import { ApiError } from "./api";

/**
 * Friendly message for any thrown value. Always logs the raw error
 * (with the supplied `context` label) so debugging stays in the console.
 *
 * Use for: fetch() failures, apiFetch<T>() failures, any user-visible
 * error chip / banner.
 */
export function apiErrorToMessage(err: unknown, context: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.warn(`[${context}] failed:`, raw, err);

  if (err instanceof ApiError) {
    if (err.status === 401) return "Your session expired. Please sign in again.";
    if (err.status === 403) return "You don't have access to this resource.";
    if (err.status === 404) return "Not found.";
    if (err.status === 413) return "That file is too large. Try a smaller one.";
    if (err.status === 415) return "Unsupported format. Try a different file type.";
    if (err.status === 429) return "Slow down a moment — too many requests.";
    if (err.status >= 500 && err.status <= 599) {
      return "VibeSchool is taking a quick break. Try again in a moment.";
    }
    return `Request failed (${err.status}).`;
  }

  // Fetch network failure (backend down, CORS, offline) surfaces as TypeError.
  if (err instanceof TypeError) {
    return "Can't reach VibeSchool — is the backend running on localhost:8000?";
  }
  return "Something went wrong. Try again.";
}

/**
 * AbortError detector — works for both DOMException and the plain-object
 * shape Next.js's fetch sometimes returns when an AbortController fires.
 * `quiz/page.tsx` had two near-identical copies of this check before.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err && typeof err === "object" && "name" in err) {
    return (err as { name?: string }).name === "AbortError";
  }
  return false;
}
