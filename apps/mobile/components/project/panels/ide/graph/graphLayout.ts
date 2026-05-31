// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Pure git-graph lane-layout. Turns a topologically/date-ordered list of
// commits (each with parent SHAs) into per-row column ("lane") assignments
// and the edge segments to draw between consecutive rows — the data a
// GitKraken-style DAG canvas renders.
//
// Design choice: lanes do NOT compact. A lane keeps its column index from
// the row it is born (a commit node, or a branch-out) until the row it dies
// (the commit it was waiting for). This makes pass-through lines perfectly
// vertical and keeps edge math simple and correct; it is marginally less
// dense than GitKraken's compaction but visually clean.

export interface GraphCommitInput {
  sha: string;
  parents: string[];
}

export interface GraphEdge {
  /** Column at the top boundary of the row gap (this row's node level). */
  fromLane: number;
  /** Column at the bottom boundary of the row gap (next row's node level). */
  toLane: number;
  color: string;
}

export interface GraphRow {
  sha: string;
  /** Column index of this commit's node. */
  lane: number;
  /** Node color (derived from its lane). */
  color: string;
  /** Edges to draw in the gap BELOW this row (down toward the next row). */
  edges: GraphEdge[];
  /** Number of columns occupied at/around this row (drives canvas width). */
  laneCount: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  maxLanes: number;
}

// GitKraken-ish lane palette. Cycled by column index.
export const LANE_PALETTE = [
  "#1f9cf0", // blue
  "#cf6edf", // purple
  "#42c88a", // green
  "#f0883e", // orange
  "#f14c4c", // red
  "#3ecfcf", // teal
  "#e2c08d", // tan
  "#7aa6ff", // periwinkle
];

export function colorForLane(lane: number): string {
  return LANE_PALETTE[((lane % LANE_PALETTE.length) + LANE_PALETTE.length) % LANE_PALETTE.length];
}

interface RowInternal {
  sha: string;
  lane: number;
  /** lane state (column -> awaited parent sha) AFTER processing this row. */
  outgoing: (string | null)[];
  /** columns newly created this row to hold a parent. */
  newLanes: number[];
  /** pre-existing columns a parent reused (a merge into an active lane). */
  reusedLanes: number[];
}

export function computeGraphLayout(commits: GraphCommitInput[]): GraphLayout {
  const internal: RowInternal[] = [];
  // lanes[col] = sha that column is currently waiting to reach, or null.
  let lanes: (string | null)[] = [];

  const firstFree = (): number => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  for (const commit of commits) {
    // 1. Node lane: the lowest column already waiting for this sha, else free.
    let nodeLane = lanes.indexOf(commit.sha);
    if (nodeLane === -1) nodeLane = firstFree();
    if (nodeLane >= lanes.length) lanes.length = nodeLane + 1;

    // 2. Every column waiting for this sha converges into nodeLane; clear them.
    for (let c = 0; c < lanes.length; c++) {
      if (lanes[c] === commit.sha) lanes[c] = null;
    }

    // 3. Place parents into lanes.
    const newLanes: number[] = [];
    const reusedLanes: number[] = [];
    const parentLanes: number[] = [];

    commit.parents.forEach((parent, idx) => {
      const existing = lanes.indexOf(parent);
      if (existing !== -1) {
        reusedLanes.push(existing);
        parentLanes.push(existing);
        return;
      }
      const target = idx === 0 ? nodeLane : firstFree();
      if (target >= lanes.length) lanes.length = target + 1;
      lanes[target] = parent;
      newLanes.push(target);
      parentLanes.push(target);
    });

    // If first parent reused an existing lane (or there are no parents), the
    // node's own lane is no longer carrying anything.
    if (!parentLanes.includes(nodeLane)) lanes[nodeLane] = null;

    // Trim trailing nulls so width doesn't grow unbounded.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    internal.push({
      sha: commit.sha,
      lane: nodeLane,
      outgoing: lanes.slice(),
      newLanes,
      reusedLanes,
    });
  }

  // Build the edge list for each row's bottom gap from the lane states.
  const rows: GraphRow[] = internal.map((r) => ({
    sha: r.sha,
    lane: r.lane,
    color: colorForLane(r.lane),
    edges: [],
    laneCount: 0,
  }));

  for (let i = 0; i < internal.length; i++) {
    const r = internal[i];
    const next = internal[i + 1];
    const edges: GraphEdge[] = [];
    let maxCol = r.lane;

    for (let c = 0; c < r.outgoing.length; c++) {
      const sha = r.outgoing[c];
      if (sha == null) continue;
      const bottomLane = next && next.sha === sha ? next.lane : c;
      const color = colorForLane(c);

      if (r.newLanes.includes(c) && c !== r.lane) {
        // Brand-new parent lane: a branch-out line from the node.
        edges.push({ fromLane: r.lane, toLane: bottomLane, color });
      } else if (r.reusedLanes.includes(c)) {
        // The node merges into a lane that already existed: draw both the
        // lane's own continuation and the connector from the node.
        edges.push({ fromLane: c, toLane: bottomLane, color });
        edges.push({ fromLane: r.lane, toLane: bottomLane, color });
      } else {
        // Pass-through (or first parent continuing in the node's lane).
        edges.push({ fromLane: c, toLane: bottomLane, color });
      }
      maxCol = Math.max(maxCol, c, bottomLane);
    }

    rows[i].edges = edges;
    rows[i].laneCount = maxCol + 1;
  }

  const maxLanes = rows.reduce((m, r) => Math.max(m, r.laneCount), 1);
  return { rows, maxLanes };
}
