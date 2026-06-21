/**
 * Pure-presentational tests for the dashboard card components.
 *
 * Each test renders one component with hand-built fixtures and asserts on
 * the rendered DOM. No network, no session, no router — these are leaf
 * components that take already-formatted data in.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Concept } from "@/lib/types";
import {
  CommitBlock,
  CommitRow,
  ConceptRow,
  DueCard,
  PRBlock,
  SectionLabel,
} from "./components";

const baseConcept: Concept = {
  id: "u_1:42:caching",
  concept: "Memoization",
  roast_text: "r",
  question_text: "q",
  answer_hint: "h",
  next_review: new Date().toISOString(),
  interval: 1,
  ease_factor: 2.5,
  repetitions: 0,
  repo: "octo/cat",
  pr_number: 42,
  pr_title: "add LRU cache",
  source_type: "pr",
};

describe("DueCard", () => {
  it("renders concept name + provenance + pr title + due time", () => {
    render(<DueCard concept={{ ...baseConcept, prTitle: "add LRU cache" }} />);
    expect(screen.getByText("Memoization")).toBeInTheDocument();
    expect(screen.getByText(/octo\/cat#42/)).toBeInTheDocument();
    expect(screen.getByText(/add LRU cache/)).toBeInTheDocument();
    // The due-time string is computed by formatDue; just assert it renders something.
    expect(screen.getByText(/due|overdue|in /)).toBeInTheDocument();
  });

  it("links to /quiz/<concept_id>", () => {
    render(<DueCard concept={{ ...baseConcept, prTitle: "x" }} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/quiz/u_1:42:caching");
  });

  it("uses coral accent for overdue concepts", () => {
    const overdue = {
      ...baseConcept,
      prTitle: "x",
      next_review: new Date(Date.now() - 60_000).toISOString(),
    };
    render(<DueCard concept={overdue} />);
    const link = screen.getByRole("link");
    expect(link.className).toMatch(/border-l-coral/);
  });

  it("renders commit provenance for commit-sourced concepts", () => {
    const c: Concept = {
      ...baseConcept,
      id: "u_1:c-abc1234:caching",
      source_type: "commit",
      pr_number: 0,
      commit_sha: "abc1234567890def",
    };
    render(<DueCard concept={{ ...c, prTitle: "first commit" }} />);
    expect(screen.getByText(/octo\/cat@abc1234/)).toBeInTheDocument();
  });
});

describe("ConceptRow", () => {
  it("renders concept name, mastery bar, and due label", () => {
    render(<ConceptRow concept={baseConcept} />);
    expect(screen.getByText("Memoization")).toBeInTheDocument();
    expect(screen.getByText(/^[0-9]+%$/)).toBeInTheDocument();
  });

  it("mastery percentage scales with interval", () => {
    const { rerender } = render(<ConceptRow concept={{ ...baseConcept, interval: 5 }} />);
    expect(screen.getByText(/^[0-9]+%$/)).toBeInTheDocument();
    // Mastery for interval=15 should be roughly 50%
    rerender(<ConceptRow concept={{ ...baseConcept, interval: 15 }} />);
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("links to the quiz page", () => {
    render(<ConceptRow concept={baseConcept} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/quiz/u_1:42:caching");
  });
});

describe("PRBlock", () => {
  it("renders PR header + concept count + each concept row", () => {
    render(
      <PRBlock
        pr={{
          pr_number: 42,
          repo: "octo/cat",
          title: "add LRU cache",
          merged_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          concepts: [
            { ...baseConcept, id: "u:42:a", concept: "Caching" },
            { ...baseConcept, id: "u:42:b", concept: "Memoization" },
          ],
        }}
      />,
    );
    expect(screen.getByText("add LRU cache")).toBeInTheDocument();
    expect(screen.getByText("2c")).toBeInTheDocument();
    expect(screen.getByText("Caching")).toBeInTheDocument();
    expect(screen.getByText("Memoization")).toBeInTheDocument();
  });
});

describe("CommitBlock", () => {
  it("renders commit header + each commit row", () => {
    render(
      <CommitBlock
        group={{
          repo: "octo/cat",
          concepts: [
            { ...baseConcept, id: "u:c-aaa:caching", concept: "Caching", source_type: "commit", pr_number: 0, commit_sha: "aaa1111" },
          ],
        }}
      />,
    );
    expect(screen.getByText(/1 commit ingested/)).toBeInTheDocument();
    expect(screen.getByText("Caching")).toBeInTheDocument();
  });
});

describe("CommitRow", () => {
  it("shows short SHA prominently (no PR number to anchor)", () => {
    const c: Concept = {
      ...baseConcept,
      id: "u:c-deadbeef:caching",
      source_type: "commit",
      pr_number: 0,
      commit_sha: "deadbeef1234",
    };
    render(<CommitRow concept={c} />);
    // The short SHA (first 7 chars) appears as a label.
    expect(screen.getByText("deadbee")).toBeInTheDocument();
    expect(screen.getByText("Memoization")).toBeInTheDocument();
  });
});

describe("SectionLabel", () => {
  it("renders children as uppercase eyebrow text", () => {
    render(<SectionLabel>due now</SectionLabel>);
    expect(screen.getByText("due now")).toBeInTheDocument();
  });
});
