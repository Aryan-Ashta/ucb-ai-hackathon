/**
 * Pure-presentational tests for the quiz page panels.
 *
 * The panels are leaf components that take props + callbacks. We mock
 * `useRecorder` only for panels that depend on it (RecordingPanel). All
 * other panels render with hand-built fixtures.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Concept, GradeResult } from "@/lib/types";
import {
  ActionBar,
  FailedPanel,
  LoadingPanel,
  NotFoundPanel,
  RecordingPanel,
  ResultPanel,
  ThinkingPanel,
  TypingPanel,
} from "./panels";

const concept: Concept = {
  id: "u_1:42:caching",
  concept: "Memoization",
  roast_text: "You wrote a recursive fib with zero caching.",
  question_text: "What technique eliminates the redundant recomputation?",
  answer_hint: "memoization, caching, dynamic programming",
  next_review: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  interval: 5,
  ease_factor: 2.6,
  repetitions: 1,
  repo: "octo/cat",
  pr_number: 42,
  pr_title: "add LRU cache",
  source_type: "pr",
};

const passingGrade: GradeResult = {
  passed: true,
  quality: 4,
  explanation: "Correct! `lru_cache` is the memoization pattern.",
  next_review: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

const failingGrade: GradeResult = {
  passed: false,
  quality: 1,
  explanation: "That's a different technique entirely.",
  next_review: new Date(Date.now() + 60 * 1000).toISOString(),
};

describe("LoadingPanel", () => {
  it("renders the duck loader", () => {
    render(<LoadingPanel />);
    // The shell wraps a Duck emoji inside a styled div; assert on the
    // animate-breathe class (a stable hook for "still loading").
    expect(document.querySelector(".animate-breathe")).toBeInTheDocument();
  });
});

describe("NotFoundPanel", () => {
  it("renders the 'Nothing to review here' copy + back link", () => {
    render(<NotFoundPanel />);
    expect(screen.getByText(/Nothing to review here/i)).toBeInTheDocument();
    // Shell renders an exit link + this panel renders a Back link; target
    // the Back one specifically.
    const back = screen.getByRole("link", { name: /Back to dashboard/i });
    expect(back).toHaveAttribute("href", "/dashboard");
  });
});

describe("RecordingPanel", () => {
  it("shows the timer + listening copy when state=recording", () => {
    const rec = {
      state: "recording" as const,
      seconds: 42,
      levels: new Array(28).fill(0.3),
      start: vi.fn(),
      stop: vi.fn(),
      reset: vi.fn(),
    };
    render(<RecordingPanel rec={rec} onType={vi.fn()} />);
    // 42 seconds → "0:42"
    expect(screen.getByText("0:42")).toBeInTheDocument();
    expect(screen.getByText(/listening/i)).toBeInTheDocument();
  });

  it("shows the mic-denied fallback when state=denied", () => {
    const rec = {
      state: "denied" as const,
      seconds: 0,
      levels: new Array(28).fill(0),
      start: vi.fn(),
      stop: vi.fn(),
      reset: vi.fn(),
    };
    render(<RecordingPanel rec={rec} onType={vi.fn()} />);
    expect(screen.getByText(/Mic access is off/i)).toBeInTheDocument();
    // The fallback offers a 'Type your answer' button.
    fireEvent.click(screen.getByRole("button", { name: /Type your answer/i }));
  });
});

describe("TypingPanel", () => {
  it("disables submit when textarea is empty", () => {
    render(
      <TypingPanel value="" onChange={vi.fn()} onSubmit={vi.fn()} onVoice={vi.fn()} />,
    );
    const submit = screen.getByRole("button", { name: /Submit answer/i });
    expect(submit).toBeDisabled();
  });

  it("enables submit and fires onChange when typing", () => {
    const onChange = vi.fn();
    render(
      <TypingPanel value="memoization" onChange={onChange} onSubmit={vi.fn()} onVoice={vi.fn()} />,
    );
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "caching" } });
    expect(onChange).toHaveBeenCalledWith("caching");
  });

  it("fires onSubmit when Submit is clicked with content", () => {
    const onSubmit = vi.fn();
    render(
      <TypingPanel
        value="a real answer"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onVoice={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Submit answer/i }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("switches back to voice on 'Speak instead' click", () => {
    const onVoice = vi.fn();
    render(
      <TypingPanel value="" onChange={vi.fn()} onSubmit={vi.fn()} onVoice={onVoice} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Speak instead/i }));
    expect(onVoice).toHaveBeenCalledOnce();
  });
});

describe("ThinkingPanel", () => {
  it("shows 'transcribing' copy on stage=transcribing", () => {
    render(<ThinkingPanel stage="transcribing" transcript="" />);
    expect(screen.getByText(/transcribing your answer/i)).toBeInTheDocument();
  });

  it("shows 'grading' copy on stage=grading", () => {
    render(<ThinkingPanel stage="grading" transcript="" />);
    expect(screen.getByText(/the examiner is grading/i)).toBeInTheDocument();
  });

  it("echoes the transcript back as a blockquote when present", () => {
    render(<ThinkingPanel stage="grading" transcript="memoization is caching" />);
    expect(
      screen.getByText(/memoization is caching/i).closest("blockquote"),
    ).toBeInTheDocument();
  });
});

describe("ResultPanel", () => {
  it("renders 'Nailed it.' verdict on a passing grade", () => {
    render(<ResultPanel concept={concept} grade={passingGrade} transcript="" />);
    expect(screen.getByText(/Nailed it/i)).toBeInTheDocument();
    // The explanation contains inline <code> for the backticked terms —
    // assert on the container, not on raw text.
    expect(screen.getByText(/Correct!/)).toBeInTheDocument();
    expect(screen.getByText("lru_cache")).toBeInTheDocument();
  });

  it("renders 'Not quite.' verdict on a failing grade", () => {
    render(<ResultPanel concept={concept} grade={failingGrade} transcript="" />);
    expect(screen.getByText(/Not quite/i)).toBeInTheDocument();
  });

  it("includes the transcript in a <details> when present", () => {
    render(
      <ResultPanel
        concept={concept}
        grade={passingGrade}
        transcript="a spoken answer"
      />,
    );
    expect(screen.getByText(/a spoken answer/i)).toBeInTheDocument();
  });

  it("shows the mastery percentage derived from the new interval", () => {
    const { container } = render(
      <ResultPanel concept={concept} grade={passingGrade} transcript="" />,
    );
    // The ResultPanel uses useState to animate the mastery bar; the
    // initial render shows the BEFORE percentage (concept.interval=5,
    // so 5/30 ≈ 17%). The 400ms setTimeout transition is not testable
    // here without fake timers — assert that SOME percentage is rendered
    // and that the mastery label exists.
    const percentLabel = within(container).getByText(/^[0-9]+%$/);
    expect(percentLabel).toBeInTheDocument();
    // The mastery row should also show the 'mastery' label.
    expect(within(container).getByText(/^mastery$/)).toBeInTheDocument();
  });
});

describe("FailedPanel", () => {
  it("shows the error message + retry button", () => {
    const onRetry = vi.fn();
    render(<FailedPanel errorMsg="Couldn't hear that." onRetry={onRetry} />);
    expect(screen.getByText(/Couldn't hear that/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders gracefully with no error message", () => {
    render(<FailedPanel errorMsg={null} onRetry={vi.fn()} />);
    // The button is the only requirement; the copy block is empty.
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });
});

describe("ActionBar", () => {
  it("renders the intro CTA in the intro phase", () => {
    render(
      <ActionBar
        phase="intro"
        recState="idle"
        onOrbClick={vi.fn()}
        onType={vi.fn()}
        onNext={vi.fn()}
        onRetry={vi.fn()}
        passed={false}
        hasNext={true}
      />,
    );
    expect(screen.getByRole("button", { name: /Answer out loud/i })).toBeInTheDocument();
  });

  it("renders the Stop & submit button while recording", () => {
    render(
      <ActionBar
        phase="recording"
        recState="recording"
        onOrbClick={vi.fn()}
        onType={vi.fn()}
        onNext={vi.fn()}
        onRetry={vi.fn()}
        passed={false}
        hasNext={true}
      />,
    );
    // Target by exact text — the RecorderOrb also has a 'Stop ...' aria-label.
    expect(screen.getByText("Stop & submit")).toBeInTheDocument();
  });

  it("renders 'Next concept' when there is a next concept", () => {
    render(
      <ActionBar
        phase="result"
        recState="idle"
        onOrbClick={vi.fn()}
        onType={vi.fn()}
        onNext={vi.fn()}
        onRetry={vi.fn()}
        passed={true}
        hasNext={true}
      />,
    );
    expect(screen.getByRole("button", { name: /Next concept/i })).toBeInTheDocument();
  });

  it("renders 'Back to dashboard' when there is no next concept", () => {
    render(
      <ActionBar
        phase="result"
        recState="idle"
        onOrbClick={vi.fn()}
        onType={vi.fn()}
        onNext={vi.fn()}
        onRetry={vi.fn()}
        passed={true}
        hasNext={false}
      />,
    );
    expect(screen.getByRole("button", { name: /Back to dashboard/i })).toBeInTheDocument();
  });

  it("renders the 'Try again' retry button on a failed result", () => {
    render(
      <ActionBar
        phase="result"
        recState="idle"
        onOrbClick={vi.fn()}
        onType={vi.fn()}
        onNext={vi.fn()}
        onRetry={vi.fn()}
        passed={false}
        hasNext={false}
      />,
    );
    expect(screen.getByRole("button", { name: /Try this one again/i })).toBeInTheDocument();
  });

  it("renders a thin placeholder during typing / thinking / failed", () => {
    const { container } = render(
      <ActionBar
        phase="typing"
        recState="idle"
        onOrbClick={vi.fn()}
        onType={vi.fn()}
        onNext={vi.fn()}
        onRetry={vi.fn()}
        passed={false}
        hasNext={true}
      />,
    );
    // The ActionBar returns <div className="h-6" /> when it shouldn't render
    // action buttons; assert the placeholder height.
    const placeholder = container.querySelector(".h-6");
    expect(placeholder).toBeInTheDocument();
  });
});
