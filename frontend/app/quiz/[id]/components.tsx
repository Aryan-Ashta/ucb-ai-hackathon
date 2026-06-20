"use client";

import type { Concept } from "@/lib/types";

/* ─── Icons (inline for crispness; mono-weight strokes) ─────────────────── */

export function MicIcon({ className = "w-7 h-7" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CheckIcon({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 12.5l5 5L20 6.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RetryIcon({ className = "w-8 h-8" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 11a8 8 0 1 0-2.3 5.6M20 5v5h-5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ArrowIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CalendarIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/* ─── Top progress rail ─────────────────────────────────────────────────── */

export function ProgressRail({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
      <div
        className="h-full rounded-full bg-marigold transition-[width] duration-500 ease-out"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

/* ─── Concept eyebrow + provenance chip ─────────────────────────────────── */

export function Eyebrow({ concept }: { concept: Concept }) {
  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      <span className="font-mono text-xs uppercase tracking-[0.18em] text-marigold">
        {concept.concept}
      </span>
      {concept.pr_number != null && (
        <span className="font-mono text-[11px] text-ink-dim border border-line rounded-full px-2 py-0.5">
          {concept.repo ? `${concept.repo}#${concept.pr_number}` : `PR #${concept.pr_number}`}
        </span>
      )}
    </div>
  );
}

/* ─── Examiner roast, styled like a PR review comment ───────────────────── */

export function ExaminerBubble({ roast }: { roast: string }) {
  return (
    <div className="flex gap-3 animate-rise" style={{ animationDelay: "60ms" }}>
      <Duck className="w-9 h-9 shrink-0" />
      <div className="min-w-0 rounded-2xl rounded-tl-sm bg-surface-1 border border-line border-l-2 border-l-coral px-4 py-3">
        <div className="font-mono text-[11px] uppercase tracking-wider text-ink-faint mb-1">
          the examiner
        </div>
        <p
          className="font-mono text-sm leading-relaxed text-ink-dim text-pretty"
          dangerouslySetInnerHTML={{ __html: codeSpans(roast) }}
        />
      </div>
    </div>
  );
}

/* Render `inline code` spans inside roast/explanation text. */
function codeSpans(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc.replace(
    /`([^`]+)`/g,
    '<code class="text-marigold bg-surface-2 rounded px-1 py-0.5">$1</code>',
  );
}

export { codeSpans };

/* ─── The duck examiner — a small, deadpan mark (not a cartoon) ─────────── */

export function Duck({ className = "w-9 h-9" }: { className?: string }) {
  return (
    <div
      className={`${className} grid place-items-center rounded-full bg-marigold text-canvas text-lg`}
      aria-hidden
    >
      🦆
    </div>
  );
}

/* ─── Score pips (SM-2 quality 0–5) ─────────────────────────────────────── */

export function ScorePips({ quality, tone }: { quality: number; tone: "mint" | "coral" }) {
  const color = tone === "mint" ? "bg-mint" : "bg-coral";
  return (
    <div className="flex items-center gap-1.5" aria-label={`Score ${quality} of 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={`h-2.5 w-2.5 rounded-full ${i < quality ? color : "bg-surface-2"}`}
          style={
            i < quality
              ? { animation: "vs-pip 0.3s cubic-bezier(0.34,1.56,0.64,1) both", animationDelay: `${i * 70 + 120}ms` }
              : undefined
          }
        />
      ))}
    </div>
  );
}
