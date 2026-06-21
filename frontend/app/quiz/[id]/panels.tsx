"use client";

/**
 * Panel components for the quiz page state machine.
 *
 * Each panel is a small "look" for one phase; the page orchestrator
 * decides which one to render based on `phase`. Pure presentational —
 * all state and effects live in page.tsx.
 *
 * Phase + Stage types live here so the page orchestrator and panels
 * share the same enum without each owning a duplicate.
 */
import { useEffect, useState } from "react";
import type { Concept, GradeResult } from "@/lib/types";
import { useRecorder } from "@/lib/useRecorder";
import { USING_MOCK } from "@/lib/api";
import { formatNextReview, formatTime, masteryPct } from "@/lib/format";
import { Mascot } from "@/components/Mascot";
import {
  ArrowIcon,
  CalendarIcon,
  CheckIcon,
  codeSpans,
  ExaminerBubble,
  Eyebrow,
  ProgressRail,
  RetryIcon,
  ScorePips,
} from "./components";
import { RecorderOrb, SparkBurst, ThinkingDots, WaveBars } from "./recorder-ui";

export type Phase =
  | "loading"
  | "notfound"
  | "speaking"
  | "intro"
  | "recording"
  | "typing"
  | "thinking"
  | "result"
  | "failed";
export type Stage = "transcribing" | "grading";

/* ─── Layout shell: header (exit + progress) + content column ───────────── */

export function Shell({ children, progress, wide }: { children: React.ReactNode; progress: number; wide?: boolean }) {
  return (
    <div className="min-h-screen bg-canvas text-ink flex flex-col">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line">
        <div className="mx-auto max-w-xl w-full px-5 py-3.5 flex items-center gap-4">
          <a
            href="/dashboard"
            aria-label="Exit to dashboard"
            className="shrink-0 text-ink-dim hover:text-ink transition text-xl leading-none -mt-0.5"
          >
            ✕
          </a>
          <ProgressRail value={progress} />
        </div>
      </header>
      <main className={`mx-auto w-full px-5 flex-1 flex flex-col transition-all ${wide ? "max-w-5xl" : "max-w-xl"}`}>{children}</main>
      {USING_MOCK && (
        <div className="pointer-events-none fixed bottom-2 right-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          mock data
        </div>
      )}
    </div>
  );
}

/* ─── Loading + notfound placeholders (kept inline because they're tiny) ── */

export function LoadingPanel({ progress = 0 }: { progress?: number } = {}) {
  return (
    <Shell progress={progress}>
      <div className="flex-1 grid place-items-center">
        <Mascot mood="idle" size={96} />
      </div>
    </Shell>
  );
}

export function NotFoundPanel({ progress = 0 }: { progress?: number } = {}) {
  return (
    <Shell progress={progress}>
      <div className="flex-1 grid place-items-center text-center px-6">
        <div className="flex flex-col items-center">
          <Mascot mood="idle" size={96} className="mb-2" />
          <h1 className="font-display text-2xl font-bold mb-2">Nothing to review here</h1>
          <p className="text-ink-dim mb-6 text-sm">
            This concept isn&apos;t in your queue. It may have been reviewed already.
          </p>
          <a
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-medium hover:bg-line transition"
          >
            Back to dashboard
          </a>
        </div>
      </div>
    </Shell>
  );
}

/* ─── Code excerpt panel (advanced questions only) ─────────────────────── */

export function CodeExcerptPanel({ concept }: { concept: Concept }) {
  const snippet = concept.code_snippet ?? "";
  const filePath = concept.file_path ?? "";
  if (!snippet) return null;

  // Build a GitHub link to the PR diff or commit if we have enough info.
  let githubUrl: string | null = null;
  if (concept.repo) {
    if (concept.source_type === "commit" && concept.commit_sha) {
      githubUrl = `https://github.com/${concept.repo}/commit/${concept.commit_sha}`;
    } else if (concept.pr_number) {
      githubUrl = `https://github.com/${concept.repo}/pull/${concept.pr_number}/files`;
    }
  }

  return (
    <div className="flex flex-col gap-2 animate-rise" style={{ animationDelay: "80ms" }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
            <path d="M5 4L2 8l3 4M11 4l3 4-3 4M9 2l-2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {filePath || "excerpt"}
        </div>
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 font-mono text-[10px] text-ink-faint hover:text-marigold transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            view on github
          </a>
        )}
      </div>
      <pre className="rounded-xl bg-[#0d1117] border border-line text-[12.5px] leading-[1.65] text-[#e6edf3] font-mono overflow-x-auto p-4 whitespace-pre">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}

/* ─── Recording panel ───────────────────────────────────────────────────── */

export function RecordingPanel({
  rec,
  onType,
}: {
  rec: ReturnType<typeof useRecorder>;
  onType: () => void;
}) {
  if (rec.state === "denied" || rec.state === "error") {
    return (
      <div className="flex-1 grid place-items-center text-center animate-fade">
        <div className="max-w-sm">
          <p className="font-display text-lg font-bold mb-1.5">
            {rec.state === "denied" ? "Mic access is off" : "No microphone here"}
          </p>
          <p className="text-ink-dim text-sm mb-6">
            {rec.state === "denied"
              ? "bananaduck needs your mic to hear you. Enable it in your browser, or type your answer instead."
              : "We couldn't reach a microphone. Type your answer instead."}
          </p>
          <button
            onClick={onType}
            className="inline-flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-medium hover:bg-line transition"
          >
            Type your answer <ArrowIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 animate-fade">
      <WaveBars levels={rec.levels} active={rec.state === "recording"} />
      <div className="font-mono text-2xl tabular-nums text-ink tracking-wide">
        {formatTime(rec.seconds)}
      </div>
      <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-faint flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-coral" />
        {rec.state === "requesting" ? "waiting for mic…" : "listening — answer out loud"}
      </p>
    </div>
  );
}

/* ─── Typed answer panel ────────────────────────────────────────────────── */

export function TypingPanel({
  value,
  onChange,
  onSubmit,
  onVoice,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onVoice: () => void;
}) {
  const canSubmit = value.trim().length > 0;
  return (
    <div className="flex-1 flex flex-col gap-4 animate-fade">
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) onSubmit();
        }}
        placeholder="Type your answer, the way you'd explain it to a teammate…"
        className="w-full min-h-[168px] flex-1 resize-none rounded-2xl bg-surface-1 border border-line focus:border-marigold focus:outline-none focus:ring-2 focus:ring-marigold/30 p-4 text-ink placeholder:text-ink-faint leading-relaxed transition-colors"
      />
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onVoice}
          className="flex items-center gap-2 text-ink-dim hover:text-ink text-sm font-medium transition"
        >
          <span>🎤</span> Speak instead
        </button>
        <span className="font-mono text-[11px] text-ink-faint hidden sm:block">
          ⌘ / Ctrl + ↵ to submit
        </span>
      </div>
      <button
        onClick={onSubmit}
        disabled={!canSubmit}
        className="btn-3d w-full rounded-2xl bg-marigold text-canvas font-bold text-lg py-4 active:translate-y-1 flex items-center justify-center gap-2 disabled:cursor-not-allowed"
      >
        Submit answer <ArrowIcon className="w-5 h-5" />
      </button>
    </div>
  );
}

/* ─── Speaking panel (TTS playback) ─────────────────────────────────────── */

export function SpeakingPanel() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 animate-fade py-8">
      <Mascot mood="thinking" size={96} />
      <p className="font-mono text-xs uppercase tracking-[0.16em] text-ink-faint flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-marigold animate-pulse" />
        speaking…
      </p>
    </div>
  );
}

/* ─── Thinking panel ────────────────────────────────────────────────────── */

export function ThinkingPanel({
  stage,
  transcript,
  seconds,
}: {
  stage: Stage;
  transcript: string;
  seconds?: number;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 animate-fade">
      <Mascot mood="thinking" size={100} />
      <div className="flex items-center gap-3 text-ink-dim -mt-1">
        <ThinkingDots />
        <span className="font-mono text-sm">
          {stage === "transcribing"
            ? `transcribing your answer…${seconds != null && seconds > 0 ? ` (${formatTime(seconds)})` : ""}`
            : "the examiner is grading…"}
        </span>
      </div>
      {transcript && (
        <blockquote className="max-w-md text-center text-ink-dim italic text-sm leading-relaxed border-t border-line pt-4">
          &ldquo;{transcript}&rdquo;
        </blockquote>
      )}
    </div>
  );
}

/* ─── Result panel ──────────────────────────────────────────────────────── */

export function ResultPanel({
  concept,
  grade,
  transcript,
}: {
  concept: Concept;
  grade: GradeResult;
  transcript: string;
}) {
  const passed = grade.passed;
  const tone = passed ? "mint" : "coral";
  const beforePct = masteryPct(concept.interval ?? 1, concept.repetitions ?? 0);
  // Use SM-2 interval + repetitions from the grade response (logical values,
  // unaffected by demo-mode time scaling). Fall back to concept values + 1 rep
  // if the server is still running pre-fix code and omits these fields.
  const afterPct = masteryPct(grade.interval ?? concept.interval ?? 1, grade.repetitions ?? (concept.repetitions ?? 0) + 1);
  const [pct, setPct] = useState(beforePct);

  useEffect(() => {
    const t = setTimeout(() => setPct(afterPct), 400);
    return () => clearTimeout(t);
  }, [afterPct]);

  return (
    <div className="flex-1 flex flex-col gap-6 animate-fade py-2">
      {/* Verdict */}
      <div className="relative flex flex-col items-center text-center pt-2">
        {passed && <SparkBurst />}
        <Mascot mood={passed ? "happy" : "angry"} size={110} className="mb-1" />
        <h1 className="font-display text-3xl font-extrabold tracking-tightest mb-3">
          {passed ? "Nailed it." : "Not quite."}
        </h1>
        <ScorePips quality={grade.quality} tone={tone} />
      </div>

      {/* Examiner feedback, review-comment styled */}
      <div className="rounded-2xl bg-surface-1 border border-line border-l-2 border-l-marigold px-4 py-3">
        <div className="font-mono text-[11px] uppercase tracking-wider text-ink-faint mb-1">
          examiner&apos;s note
        </div>
        <p
          className="font-mono text-sm leading-relaxed text-ink-dim"
          dangerouslySetInnerHTML={{ __html: codeSpans(grade.explanation) }}
        />
      </div>

      {/* What you said */}
      {transcript && (
        <details className="group">
          <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-ink-faint hover:text-ink-dim transition list-none">
            ▸ what you said
          </summary>
          <p className="mt-2 text-sm text-ink-dim italic leading-relaxed">&ldquo;{transcript}&rdquo;</p>
        </details>
      )}

      {/* Mastery + next review */}
      <div className="rounded-2xl bg-surface-1 border border-line px-4 py-4 flex flex-col gap-4">
        <div>
          <div className="flex justify-between font-mono text-xs text-ink-faint mb-1.5">
            <span>mastery</span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-marigold transition-[width] duration-700 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <CalendarIcon className="w-4 h-4 text-marigold" />
          <span className="text-ink-dim">Next review</span>
          <span className="font-mono text-ink ml-auto">{formatNextReview(grade.next_review)}</span>
        </div>
      </div>
    </div>
  );
}

/* ─── Failed (recoverable) panel ────────────────────────────────────────── */

export function FailedPanel({ errorMsg, onRetry }: { errorMsg: string | null; onRetry: () => void }) {
  return (
    <div className="flex-1 grid place-items-center text-center animate-fade">
      <div className="flex flex-col items-center">
        <Mascot mood="angry" size={96} className="mb-1" />
        <p className="text-ink-dim mb-6 max-w-sm">{errorMsg}</p>
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-medium hover:bg-line transition"
        >
          <RetryIcon className="w-4 h-4" /> Try again
        </button>
      </div>
    </div>
  );
}

/* ─── Bottom action bar ─────────────────────────────────────────────────── */

export function ActionBar({
  phase,
  recState,
  onOrbClick,
  onType,
  onNext,
  onRetry,
  passed,
  hasNext,
}: {
  phase: Phase;
  recState: ReturnType<typeof useRecorder>["state"];
  onOrbClick: () => void;
  onType: () => void;
  onNext: () => void;
  onRetry: () => void;
  passed: boolean;
  hasNext: boolean;
}) {
  // Typing has its own submit button inside the panel (keeps it next to the
  // textarea and clear of the mobile keyboard).
  if (
    phase === "loading" ||
    phase === "notfound" ||
    phase === "speaking" ||
    phase === "failed" ||
    phase === "thinking" ||
    phase === "typing"
  ) {
    return <div className="h-6" />;
  }

  return (
    <div className="sticky bottom-0 bg-gradient-to-t from-canvas via-canvas to-transparent pt-6">
      <div className="mx-auto max-w-xl px-5 pb-7">
        {phase === "intro" && (
          <div className="flex flex-col items-center gap-3">
            <button
              onClick={onOrbClick}
              className="btn-3d w-full rounded-2xl bg-marigold text-canvas font-bold text-lg py-4 active:translate-y-1 flex items-center justify-center gap-2.5"
            >
              <span className="text-xl">🎤</span> Answer out loud
            </button>
            <button
              onClick={onType}
              className="text-ink-dim hover:text-ink text-sm font-medium transition"
            >
              Prefer to type? Write your answer instead
            </button>
          </div>
        )}

        {phase === "recording" && recState === "recording" && (
          <div className="flex flex-col items-center gap-4">
            <RecorderOrb recording onClick={onOrbClick} />
            <button onClick={onOrbClick} className="text-ink-dim hover:text-ink text-sm font-medium transition">
              Stop &amp; submit
            </button>
          </div>
        )}

        {phase === "result" && (
          <div className="flex flex-col gap-3">
            <button
              onClick={onNext}
              className="btn-3d w-full rounded-2xl bg-marigold text-canvas font-bold text-lg py-4 active:translate-y-1 flex items-center justify-center gap-2"
            >
              {hasNext ? "Next concept" : "Back to dashboard"} <ArrowIcon className="w-5 h-5" />
            </button>
            {!passed && (
              <button
                onClick={onRetry}
                className="w-full rounded-2xl bg-surface-2 text-ink font-medium py-3 hover:bg-line transition flex items-center justify-center gap-2"
              >
                <RetryIcon className="w-4 h-4" /> Try this one again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Animated audio badge — shown on the element currently being voiced ── */

function AudioBadge({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-2">
      <span className="inline-flex items-end gap-[2.5px]" aria-hidden>
        {[5, 9, 7, 11, 6, 8, 5].map((h, i) => (
          <span
            key={i}
            className="inline-block w-[2.5px] rounded-full bg-marigold animate-pulse"
            style={{ height: `${h}px`, animationDelay: `${i * 80}ms`, animationDuration: "1s" }}
          />
        ))}
      </span>
      {label && (
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-marigold">
          {label}
        </span>
      )}
    </div>
  );
}

/* ─── Convenience header pieces (used by page.tsx between phases) ───────── */

export function ConceptEyebrow({ concept }: { concept: Concept }) {
  return (
    <Eyebrow concept={concept} />
  );
}

export function QuestionHero({ concept, isSpeaking }: { concept: Concept; isSpeaking?: boolean }) {
  return (
    <div className="animate-rise" style={{ animationDelay: "120ms" }}>
      {isSpeaking && <AudioBadge label="reading question" />}
      <h1 className="font-display text-[1.7rem] sm:text-3xl font-bold leading-[1.18] tracking-tightest text-balance">
        {concept.question_text}
      </h1>
    </div>
  );
}

export function RoastBubble({ roast, isSpeaking }: { roast: string; isSpeaking?: boolean }) {
  return <ExaminerBubble roast={roast} isSpeaking={isSpeaking} />;
}
