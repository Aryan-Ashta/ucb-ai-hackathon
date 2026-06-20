"use client";

import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, type Concept, type GradeResult } from "@/lib/api";

// Audio goes directly to the backend — Vercel serverless functions cap request
// bodies at 4.5 MB, which audio/webm blobs exceed quickly.
const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

type Stage = "loading" | "idle" | "recording" | "grading" | "done" | "error";

export default function QuizPage() {
  const params = useParams();
  const conceptId = params.id as string;
  const { data: session, status } = useSession();
  const router = useRouter();

  const [concept, setConcept] = useState<Concept | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState<GradeResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated" || !session?.accessToken) return;
    api
      .listDueConcepts(session.accessToken)
      .then((data) => {
        const found = data.due.find((c) => c.id === conceptId);
        if (!found) {
          setErrorMsg("Concept not found — it may have already been reviewed or synced.");
          setStage("error");
        } else {
          setConcept(found);
          setStage("idle");
        }
      })
      .catch((err) => {
        setErrorMsg(err instanceof Error ? err.message : "Failed to load concept");
        setStage("error");
      });
  }, [status, session?.accessToken, conceptId]);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        await handleGrade(blob);
      };
      recorder.start();
      recorderRef.current = recorder;
      setStage("recording");
    } catch {
      setErrorMsg("Microphone access denied. Please allow mic access and try again.");
      setStage("error");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setStage("grading");
  }

  async function handleGrade(blob: Blob) {
    try {
      const fd = new FormData();
      fd.append("audio", blob, "answer.webm");
      const tRes = await fetch(`${BACKEND}/api/transcribe`, { method: "POST", body: fd });
      if (!tRes.ok) throw new Error(`Transcribe failed: ${tRes.status} ${tRes.statusText}`);
      const { transcript: t, error: tErr } = await tRes.json();
      if (tErr) throw new Error(tErr);
      setTranscript(t);

      const gradeData = await api.gradeAnswer(session!.accessToken!, conceptId, t);
      setResult(gradeData);
      setStage("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Grading failed");
      setStage("error");
    }
  }

  // --- Shared shell ---
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-100 px-6 py-3 flex items-center gap-3">
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-gray-400 hover:text-gray-700 transition"
        >
          ← Dashboard
        </button>
        <span className="text-gray-200">|</span>
        <span className="text-2xl">🦆</span>
        <span className="font-bold text-gray-900">VibeSchool</span>
      </header>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-lg">
          {stage === "loading" && <LoadingState />}
          {stage === "error" && <ErrorState message={errorMsg} onBack={() => router.push("/dashboard")} />}
          {stage === "idle" && concept && (
            <IdleState concept={concept} onStart={startRecording} />
          )}
          {stage === "recording" && (
            <RecordingState onStop={stopRecording} />
          )}
          {stage === "grading" && <GradingState transcript={transcript} />}
          {stage === "done" && result && concept && (
            <DoneState
              concept={concept}
              result={result}
              transcript={transcript}
              onRetry={() => setStage("idle")}
              onDashboard={() => router.push("/dashboard")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// --- Stage components ---

function LoadingState() {
  return (
    <div className="flex flex-col items-center gap-4 text-gray-400 py-20">
      <span className="text-5xl animate-bounce">🦆</span>
      <p className="text-sm">Loading your question…</p>
    </div>
  );
}

function ErrorState({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="bg-white rounded-2xl border border-red-200 p-8 flex flex-col gap-4">
      <div className="text-4xl">😬</div>
      <h2 className="font-bold text-gray-900 text-xl">Something went wrong</h2>
      <p className="text-sm text-red-600 font-mono">{message}</p>
      <button
        onClick={onBack}
        className="mt-2 px-4 py-2 rounded-lg bg-gray-900 text-white text-sm hover:bg-gray-700 transition self-start"
      >
        Back to dashboard
      </button>
    </div>
  );
}

function IdleState({ concept, onStart }: { concept: Concept; onStart: () => void }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 flex flex-col gap-6">
      <div>
        <span className="text-xs font-semibold uppercase tracking-wide text-yellow-600 bg-yellow-50 px-2 py-1 rounded-full">
          {concept.concept}
        </span>
      </div>

      <blockquote className="text-sm text-gray-500 italic border-l-2 border-yellow-300 pl-4">
        &ldquo;{concept.roast_text}&rdquo;
      </blockquote>

      <div>
        <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Question</p>
        <p className="text-gray-900 font-medium leading-snug">{concept.question_text}</p>
      </div>

      <button
        onClick={onStart}
        className="flex items-center justify-center gap-2 w-full py-4 rounded-xl bg-gray-900 hover:bg-gray-700 text-white font-semibold text-lg transition"
      >
        🎤 <span>Tap to answer</span>
      </button>

      <p className="text-xs text-center text-gray-400">
        Speak your answer clearly — your mic will record until you press Stop.
      </p>
    </div>
  );
}

function RecordingState({ onStop }: { onStop: () => void }) {
  return (
    <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-8 flex flex-col items-center gap-6">
      <div className="relative flex items-center justify-center">
        <span className="absolute inline-flex h-20 w-20 rounded-full bg-red-400 opacity-30 animate-ping" />
        <span className="relative text-5xl">🎤</span>
      </div>
      <p className="text-red-600 font-semibold text-lg">Recording…</p>
      <p className="text-sm text-gray-400 text-center">Speak your answer. Press Stop when done.</p>
      <button
        onClick={onStop}
        className="px-8 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-semibold transition"
      >
        ⏹ Stop
      </button>
    </div>
  );
}

function GradingState({ transcript }: { transcript: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 flex flex-col items-center gap-6">
      <span className="text-5xl animate-spin">⚙️</span>
      <p className="font-semibold text-gray-900">Grading your answer…</p>
      {transcript && (
        <div className="w-full bg-gray-50 rounded-xl p-4 text-sm text-gray-600 italic">
          &ldquo;{transcript}&rdquo;
        </div>
      )}
    </div>
  );
}

function DoneState({
  concept,
  result,
  transcript,
  onRetry,
  onDashboard,
}: {
  concept: Concept;
  result: GradeResult;
  transcript: string;
  onRetry: () => void;
  onDashboard: () => void;
}) {
  const nextDate = new Date(result.next_review).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-8 flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <span className="text-4xl">{result.passed ? "✅" : "❌"}</span>
        <div>
          <h2 className="font-bold text-gray-900 text-xl">
            {result.passed ? "Correct!" : "Not quite"}
          </h2>
          <p className="text-sm text-gray-400">
            Quality score: {result.quality}/5
          </p>
        </div>
      </div>

      {/* Quality bar */}
      <div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${result.passed ? "bg-green-400" : "bg-red-400"}`}
            style={{ width: `${(result.quality / 5) * 100}%` }}
          />
        </div>
      </div>

      <div className="bg-gray-50 rounded-xl p-4">
        <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Feedback</p>
        <p className="text-sm text-gray-700">{result.explanation}</p>
      </div>

      {transcript && (
        <div className="bg-gray-50 rounded-xl p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Your answer</p>
          <p className="text-sm text-gray-600 italic">&ldquo;{transcript}&rdquo;</p>
        </div>
      )}

      <div className="text-xs text-gray-400 text-center">
        <span className="font-medium text-gray-600">{concept.concept}</span> — next review: {nextDate}
      </div>

      <div className="flex gap-3">
        <button
          onClick={onRetry}
          className="flex-1 py-3 rounded-xl border border-gray-200 hover:border-gray-400 text-gray-700 text-sm font-medium transition"
        >
          Try again
        </button>
        <button
          onClick={onDashboard}
          className="flex-1 py-3 rounded-xl bg-gray-900 hover:bg-gray-700 text-white text-sm font-semibold transition"
        >
          Back to dashboard
        </button>
      </div>
    </div>
  );
}
