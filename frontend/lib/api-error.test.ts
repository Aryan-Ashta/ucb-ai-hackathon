import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { apiErrorToMessage, isAbortError } from "./api-error";

describe("isAbortError", () => {
  it("detects DOMException AbortError", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  });
  it("detects plain-object {name: 'AbortError'} shape", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });
  it("ignores other DOMExceptions", () => {
    expect(isAbortError(new DOMException("boom", "NetworkError"))).toBe(false);
  });
  it("ignores unrelated errors", () => {
    expect(isAbortError(new Error("nope"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});

describe("apiErrorToMessage", () => {
  it("maps 401 to a re-auth prompt", () => {
    expect(apiErrorToMessage(new ApiError(401, "{}", "x"), "ctx")).toBe(
      "Your session expired. Please sign in again.",
    );
  });
  it("maps 403 to a permission prompt", () => {
    expect(apiErrorToMessage(new ApiError(403, "{}", "x"), "ctx")).toBe(
      "You don't have access to this resource.",
    );
  });
  it("maps 404 to 'Not found.'", () => {
    expect(apiErrorToMessage(new ApiError(404, "{}", "x"), "ctx")).toBe("Not found.");
  });
  it("maps 413 to a too-large message", () => {
    expect(apiErrorToMessage(new ApiError(413, "{}", "x"), "ctx")).toBe(
      "That file is too large. Try a smaller one.",
    );
  });
  it("maps 415 to an unsupported-format message", () => {
    expect(apiErrorToMessage(new ApiError(415, "{}", "x"), "ctx")).toBe(
      "Unsupported format. Try a different file type.",
    );
  });
  it("maps 429 to a rate-limit message", () => {
    expect(apiErrorToMessage(new ApiError(429, "{}", "x"), "ctx")).toBe(
      "Slow down a moment — too many requests.",
    );
  });
  it("maps 5xx to a generic retry prompt", () => {
    expect(apiErrorToMessage(new ApiError(503, "{}", "x"), "ctx")).toBe(
      "bananaduck is taking a quick break. Try again in a moment.",
    );
  });
  it("maps unknown 4xx to a status-coded message", () => {
    expect(apiErrorToMessage(new ApiError(418, "{}", "x"), "ctx")).toBe(
      "Request failed (418).",
    );
  });
  it("maps TypeError to a backend-down message", () => {
    expect(apiErrorToMessage(new TypeError("fetch failed"), "ctx")).toBe(
      "Can't reach bananaduck — is the backend running on localhost:8000?",
    );
  });
  it("falls back to a generic message for unknown errors", () => {
    expect(apiErrorToMessage("weird", "ctx")).toBe("Something went wrong. Try again.");
    expect(apiErrorToMessage({ arbitrary: "object" }, "ctx")).toBe(
      "Something went wrong. Try again.",
    );
  });

  it("logs the raw error with the supplied context label", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiErrorToMessage(new ApiError(500, "boom", "oops"), "listDueConcepts");
    expect(spy).toHaveBeenCalledWith(
      "[listDueConcepts] failed:",
      expect.stringContaining("oops"),
      expect.anything(),
    );
    spy.mockRestore();
  });
});
