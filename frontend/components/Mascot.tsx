"use client";

import styles from "./Mascot.module.css";

export type Mood = "idle" | "happy" | "angry" | "thinking";

export interface MascotProps {
  mood?: Mood;
  /** Square render size in px. */
  size?: number;
  /** Optional roast / praise bubble rendered to the right. */
  speech?: string;
  speaker?: string;
  /** Path to the artwork. Defaults to /mascot.svg (put the file in /public). */
  src?: string;
  className?: string;
}

/**
 * The VibeSchool banana-duck. Uses the real illustration (public/mascot.svg) as
 * the base image and rigs animated expression overlays on top, in the artwork's
 * native 1254×1254 coordinate space. Expression is driven by `mood`:
 *   idle     — gentle breathing + occasional blink
 *   happy    — hop, arc eyes, cheeks, sparkles
 *   angry    — brows furrow in, eyes squint, slow steam
 *   thinking — slow sway, sweat drop, thought dots
 *
 * Animations live in Mascot.module.css and respect prefers-reduced-motion.
 */
export function Mascot({ mood = "idle", size = 180, speech, speaker = "The Examiner", src = "/mascot.svg", className }: MascotProps) {
  return (
    <div className={`${styles.stage} ${className ?? ""}`} data-mood={mood}>
      <div className={styles.figure} style={{ width: size, height: size }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.art} src={src} alt="banana-duck mascot" width={size} height={size} />
        <svg className={styles.ov} viewBox="0 0 1254 1254" fill="none" xmlns="http://www.w3.org/2000/svg">
          {/* steam (angry) */}
          <g className={styles.steam}>
            <ellipse className={styles.pf} cx="520" cy="95" rx="34" ry="40" fill="#c4b89f" />
            <ellipse className={styles.pf} cx="712" cy="70" rx="28" ry="34" fill="#c4b89f" />
          </g>
          {/* sparkles (happy) */}
          <g className={styles.sparkles}>
            <rect className={styles.sp} x="288" y="276" width="58" height="58" rx="10" transform="rotate(45 317 305)" fill="#ffb627" />
            <rect className={styles.sp} x="936" y="250" width="48" height="48" rx="9" transform="rotate(45 960 274)" fill="#ffd37a" />
            <rect className={styles.sp} x="956" y="812" width="54" height="54" rx="10" transform="rotate(45 983 839)" fill="#ffb627" />
          </g>
          {/* thought dots (thinking) */}
          <g className={styles.think}>
            <circle className={styles.td} cx="958" cy="296" r="20" fill="#ffb627" />
            <circle className={styles.td} cx="1018" cy="236" r="23" fill="#ffb627" />
            <circle className={styles.td} cx="1082" cy="176" r="26" fill="#ffb627" />
          </g>

          {/* blink eyelids (idle) */}
          <ellipse className={`${styles.lid} ${styles.blink}`} cx="542" cy="209" rx="26" ry="34" fill="#fdf2de" />
          <ellipse className={`${styles.lid} ${styles.blink}`} cx="688" cy="207" rx="26" ry="34" fill="#fdf2de" />

          {/* narrowed top lids (angry) */}
          <g className={styles.narrow}>
            <path d="M512 188 Q542 168 574 190 L574 200 Q542 184 512 200 Z" fill="#fdf2de" />
            <path d="M658 186 Q688 166 720 188 L720 198 Q688 182 658 198 Z" fill="#fdf2de" />
          </g>
          {/* angry brows */}
          <g className={styles.brow}>
            <line x1="496" y1="150" x2="586" y2="184" stroke="#5b3d0e" strokeWidth="17" strokeLinecap="round" />
          </g>
          <g className={styles.brow}>
            <line x1="736" y1="148" x2="646" y2="182" stroke="#5b3d0e" strokeWidth="17" strokeLinecap="round" />
          </g>

          {/* happy: cream cover + arc eyes */}
          <g className={styles.eyecover}>
            <ellipse cx="542" cy="209" rx="30" ry="38" fill="#fdf2de" />
            <ellipse cx="688" cy="207" rx="30" ry="38" fill="#fdf2de" />
          </g>
          <g className={styles.happyeye}>
            <path d="M506 222 Q542 178 578 222" stroke="#221508" strokeWidth="15" strokeLinecap="round" fill="none" />
            <path d="M652 220 Q688 176 724 220" stroke="#221508" strokeWidth="15" strokeLinecap="round" fill="none" />
          </g>
          {/* cheeks (happy) */}
          <g className={styles.cheek}>
            <ellipse cx="486" cy="286" rx="30" ry="16" fill="#ff8a7a" />
            <ellipse cx="744" cy="284" rx="30" ry="16" fill="#ff8a7a" />
          </g>

          {/* sweat (thinking) */}
          <g className={styles.sweat}>
            <path d="M812 250 C792 290 804 326 824 326 C844 326 856 290 836 250 C828 238 820 238 812 250 Z" fill="#8fb7d8" stroke="#6f97b8" strokeWidth="4" />
          </g>
        </svg>
      </div>

      {speech ? (
        <div className="relative max-w-[300px] rounded-[14px] border border-line border-l-[3px] border-l-coral bg-surface-1 px-4 py-[13px] font-mono">
          <div className="absolute -left-[9px] top-[26px] h-[14px] w-[14px] rotate-45 border-b border-l border-line bg-surface-1" />
          <div className="mb-[5px] text-[10px] uppercase tracking-[0.14em] text-ink-faint">{speaker}</div>
          <div className="text-[13px] leading-relaxed text-ink-dim">{speech}</div>
        </div>
      ) : null}
    </div>
  );
}
