// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The GRAPH column: an SVG layer drawing lane connectors (curved beziers)
// behind DOM avatar nodes positioned at each commit. Web-only (rendered
// inside the IDE Workbench), so it uses native <svg> rather than
// react-native-svg.

import { avatarColor, initials, isAiAuthor } from "./gitAvatar";
import {
  GRAPH_PAD_LEFT,
  LANE_WIDTH,
  NODE_RADIUS,
  ROW_HEIGHT,
  graphWidth,
  laneCenterX,
  type DisplayRow,
} from "./types";

export function CommitGraphCanvas({
  rows,
  maxLanes,
  selectedSha,
  onSelect,
}: {
  rows: DisplayRow[];
  maxLanes: number;
  selectedSha: string | null;
  onSelect: (sha: string | null) => void;
}) {
  const width = graphWidth(maxLanes);
  const height = rows.length * ROW_HEIGHT;

  return (
    <div className="relative shrink-0" style={{ width, height }}>
      <svg
        width={width}
        height={height}
        className="absolute inset-0 pointer-events-none"
        style={{ overflow: "visible" }}
      >
        {rows.map((row, i) => {
          const topY = i * ROW_HEIGHT + ROW_HEIGHT / 2;
          const bottomY = (i + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;
          return row.edges.map((e, j) => {
            const x1 = laneCenterX(e.fromLane);
            const x2 = laneCenterX(e.toLane);
            if (x1 === x2) {
              return (
                <line
                  key={`${i}-${j}`}
                  x1={x1}
                  y1={topY}
                  x2={x2}
                  y2={bottomY}
                  stroke={e.color}
                  strokeWidth={2}
                />
              );
            }
            const midY = (topY + bottomY) / 2;
            const d = `M ${x1} ${topY} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${bottomY}`;
            return (
              <path
                key={`${i}-${j}`}
                d={d}
                fill="none"
                stroke={e.color}
                strokeWidth={2}
              />
            );
          });
        })}
      </svg>

      {rows.map((row, i) => {
        const cx = laneCenterX(row.lane);
        const cy = i * ROW_HEIGHT + ROW_HEIGHT / 2;
        const selected = !!row.sha && row.sha === selectedSha;
        return (
          <GraphNode
            key={row.sha ?? `wip-${i}`}
            row={row}
            cx={cx}
            cy={cy}
            selected={selected}
            onClick={() => onSelect(row.sha)}
          />
        );
      })}
    </div>
  );
}

function GraphNode({
  row,
  cx,
  cy,
  selected,
  onClick,
}: {
  row: DisplayRow;
  cx: number;
  cy: number;
  selected: boolean;
  onClick: () => void;
}) {
  const size = NODE_RADIUS * 2 + 6;
  const common = {
    onClick,
    style: {
      position: "absolute" as const,
      left: cx - size / 2,
      top: cy - size / 2,
      width: size,
      height: size,
    },
  };

  if (row.kind === "wip") {
    return (
      <div
        {...common}
        title="Uncommitted changes"
        className="flex items-center justify-center rounded-full cursor-pointer"
      >
        <span
          className="block rounded-full"
          style={{
            width: NODE_RADIUS * 2,
            height: NODE_RADIUS * 2,
            border: `2px dashed ${row.color}`,
            boxShadow: selected ? `0 0 0 2px var(--ide-active-ring)` : undefined,
          }}
        />
      </div>
    );
  }

  const commit = row.commit!;
  const ai = isAiAuthor(commit.author, commit.authorEmail);
  const bg = ai ? "#e0457b" : avatarColor(commit.authorEmail || commit.author);
  const isCp = row.isCheckpoint;
  const isLive = row.isLive;

  // Concentric rings, innermost first (box-shadows listed earlier paint on
  // top): selection -> checkpoint (amber) -> live (green). Checkpoints match
  // the amber rollback accent; the live ring marks the currently-published
  // commit so it's obvious at a glance which commit is deployed.
  const rings: string[] = [
    selected ? `0 0 0 2px var(--ide-active-ring)` : `0 0 0 1px rgba(0,0,0,0.4)`,
  ];
  if (isCp) rings.push(`0 0 0 ${selected ? 4 : 2.5}px #f59e0b`);
  if (isLive) {
    rings.push(`0 0 0 ${isCp ? (selected ? 6 : 4.5) : selected ? 4 : 2.5}px #10b981`);
  }
  const boxShadow = rings.join(", ");

  return (
    <div
      {...common}
      title={`${commit.author} · ${commit.shortSha}${isCp ? " · checkpoint" : ""}${isLive ? " · live" : ""}`}
      className="flex items-center justify-center rounded-full cursor-pointer select-none"
      style={{
        ...common.style,
        background: bg,
        border: `2px solid var(--ide-bg)`,
        boxShadow,
      }}
    >
      <span className="text-[8px] font-bold leading-none text-white">
        {ai ? "S" : initials(commit.author)}
      </span>
    </div>
  );
}
