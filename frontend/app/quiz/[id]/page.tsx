"use client";

import { gradeAnswer, getConcept, scheduleReview, transcribeAudio } from "@/lib/api";
import type { Concept, GradeResult } from "@/lib/types";
import { isAbortError } from "@/lib/api-error";
import { useRecorder } from "@/lib/useRecorder";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MOCK_CONCEPTS } from "@/lib/mock";
import {
  ActionBar,
  ConceptEyebrow,
  FailedPanel,
  type Phase,
  QuestionHero,
  RecordingPanel,
  ResultPanel,
  RoastBubble,
  Shell,
  ThinkingPanel,
  TypingPanel,
  type Stage,
  LoadingPanel,
  NotFoundPanel,
} from "./panels";

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

  // H2 (Trace 2): one AbortController shared by the concept fetch AND the
  // grading pipeline. The mount-effect cleanup aborts it so navigating away
  // mid-grade cancels the in-flight Deepgram + Claude requests instead of
  // burning API quota and setState'ing on an unmounted component.
  const ctrlRef = useRef<AbortController | null>(null);

  // Progress is monotonically non-decreasing within a quiz session so the
  // rail can't visibly shrink when navigating to the next concept (1→0 during
  // load) or when retrying a failed answer (1→0.33 on reset).
  const lastProgressRef = useRef(0);

  // Load (or reload, on "Next concept") the concept for this id.
  useEffect(() => {
    // Abort any in-flight grading from the previous concept before starting
    // a fresh fetch — keeps the controller lifecycle tied to the id.
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
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
        if (isAbortError(err)) return;
        setConcept(null);
        setPhase("notfound");
      });
    return () => ctrl.abort();
    // rec.reset is stable; intentionally keyed on id only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const runGrading = useCallback(
    // `directText` is a typed answer — it skips transcription and goes straight
    // to grading. Audio answers are transcribed first.
    async (audio: Blob | null, directText?: string) => {
      if (!concept) return;
      // H2: reuse the page-level controller so unmount can abort us mid-grade.
      // If the prior controller was already aborted (e.g. navigated during a
      // previous grade), swap in a fresh one.
      let ctrl = ctrlRef.current;
      if (!ctrl || ctrl.signal.aborted) {
        ctrl = new AbortController();
        ctrlRef.current = ctrl;
      }
      const signal = ctrl.signal;
      setPhase("thinking");
      setErrorMsg(null);
      try {
        let text = directText?.trim() ?? "";
        if (!directText) {
          setStage("transcribing");
          const r = await transcribeAudio(audio!, session?.accessToken ?? undefined, signal);
          if (r.error || !r.transcript.trim()) {
            setErrorMsg(r.error ?? "Couldn't hear that one. Give it another go.");
            setPhase("failed");
            return;
          }
          text = r.transcript;
        }
        setTranscript(text);
        setStage("grading");
        const g = await gradeAnswer({ concept_id: concept.id, transcript: text }, concept, session?.accessToken ?? undefined, signal);
        setGrade(g);
        setPhase("result");
        // H1 (Trace 2): fire-and-forget the calendar-event hook after the grade
        // lands. The backend returns {status: "failed", ...} with HTTP 200 on
        // soft failures so this never throws into the UX. next_review is an
        // ISO string from Claude; convert to epoch for the backend.
        const nextTs = Date.parse(g.next_review);
        if (!Number.isNaN(nextTs)) {
          void scheduleReview(
            session?.accessToken ?? "",
            { concept_id: concept.id, next_review_timestamp: Math.floor(nextTs / 1000) },
          );
        }
      } catch (err: unknown) {
        if (isAbortError(err)) return;
        setErrorMsg("Something broke while scoring that. Try again in a moment.");
        setPhase("failed");
      }
    },
    [concept, session?.accessToken],
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

  // Single canonical "go back to intro" handler for the failed panel + retry
  // button. Inline in two places previously; lifted to keep the page file small.
  const resetToIntro = useCallback(() => {
    rec.reset();
    setTranscript("");
    setGrade(null);
    setErrorMsg(null);
    setTyped("");
    setPhase("intro");
  }, [rec]);

  /* ─── Render ─────────────────────────────────────────────────────────── */

  // Target progress for the current phase. `loading` collapses to 0.66 so
  // the early-return branches below can use the same monotonic value.
  const targetProgress = phase === "intro" ? 0.33 : phase === "result" ? 1 : 0.66;

  // The bar is monotonically non-decreasing within a session: it never
  // shrinks when navigating to the next concept (1 → 0 during load) or
  // when retrying a failed answer (1 → 0.33 on reset). The first render
  // uses the ref's current value; subsequent renders advance only.
  const displayedProgress = Math.max(targetProgress, lastProgressRef.current);
  useEffect(() => {
    if (targetProgress > lastProgressRef.current) lastProgressRef.current = targetProgress;
  }, [targetProgress]);

  if (phase === "loading") return <LoadingPanel progress={displayedProgress} />;
  if (phase === "notfound" || !concept) return <NotFoundPanel progress={displayedProgress} />;

  return (
    <Shell progress={displayedProgress}>
      <div className="flex-1 flex flex-col gap-7 pt-7 pb-4">
        {/* Concept + provenance, persistent across phases */}
        <ConceptEyebrow concept={concept} />

        {/* Roast — shown before answering and while recording */}
        {(phase === "intro" || phase === "recording") && (
          <RoastBubble roast={concept.roast_text} />
        )}

        {/* Question hero — present until the result reveal */}
        {phase !== "result" && phase !== "failed" && (
          <QuestionHero concept={concept} />
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
        {phase === "failed" && <FailedPanel errorMsg={errorMsg} onRetry={resetToIntro} />}
      </div>

      {/* Bottom action bar — phase-specific */}
      <ActionBar
        phase={phase}
        recState={rec.state}
        onOrbClick={handleOrbClick}
        onType={() => setPhase("typing")}
        onNext={() => (nextId ? router.push(`/quiz/${encodeURIComponent(nextId)}`) : router.push("/dashboard"))}
        onRetry={resetToIntro}
        passed={grade?.passed ?? false}
        hasNext={nextId != null}
      />
    </Shell>
  );
}
