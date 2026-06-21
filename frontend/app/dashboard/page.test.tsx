/**
 * Page-level tests for the dashboard.
 *
 * These exercise the orchestrator wiring (effect lifecycle, auto-sync,
 * sync error handling, unauth redirect) — the leaf components are covered
 * separately in components.test.tsx. Mocks: next-auth useSession,
 * next/navigation useRouter, the api module.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Module mocks (must come before any component import) ──────────────

const mockReplace = vi.fn();
const mockPush = vi.fn();
const mockSignOut = vi.fn();
const mockListDueConcepts = vi.fn();
const mockListAllConcepts = vi.fn();
const mockTriggerSync = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));

vi.mock("next-auth/react", () => ({
  useSession: vi.fn(),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

vi.mock("@/lib/api", () => ({
  api: {
    listDueConcepts: (...args: unknown[]) => mockListDueConcepts(...args),
    listAllConcepts: (...args: unknown[]) => mockListAllConcepts(...args),
    triggerSync: (...args: unknown[]) => mockTriggerSync(...args),
  },
  USING_MOCK: false,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: string, message: string) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

// Imports below MUST come after vi.mock calls so the mocked modules
// are what the dashboard pulls in.
import { useSession } from "next-auth/react";
import { ApiError } from "@/lib/api";
import Dashboard from "./page";
import type { Concept } from "@/lib/types";

const useSessionMock = vi.mocked(useSession);

const sessionUser = {
  id: "u_1",
  name: "Aryan",
  email: "a@example.com",
  image: null,
  accessToken: "test-token",
};

// ─── Fixtures ───────────────────────────────────────────────────────────

const dueConcept: Concept = {
  id: "u_1:42:memoization",
  concept: "Memoization",
  roast_text: "r",
  question_text: "q",
  answer_hint: "h",
  next_review: new Date(Date.now() - 60_000).toISOString(), // overdue
  interval: 5,
  ease_factor: 2.5,
  repetitions: 1,
  repo: "octo/cat",
  pr_number: 42,
  pr_title: "add LRU cache",
  source_type: "pr",
};

const upcomingConcept: Concept = {
  ...dueConcept,
  id: "u_1:99:future",
  pr_number: 99,
  pr_title: "future PR",
  next_review: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

// ─── Tests ──────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks();
  // P2-D3 (Trace M1): sessionStorage is per-tab and persists across
  // renders in the same test run. Reset between tests so the
  // auto-synced flag from one test doesn't bleed into the next.
  sessionStorage.clear();
});

describe("Dashboard / unauthenticated", () => {
  it("redirects to /?callbackUrl=<dashboard> when status=unauthenticated", async () => {
    useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" } as never);
    render(<Dashboard />);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(
        expect.stringContaining("/?callbackUrl="),
      );
    });
  });

  it("does NOT fetch concepts while unauthenticated", async () => {
    useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" } as never);
    render(<Dashboard />);
    // Give the effect a tick to (not) fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockListDueConcepts).not.toHaveBeenCalled();
    expect(mockListAllConcepts).not.toHaveBeenCalled();
  });
});

describe("Dashboard / loading", () => {
  it("renders a loading pulse while session is loading", () => {
    useSessionMock.mockReturnValue({ data: null, status: "loading" } as never);
    render(<Dashboard />);
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();
  });
});

describe("Dashboard / authenticated, fetch results", () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({
      data: { user: sessionUser, accessToken: "test-token" },
      status: "authenticated",
    } as never);
  });

  it("renders overdue concepts in the 'due now' queue", async () => {
    mockListDueConcepts.mockResolvedValue({
      user_id: "u_1",
      due: [dueConcept],
      count: 1,
    });
    mockListAllConcepts.mockResolvedValue({
      user_id: "u_1",
      concepts: [dueConcept, upcomingConcept],
      count: 2,
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Memoization").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText(/day streak/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Concept graph/i)).toBeInTheDocument();
    expect(screen.getByText(/1 overdue/i)).toBeInTheDocument();
    expect(screen.getByText(/2 concepts tracked/i)).toBeInTheDocument();
  });

  it("renders 'All clear.' when there are no due concepts", async () => {
    mockListDueConcepts.mockResolvedValue({ user_id: "u_1", due: [], count: 0 });
    mockListAllConcepts.mockResolvedValue({ user_id: "u_1", concepts: [], count: 0 });
    mockTriggerSync.mockResolvedValue({}); // auto-sync

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText(/All clear/i)).toBeInTheDocument();
    });
  });

  it("shows the fetch error when listDueConcepts rejects", async () => {
    mockListDueConcepts.mockRejectedValue(new Error("boom"));
    mockListAllConcepts.mockResolvedValue({ user_id: "u_1", concepts: [], count: 0 });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load concepts/i)).toBeInTheDocument();
    });
  });

  it("calls signOut({ callbackUrl: '/' }) when listDueConcepts returns 401", async () => {
    // P2-D1 (Trace H1): an expired-token 401 used to strand the user on
    // a broken dashboard. Now the dashboard bounces them back to "/"
    // via signOut so the next session starts clean.
    mockListDueConcepts.mockRejectedValue(
      new ApiError(401, "", "API 401 on GET /api/concepts"),
    );
    mockListAllConcepts.mockResolvedValue({ user_id: "u_1", concepts: [], count: 0 });

    render(<Dashboard />);

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledWith({ callbackUrl: "/" });
    });
    // The fetch error banner should NOT render — we're navigating away.
    expect(screen.queryByText(/failed to load concepts/i)).not.toBeInTheDocument();
  });

  it("auto-triggers sync when there are no due concepts on first load", async () => {
    mockListDueConcepts.mockResolvedValue({ user_id: "u_1", due: [], count: 0 });
    mockListAllConcepts.mockResolvedValue({ user_id: "u_1", concepts: [], count: 0 });
    mockTriggerSync.mockResolvedValue({});

    render(<Dashboard />);

    await waitFor(() => {
      expect(mockTriggerSync).toHaveBeenCalledWith("test-token", expect.any(AbortSignal));
    });
    // P2-D3 (Trace M1): after the auto-sync fires, sessionStorage must
    // carry the flag so a remount doesn't re-fire it.
    expect(sessionStorage.getItem("vibeschool:autoSynced")).toBe("1");
  });

  it("skips auto-sync on remount when sessionStorage already has the flag", async () => {
    // P2-D3 (Trace M1): simulate a remount where the previous mount
    // already auto-synced. The dashboard must not re-fire triggerSync
    // even though hasAutoSyncedRef resets to false on remount.
    sessionStorage.setItem("vibeschool:autoSynced", "1");
    mockListDueConcepts.mockResolvedValue({ user_id: "u_1", due: [], count: 0 });
    mockListAllConcepts.mockResolvedValue({ user_id: "u_1", concepts: [], count: 0 });
    mockTriggerSync.mockResolvedValue({});

    render(<Dashboard />);

    // Wait for the initial fetch to settle.
    await waitFor(() => {
      expect(screen.getByText(/All clear/i)).toBeInTheDocument();
    });
    // Give the effect chain a tick — sync should NOT have fired.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockTriggerSync).not.toHaveBeenCalled();
  });

  it("does NOT auto-sync when there are due concepts", async () => {
    mockListDueConcepts.mockResolvedValue({
      user_id: "u_1",
      due: [dueConcept],
      count: 1,
    });
    mockListAllConcepts.mockResolvedValue({
      user_id: "u_1",
      concepts: [dueConcept],
      count: 1,
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getAllByText("Memoization").length).toBeGreaterThanOrEqual(1);
    });
    // Give the effect chain a tick — sync should NOT have fired.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockTriggerSync).not.toHaveBeenCalled();
  });

  it("manual sync button click triggers triggerSync", async () => {
    const user = userEvent.setup();
    mockListDueConcepts.mockResolvedValue({
      user_id: "u_1",
      due: [dueConcept],
      count: 1,
    });
    mockListAllConcepts.mockResolvedValue({
      user_id: "u_1",
      concepts: [dueConcept],
      count: 1,
    });
    mockTriggerSync.mockResolvedValue({});

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^sync$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^sync$/i }));

    await waitFor(() => {
      expect(mockTriggerSync).toHaveBeenCalledWith("test-token", expect.any(AbortSignal));
    });
  });

  it("renders commit-sourced concepts in a separate section", async () => {
    const commitConcept: Concept = {
      ...dueConcept,
      id: "u_1:c-abc1234:trace",
      pr_number: 0,
      source_type: "commit",
      commit_sha: "abc1234567890def",
      concept: "Stack traces",
    };
    mockListDueConcepts.mockResolvedValue({ user_id: "u_1", due: [], count: 0 });
    mockListAllConcepts.mockResolvedValue({
      user_id: "u_1",
      concepts: [commitConcept],
      count: 1,
    });
    mockTriggerSync.mockResolvedValue({});

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("Stack traces")).toBeInTheDocument();
    });
    // "recent commits" appears in both the hero stats pill AND the
    // section label; assert at least one.
    expect(screen.getAllByText(/recent commits/i).length).toBeGreaterThanOrEqual(1);
    // Short SHA (first 7 chars) appears in the CommitRow.
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });
});
