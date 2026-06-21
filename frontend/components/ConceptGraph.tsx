"use client";

import { STATE_STYLE } from "@/lib/concepts";
import type { GraphNode } from "@/lib/build-graph";
import styles from "./ConceptGraph.module.css";

const VIEW_W = 820;
const VIEW_H = 520;
/** Characters before the label is truncated with an ellipsis. */
const MAX_LABEL_CHARS = 21;
/** px per monospace character at 13.5 px font-size (measured). */
const CH_PX = 8.1;
/** Left padding: dot (19) + gap to text (12). Right padding: 16. */
const BOX_PADDING = 19 + 12 + 16;

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? label.slice(0, MAX_LABEL_CHARS - 1) + "…" : label;
}

/** Exact box width for a (possibly truncated) label. */
function widthOf(label: string) {
  const chars = Math.min(label.length, MAX_LABEL_CHARS);
  return Math.max(100, chars * CH_PX + BOX_PADDING);
}

export interface ConceptGraphProps {
  /** Render width in px; height scales with the 820×520 viewBox. */
  width?: number;
  nodes: GraphNode[];
  edges: [string, string][];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ConceptGraph({ width = 800, nodes: inputNodes, edges: inputEdges, selectedId, onSelect }: ConceptGraphProps) {
  const nodes = inputNodes.map((c) => {
    const s = STATE_STYLE[c.state];
    const displayLabel = truncateLabel(c.label);
    const w = widthOf(displayLabel);
    const rx0 = c.x - w / 2;
    const dotX = rx0 + 19;
    return {
      ...c,
      displayLabel,
      style: s,
      w,
      rx0,
      ry0: c.y - 18,
      dotX,
      textX: dotX + 12,
      selected: c.id === selectedId,
      isMastered: c.state === "mastered",
      isDue: c.state === "due",
      isProgress: c.state === "progress",
      checkPts: `${dotX - 5},${c.y + 0.5} ${dotX - 1},${c.y + 4.7} ${dotX + 6},${c.y - 4.5}`,
    };
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const edges = inputEdges.map(([a, b]) => {
    const na = byId[a];
    const nb = byId[b];
    if (!na || !nb) return null;
    const connected = a === selectedId || b === selectedId;

    let d: string;
    const sameCol = Math.abs(na.x - nb.x) < 4;
    if (sameCol) {
      // Vertical connection: bottom-center of source → top-center of target.
      // Offset control points laterally to create a smooth S-curve.
      const sx = na.x;
      const sy = na.ry0 + 36; // bottom of source node
      const tx = nb.x;
      const ty = nb.ry0;      // top of target node
      const gap = ty - sy;
      const side = 44;
      d = `M${sx},${sy} C${sx + side},${sy + gap * 0.42} ${tx - side},${ty - gap * 0.42} ${tx},${ty}`;
    } else {
      // Horizontal connection: right edge of source → left edge of target.
      const sxR = na.x + na.w / 2;
      const txL = nb.x - nb.w / 2;
      const cp = Math.max(56, Math.abs(txL - sxR) * 0.48);
      d = `M${sxR},${na.y} C${sxR + cp},${na.y} ${txL - cp},${nb.y} ${txL},${nb.y}`;
    }

    return {
      key: `${a}-${b}`,
      d,
      stroke: connected ? "#ffb627" : "#3a3128",
      width: connected ? 2.5 : 1.5,
      opacity: connected ? 0.95 : 0.4,
    };
  }).filter(Boolean) as Array<{
    key: string;
    d: string;
    stroke: string;
    width: number;
    opacity: number;
  }>;

  return (
    <svg
      width={width}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block", maxWidth: "100%", height: "auto" }}
    >
      {edges.map((e) => (
        <path key={e.key} d={e.d} stroke={e.stroke} strokeWidth={e.width} strokeLinecap="round" fill="none" opacity={e.opacity} />
      ))}

      {nodes.map((n) => (
        <g key={n.id} className={styles.node} onClick={() => onSelect(n.id)}>
          {n.isDue && (
            <rect className={styles.dueRing} x={n.rx0} y={n.ry0} width={n.w} height={36} rx={11} fill="none" stroke="#ff6f5e" strokeWidth={2} />
          )}
          {n.selected && (
            <rect x={n.rx0 - 4} y={n.y - 22} width={n.w + 8} height={44} rx={14} fill="none" stroke="#ffb627" strokeWidth={1.5} strokeDasharray="3 4" />
          )}
          <rect x={n.rx0} y={n.ry0} width={n.w} height={36} rx={11} fill={n.style.fill} stroke={n.style.stroke} strokeWidth={n.selected ? 2.6 : 1.6} />
          {n.isMastered ? (
            <polyline points={n.checkPts} fill="none" stroke="#5fcf8e" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <circle
              cx={n.dotX}
              cy={n.y}
              r={4.5}
              fill={n.isProgress ? "#1f1a14" : n.style.dot}
              stroke={n.style.dot}
              strokeWidth={n.isProgress ? 2 : 0}
            />
          )}
          <text x={n.textX} y={n.y + 4.5} fontFamily="var(--font-geist-mono), ui-monospace, monospace" fontSize={13.5} fontWeight={500} fill={n.style.label}>
            {n.displayLabel}
          </text>
        </g>
      ))}
    </svg>
  );
}
