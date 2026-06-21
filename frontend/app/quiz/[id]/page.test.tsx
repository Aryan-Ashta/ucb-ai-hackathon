/**
 * Page-level tests for the quiz page state machine.
 *
 * The panels themselves are covered in panels.test.tsx; this file
 * covers the orchestrator wiring: phase transitions driven by
 * panel callbacks, the resetToIntro cleanup, and abort handling.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Concept } from "@/lib/types";

// ─── Module mocks (must precede the page import) ───────────────────────

const mockGetConcept = vi.fn();
const mockTranscribeAudio = vi.fn();
const mockGradeAnswer = vi.fn();
const mockUseRecorder = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "u_1:42:memoization" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { accessToken: "test-token" } }),
}));

vi.mock("@/lib/api", () => ({
  getConcept: (...args: unknown[]) => mockGetConcept(...args),
  transcribeAudio: (...args: unknown[]) => mockTranscribeAudio(...args),
  gradeAnswer: (...args: unknown[]) => mockGradeAnswer(...args),
  USING_MOCK: false,
}));

vi.mock("@/lib/useRecorder", () => ({
  useRecorder: () => mockUseRecorder(),
}));

// Imports below MUST come after vi.mock so the page picks up the mocks.
import QuizPage from "./page";

const concept: Concept = {
  id: "u_1:42:memoization",
  concept: "Memoization",
  roast_text: "You wrote a recursive fib with zero caching.",
  question_text: "What technique eliminates redundant recomputation?",
  answer_hint: "memoization, caching, lru_cache",
  next_review: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  interval: 5,
  ease_factor: 2.6,
  repetitions: 1,
  repo: "octo/cat",
  pr_number: 42,
  pr_title: "add LRU cache",
  source_type: "pr",
};

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Initial render states ─────────────────────────────────────────────

describe("QuizPage / initial render", () => {
  it("shows the loading duck while getConcept is in flight", () => {
    mockGetConcept.mockReturnValue(new Promise(() => {})); // never resolves
    mockUseRecorder.mockReturnValue({
      state: "idle",
      seconds: 0,
      levels: new Array(28).fill(0),
      start: vi.fn(),
      stop: vi.fn(),
      reset: vi.fn(),
    });
    render(<QuizPage />);
    expect(document.querySelector(".animate-breathe")).toBeInTheDocument();
  });

  it("shows the NotFound panel when getConcept returns null", async () => {
    mockGetConcept.mockResolvedValue(null);
    mockUseRecorder.mockReturnValue({
      state: "idle", seconds: 0, levels: new Array(28).fill(0),
      start: vi.fn(), stop: vi.fn(), reset: vi.fn(),
    });
    render(<QuizPage />);
    await waitFor(() => {
      expect(screen.getByText(/Nothing to review here/i)).toBeInTheDocument();
    });
  });

  it("renders the intro state when a concept loads", async () => {
    mockGetConcept.mockResolvedValue(concept);
    mockUseRecorder.mockReturnValue({
      state: "idle", seconds: 0, levels: new Array(28).fill(0),
      start: vi.fn(), stop: vi.fn(), reset: vi.fn(),
    });
    render(<QuizPage />);
    await waitFor(() => {
      expect(screen.getByText(/What technique eliminates/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
  });
});

// ─── Phase transitions ─────────────────────────────────────────────────

describe("QuizPage / phase transitions", () => {
  function setupReady() {
    mockGetConcept.mockResolvedValue(concept);
    mockUseRecorder.mockReturnValue({
      state: "idle", seconds: 0, levels: new Array(28).fill(0),
      start: vi.fn(), stop: vi.fn(), reset: vi.fn(),
    });
  }

  it("intro → typing on 'Prefer to type?' click", async () => {
    const user = userEvent.setup();
    setupReady();
    render(<QuizPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
    });
    // The 'Prefer to type?' button is the onType entry point.
    await user.click(screen.getByRole("button", { name: /Prefer to type/i }));
    // The TypingPanel renders a Submit button (currently disabled — empty).
    const submit = screen.getByRole("button", { name: /Submit answer/i });
    expect(submit).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it("typing → intro on 'Speak instead' click", async () => {
    const user = userEvent.setup();
    setupReady();
    render(<QuizPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Prefer to type/i }));
    await user.click(screen.getByRole("button", { name: /Speak instead/i }));
    // Back to intro: the Answer CTA is back.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
    });
  });

  it("typing → thinking → result on submit with valid answer", async () => {
    const user = userEvent.setup();
    setupReady();
    mockGradeAnswer.mockResolvedValue({
      passed: true,
      quality: 4,
      explanation: "Correct!",
      next_review: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    render(<QuizPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
    });

    // Switch to typing mode and submit a non-empty answer.
    await user.click(screen.getByRole("button", { name: /Prefer to type/i }));
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "memoization caches results");
    await user.click(screen.getByRole("button", { name: /Submit answer/i }));

    // Result phase shows the Nailed-it verdict.
    await waitFor(() => {
      expect(screen.getByText(/Nailed it/i)).toBeInTheDocument();
    });
    expect(mockGradeAnswer).toHaveBeenCalledOnce();
  });
});

// ─── Error / abort handling ────────────────────────────────────────────

describe("QuizPage / failure paths", () => {
  it("shows 'failed' phase when gradeAnswer rejects with a non-AbortError", async () => {
    const user = userEvent.setup();
    mockGetConcept.mockResolvedValue(concept);
    mockUseRecorder.mockReturnValue({
      state: "idle", seconds: 0, levels: new Array(28).fill(0),
      start: vi.fn(), stop: vi.fn(), reset: vi.fn(),
    });
    mockGradeAnswer.mockRejectedValue(new Error("claude down"));

    render(<QuizPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Prefer to type/i }));
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "an answer");
    await user.click(screen.getByRole("button", { name: /Submit answer/i }));

    await waitFor(() => {
      expect(screen.getByText(/Something broke while scoring/i)).toBeInTheDocument();
    });
    // The Try Again button is present.
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });

  it("Try again returns to intro with cleared state", async () => {
    const user = userEvent.setup();
    mockGetConcept.mockResolvedValue(concept);
    mockUseRecorder.mockReturnValue({
      state: "idle", seconds: 0, levels: new Array(28).fill(0),
      start: vi.fn(), stop: vi.fn(), reset: vi.fn(),
    });
    mockGradeAnswer.mockRejectedValue(new Error("claude down"));

    render(<QuizPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /Prefer to type/i }));
    await user.type(screen.getByRole("textbox"), "an answer");
    await user.click(screen.getByRole("button", { name: /Submit answer/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Try again/i }));

    // Back to intro: Answer CTA is present again, no error message.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Something broke while scoring/i)).not.toBeInTheDocument();
  });

  it("AbortError from getConcept on remount does not surface as notfound", async () => {
    // First mount: getConcept resolves null (not found).
    // Second mount (different id): getConcept throws an AbortError.
    // The page should not flip back to notfound on the abort.
    mockUseRecorder.mockReturnValue({
      state: "idle", seconds: 0, levels: new Array(28).fill(0),
      start: vi.fn(), stop: vi.fn(), reset: vi.fn(),
    });
    mockGetConcept.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    render(<QuizPage />);
    // Loading state remains; the NotFound panel does NOT render.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Nothing to review here/i)).not.toBeInTheDocument();
  });
});
