"use client";

import { MicIcon } from "./components";

/* ─── Live waveform — vertical bars driven by real mic amplitude ────────── */

export function WaveBars({ levels, active }: { levels: number[]; active: boolean }) {
  return (
    <div className="flex items-center justify-center gap-[3px] h-20" aria-hidden>
      {levels.map((lvl, i) => {
        // Idle: a calm flat line. Active: react to amplitude with a floor so
        // quiet moments still read as "listening".
        const h = active ? Math.max(6, lvl * 76) : 4;
        return (
          <span
            key={i}
            className={`w-[5px] rounded-full transition-[height] duration-100 ${
              active ? "bg-marigold" : "bg-surface-2"
            }`}
            style={{ height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

/* ─── The recording orb — signature element ─────────────────────────────── */

export function RecorderOrb({
  recording,
  onClick,
  disabled,
}: {
  recording: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={recording ? "Stop and submit answer" : "Start recording your answer"}
      className="relative grid place-items-center outline-none focus-visible:ring-2 focus-visible:ring-marigold focus-visible:ring-offset-4 focus-visible:ring-offset-canvas rounded-full disabled:opacity-50"
    >
      {/* Concentric pulse rings while recording */}
      {recording && (
        <>
          <span className="absolute h-24 w-24 rounded-full bg-marigold animate-ping" />
          <span
            className="absolute h-24 w-24 rounded-full bg-marigold animate-ping"
            style={{ animationDelay: "0.5s" }}
          />
        </>
      )}
      <span
        className={`relative grid place-items-center h-24 w-24 rounded-full transition-colors ${
          recording
            ? "bg-coral text-canvas"
            : "bg-marigold text-canvas animate-breathe shadow-[0_0_50px_-6px_var(--marigold)]"
        }`}
      >
        {recording ? <StopGlyph /> : <MicIcon className="w-9 h-9" />}
      </span>
    </button>
  );
}

function StopGlyph() {
  return <span className="h-6 w-6 rounded-md bg-canvas" aria-hidden />;
}

/* ─── Examiner "thinking" dots ──────────────────────────────────────────── */

export function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 rounded-full bg-ink-dim animate-dot"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

/* ─── Celebratory spark burst on a passing result ───────────────────────── */

export function SparkBurst() {
  const sparks = Array.from({ length: 10 }).map((_, i) => {
    const angle = (i / 10) * Math.PI * 2;
    const dist = 60 + (i % 3) * 16;
    return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist, i };
  });
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
      {sparks.map(({ dx, dy, i }) => (
        <span
          key={i}
          className="absolute h-2 w-2 rounded-full"
          style={
            {
              backgroundColor: i % 2 ? "var(--marigold)" : "var(--mint)",
              "--dx": `${dx}px`,
              "--dy": `${dy}px`,
              animation: "vs-spark 0.7s ease-out forwards",
              animationDelay: `${i * 18}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
