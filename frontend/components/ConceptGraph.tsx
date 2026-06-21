"use client";

import { STATE_STYLE } from "@/lib/concepts";
import type { GraphNode } from "@/lib/build-graph";
import styles from "./ConceptGraph.module.css";

const VIEW_W = 820;
const VIEW_H = 520;

/** Estimated rect width from label length (matches the design). */
function widthOf(label: string) {
  return Math.max(112, label.length * 7.7 + 52);
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
    const w = widthOf(c.label);
    const rx0 = c.x - w / 2;
    const dotX = rx0 + 19;
    return {
      ...c,
      style: s,
      w,
      rx0,
      ry0: c.y - 18,
      dotX,
      textX: dotX + 13,
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
    const sxR = na.x + na.w / 2;
    const txL = nb.x - nb.w / 2;
    const connected = a === selectedId || b === selectedId;
    return {
      key: `${a}-${b}`,
      d: `M${sxR} ${na.y} C ${sxR + 46} ${na.y}, ${txL - 46} ${nb.y}, ${txL} ${nb.y}`,
      stroke: connected ? "#ffb627" : "#3a3128",
      width: connected ? 2.5 : 1.5,
      opacity: connected ? 0.95 : 0.45,
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
          <text x={n.textX} y={n.y + 4.7} fontFamily="var(--font-geist-mono), ui-monospace, monospace" fontSize={14} fontWeight={500} fill={n.style.label}>
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
