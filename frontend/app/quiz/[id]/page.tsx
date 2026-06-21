"use client";

import { gradeAnswer, getConcept, transcribeAudio } from "@/lib/api";
import type { Concept, GradeResult } from "@/lib/types";
import { isAbortError } from "@/lib/api-error";
import { useRecorder } from "@/lib/useRecorder";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
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
        if (isAbortError(err)) return;
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
        if (isAbortError(err)) return;
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

  if (phase === "loading") return <LoadingPanel />;
  if (phase === "notfound" || !concept) return <NotFoundPanel />;

  const progress = phase === "intro" ? 0.33 : phase === "result" ? 1 : 0.66;

  return (
    <Shell progress={progress}>
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
        onNext={() => (nextId ? router.push(`/quiz/${nextId}`) : router.push("/dashboard"))}
        onRetry={resetToIntro}
        passed={grade?.passed ?? false}
        hasNext={nextId != null}
      />
    </Shell>
  );
}
