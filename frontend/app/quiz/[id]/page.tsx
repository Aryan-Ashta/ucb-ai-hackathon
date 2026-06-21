"use client";

import {
  gradeAnswer,
  getConcept,
  listDueConcepts,
  scheduleReview,
  transcribeAudio,
  USING_MOCK,
} from "@/lib/api";
import type { Concept, GradeResult } from "@/lib/types";
import { isAbortError } from "@/lib/api-error";
import { useRecorder } from "@/lib/useRecorder";
import { useTts } from "@/lib/useTts";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  SpeakingPanel,
  ThinkingPanel,
  TypingPanel,
  type Stage,
  LoadingPanel,
  NotFoundPanel,
} from "./panels";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export default function QuizPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const rec = useRecorder();
  const tts = useTts();

  const [concept, setConcept] = useState<Concept | null>(null);
  const [dueList, setDueList] = useState<Concept[]>([]);
  const [phase, setPhase] = useState<Phase>("loading");
  const [stage, setStage] = useState<Stage>("transcribing");
  const [transcript, setTranscript] = useState("");
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const ctrlRef = useRef<AbortController | null>(null);
  const fetchGenRef = useRef(0);
  const lastProgressRef = useRef(0);

  useEffect(() => {
    // Don't fire the authenticated fetch until NextAuth has resolved the
    // session. Quiz links are plain <a href> elements (full-page nav), so
    // useSession() starts in "loading" on every page load. Firing the API
    // call before the token is ready returns 401, which the catch below
    // converts to "notfound" — making every quiz link appear broken.
    // Mock mode doesn't use the token, so we skip the guard there.
    if (!USING_MOCK && sessionStatus === "loading") return;

    ctrlRef.current?.abort();
    tts.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const gen = ++fetchGenRef.current;

    setPhase("loading");
    setGrade(null);
    setTranscript("");
    setErrorMsg(null);
    setTyped("");
    rec.reset();

    const token = session?.accessToken ?? undefined;
    Promise.all([
      getConcept(id, token, ctrl.signal),
      token ? listDueConcepts(token, ctrl.signal) : Promise.resolve([]),
    ])
      .then(([c, due]) => {
        if (gen !== fetchGenRef.current) return;
        setConcept(c);
        setDueList(due);
        if (!c) {
          setPhase("notfound");
          return;
        }
        setPhase("speaking");
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) {
          if (gen !== fetchGenRef.current) return;
          return;
        }
        if (gen !== fetchGenRef.current) return;
        setConcept(null);
        setPhase("notfound");
      });
    return () => ctrl.abort();
    // rec.reset and tts.abort are stable; re-fire when session settles or token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sessionStatus, session?.accessToken]);

  useEffect(() => {
    if (phase !== "speaking" || !concept || !session?.accessToken) return;
    let cancelled = false;

    void tts
      .speakSequence([concept.roast_text, concept.question_text], session.accessToken)
      .then(() => {
        if (!cancelled) setPhase("intro");
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || cancelled) return;
        setPhase("intro");
      });

    return () => {
      cancelled = true;
      tts.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, concept?.id, session?.accessToken]);

  const runGrading = useCallback(
    async (audio: Blob | null, directText?: string) => {
      if (!concept) return;
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
          if (!audio) {
            setErrorMsg("Couldn't hear that one. Give it another go.");
            setPhase("failed");
            return;
          }
          if (audio.size > MAX_AUDIO_BYTES) {
            setErrorMsg("Recording is too large (max 10 MB). Try a shorter answer.");
            setPhase("failed");
            return;
          }
          setStage("transcribing");
          const r = await transcribeAudio(audio, session?.accessToken ?? undefined, signal);
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

  const nextId = useMemo(() => {
    const sorted = [...dueList].sort(
      (a, b) => new Date(a.next_review).getTime() - new Date(b.next_review).getTime(),
    );
    const i = sorted.findIndex((c) => c.id === id);
    if (i < 0) return null;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j]!.id !== id) return sorted[j]!.id;
    }
    return null;
  }, [dueList, id]);

  const resetToIntro = useCallback(() => {
    rec.reset();
    setTranscript("");
    setGrade(null);
    setErrorMsg(null);
    setTyped("");
    setPhase("intro");
  }, [rec]);

  const targetProgress =
    phase === "intro" || phase === "speaking" ? 0.33 : phase === "result" ? 1 : 0.66;

  const displayedProgress = Math.max(targetProgress, lastProgressRef.current);
  useEffect(() => {
    if (targetProgress > lastProgressRef.current) lastProgressRef.current = targetProgress;
  }, [targetProgress]);

  if (phase === "loading") return <LoadingPanel progress={displayedProgress} />;
  if (phase === "notfound" || !concept) return <NotFoundPanel progress={displayedProgress} />;

  return (
    <Shell progress={displayedProgress}>
      <div className="flex-1 flex flex-col gap-7 pt-7 pb-4">
        <ConceptEyebrow concept={concept} />

        {phase === "speaking" && <SpeakingPanel />}

        {(phase === "intro" || phase === "recording") && (
          <RoastBubble roast={concept.roast_text} />
        )}

        {phase !== "result" && phase !== "failed" && phase !== "speaking" && (
          <QuestionHero concept={concept} />
        )}

        {phase === "recording" && (
          <RecordingPanel rec={rec} onType={() => setPhase("typing")} />
        )}

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

        {phase === "thinking" && (
          <ThinkingPanel stage={stage} transcript={transcript} seconds={rec.seconds} />
        )}

        {phase === "result" && grade && (
          <ResultPanel concept={concept} grade={grade} transcript={transcript} />
        )}

        {phase === "failed" && <FailedPanel errorMsg={errorMsg} onRetry={resetToIntro} />}
      </div>

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
