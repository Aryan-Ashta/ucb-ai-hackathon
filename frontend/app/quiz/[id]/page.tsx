"use client";

import { gradeAnswer, getConcept, transcribeAudio, USING_MOCK } from "@/lib/api";
import type { Concept, GradeResult } from "@/lib/types";
import { useRecorder } from "@/lib/useRecorder";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowIcon,
  CalendarIcon,
  CheckIcon,
  codeSpans,
  Duck,
  Eyebrow,
  ExaminerBubble,
  ProgressRail,
  RetryIcon,
  ScorePips,
} from "./components";
import { RecorderOrb, SparkBurst, ThinkingDots, WaveBars } from "./recorder-ui";
import { MOCK_CONCEPTS } from "@/lib/mock";

type Phase =
  | "loading"
  | "notfound"
  | "intro"
  | "recording"
  | "typing"
  | "thinking"
  | "result"
  | "failed";
type Stage = "transcribing" | "grading";

export default function QuizPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const router = useRouter();
  const { data: session } = useSession();
  const rec = useRecorder();

  const [concept, setConcept] = useState<Concept | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [stage, setStage] = useState<Stage>("transcribing");
  const [transcript, setTranscript] = useState("");
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  // Load (or reload, on "Next concept") the concept for this id.
  useEffect(() => {
    const ctrl = new AbortController();
    setPhase("loading");
    setGrade(null);
    setTranscript("");
    setErrorMsg(null);
    setTyped("");
    rec.reset();
    getConcept(id, session?.accessToken ?? undefined, ctrl.signal)
      .then((c) => {
        setConcept(c);
        setPhase(c ? "intro" : "notfound");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err && typeof err === "object" && "name" in err && (err as { name?: string }).name === "AbortError") return;
        setConcept(null);
        setPhase("notfound");
      });
    return () => ctrl.abort();
    // rec.reset is stable; intentionally keyed on id only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const userId = id.split(":")[0] || "demo";

  const runGrading = useCallback(
    // `directText` is a typed answer — it skips transcription and goes straight
    // to grading. Audio answers are transcribed first.
    async (audio: Blob | null, directText?: string) => {
      if (!concept) return;
      const ctrl = new AbortController();
      setPhase("thinking");
      setErrorMsg(null);
      try {
        let text = directText?.trim() ?? "";
        if (!directText) {
          setStage("transcribing");
          const r = await transcribeAudio(audio!, session?.accessToken ?? undefined, ctrl.signal);
          if (r.error || !r.transcript.trim()) {
            setErrorMsg(r.error ?? "Couldn't hear that one. Give it another go.");
            setPhase("failed");
            return;
          }
          text = r.transcript;
        }
        setTranscript(text);
        setStage("grading");
        const g = await gradeAnswer({ user_id: userId, concept_id: concept.id, transcript: text }, concept, session?.accessToken ?? undefined, ctrl.signal);
        setGrade(g);
        setPhase("result");
      } catch (err: unknown) {
        if (err && typeof err === "object" && "name" in err && (err as { name?: string }).name === "AbortError") return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setErrorMsg("Something broke while scoring that. Try again in a moment.");
        setPhase("failed");
      }
    },
    [concept, userId, session?.accessToken],
  );

  const handleOrbClick = useCallback(async () => {
    if (rec.state === "recording") {
      const blob = await rec.stop();
      await runGrading(blob);
    } else {
      setPhase("recording");
      await rec.start();
    }
  }, [rec, runGrading]);

  const submitTyped = useCallback(() => {
    if (typed.trim()) runGrading(null, typed);
  }, [typed, runGrading]);

  // Next concept in the bank (demo navigation); falls back to dashboard.
  const nextId = useMemo(() => {
    const i = MOCK_CONCEPTS.findIndex((c) => c.id === id);
    return i >= 0 && i < MOCK_CONCEPTS.length - 1 ? MOCK_CONCEPTS[i + 1].id : null;
  }, [id]);

  /* ─── Render ─────────────────────────────────────────────────────────── */

  if (phase === "loading") {
    return (
      <Shell progress={0}>
        <div className="flex-1 grid place-items-center">
          <Duck className="w-14 h-14 animate-breathe" />
        </div>
      </Shell>
    );
  }

  if (phase === "notfound" || !concept) {
    return (
      <Shell progress={0}>
        <div className="flex-1 grid place-items-center text-center px-6">
          <div>
            <Duck className="w-14 h-14 mx-auto mb-4" />
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

  const progress = phase === "intro" ? 0.33 : phase === "result" ? 1 : 0.66;

  return (
    <Shell progress={progress}>
      <div className="flex-1 flex flex-col gap-7 pt-7 pb-4">
        {/* Concept + provenance, persistent across phases */}
        <Eyebrow concept={concept} />

        {/* Roast — shown before answering and while recording */}
        {(phase === "intro" || phase === "recording") && (
          <ExaminerBubble roast={concept.roast_text} />
        )}

        {/* Question hero — present until the result reveal */}
        {phase !== "result" && phase !== "failed" && (
          <h1
            className="font-display text-[1.7rem] sm:text-3xl font-bold leading-[1.18] tracking-tightest text-balance animate-rise"
            style={{ animationDelay: "120ms" }}
          >
            {concept.question_text}
          </h1>
        )}

        {/* Recording instrument */}
        {phase === "recording" && (
          <RecordingPanel rec={rec} onType={() => setPhase("typing")} />
        )}

        {/* Typed answer */}
        {phase === "typing" && (
          <TypingPanel
            value={typed}
            onChange={setTyped}
            onSubmit={submitTyped}
            onVoice={() => {
              setTyped("");
              setPhase("intro");
            }}
          />
        )}

        {/* Thinking */}
        {phase === "thinking" && <ThinkingPanel stage={stage} transcript={transcript} />}

        {/* Result */}
        {phase === "result" && grade && (
          <ResultPanel concept={concept} grade={grade} transcript={transcript} />
        )}

        {/* Recoverable failure */}
        {phase === "failed" && (
          <div className="flex-1 grid place-items-center text-center animate-fade">
            <div>
              <Duck className="w-12 h-12 mx-auto mb-4" />
              <p className="text-ink-dim mb-6 max-w-sm">{errorMsg}</p>
              <button
                onClick={() => {
                  rec.reset();
                  setPhase("intro");
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-medium hover:bg-line transition"
              >
                <RetryIcon className="w-4 h-4" /> Try again
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom action bar — phase-specific */}
      <ActionBar
        phase={phase}
        recState={rec.state}
        onOrbClick={handleOrbClick}
        onType={() => setPhase("typing")}
        onNext={() => (nextId ? router.push(`/quiz/${nextId}`) : router.push("/dashboard"))}
        onRetry={() => {
          rec.reset();
          setTranscript("");
          setGrade(null);
          setErrorMsg(null);
          setTyped("");
          setPhase("intro");
        }}
        passed={grade?.passed ?? false}
        hasNext={nextId != null}
      />
    </Shell>
  );
}

/* ─── Layout shell: header (exit + progress) + content column ───────────── */

function Shell({ children, progress }: { children: React.ReactNode; progress: number }) {
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
      <main className="mx-auto max-w-xl w-full px-5 flex-1 flex flex-col">{children}</main>
      {USING_MOCK && (
        <div className="pointer-events-none fixed bottom-2 right-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          mock data
        </div>
      )}
    </div>
  );
}

/* ─── Recording panel ───────────────────────────────────────────────────── */

function RecordingPanel({
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
              ? "VibeSchool needs your mic to hear you. Enable it in your browser, or type your answer instead."
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

function TypingPanel({
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

/* ─── Thinking panel ────────────────────────────────────────────────────── */

function ThinkingPanel({ stage, transcript }: { stage: Stage; transcript: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 animate-fade">
      <Duck className="w-12 h-12" />
      <div className="flex items-center gap-3 text-ink-dim">
        <ThinkingDots />
        <span className="font-mono text-sm">
          {stage === "transcribing" ? "transcribing your answer…" : "the examiner is grading…"}
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

function ResultPanel({
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
  const beforePct = masteryPct(concept.interval);
  const afterPct = masteryPct(daysUntil(grade.next_review));
  const [pct, setPct] = useState(beforePct);

  useEffect(() => {
    const t = setTimeout(() => setPct(afterPct), 400);
    return () => clearTimeout(t);
  }, [afterPct]);

  return (
    <div className="flex-1 flex flex-col gap-6 animate-fade py-2">
      {/* Verdict */}
      <div className="relative flex flex-col items-center text-center pt-4">
        {passed && <SparkBurst />}
        <div
          className={`relative grid place-items-center h-16 w-16 rounded-full mb-4 ${
            passed ? "bg-mint text-canvas" : "bg-coral text-canvas"
          }`}
        >
          {passed ? <CheckIcon /> : <RetryIcon />}
        </div>
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

/* ─── Bottom action bar ─────────────────────────────────────────────────── */

function ActionBar({
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

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function masteryPct(intervalDays: number): number {
  return Math.min(Math.round((intervalDays / 30) * 100), 100);
}

function daysUntil(iso: string): number {
  return Math.max(0, (new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function formatNextReview(iso: string): string {
  const d = daysUntil(iso);
  if (d < 1) {
    const h = Math.round(d * 24);
    return h <= 1 ? "in about an hour" : `in ${h} hours`;
  }
  const days = Math.round(d);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}
