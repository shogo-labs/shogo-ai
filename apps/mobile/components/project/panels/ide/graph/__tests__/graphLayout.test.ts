// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from "bun:test";

import { colorForLane, computeGraphLayout } from "../graphLayout";

describe("computeGraphLayout", () => {
  it("lays out a linear history in a single lane", () => {
    const layout = computeGraphLayout([
      { sha: "c", parents: ["b"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(layout.maxLanes).toBe(1);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    // Each non-root row connects straight down in lane 0.
    expect(layout.rows[0].edges).toEqual([
      { fromLane: 0, toLane: 0, color: colorForLane(0) },
    ]);
    // Root commit has no outgoing edges.
    expect(layout.rows[2].edges).toEqual([]);
  });

  it("opens a second lane for a branch and joins on merge", () => {
    // m is a merge of branch tip f (lane 1) back into main b (lane 0).
    //   m -> [b, f]
    //   f -> [b]
    //   b -> [a]
    //   a -> []
    const layout = computeGraphLayout([
      { sha: "m", parents: ["b", "f"] },
      { sha: "f", parents: ["b"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(layout.maxLanes).toBe(2);
    expect(layout.rows[0].lane).toBe(0); // merge node on lane 0
    expect(layout.rows[1].lane).toBe(1); // branch tip on lane 1
    expect(layout.rows[2].lane).toBe(0); // base back on lane 0
    // From the merge node, one edge continues lane 0 and another branches to lane 1.
    const mEdges = layout.rows[0].edges;
    expect(mEdges).toContainEqual({ fromLane: 0, toLane: 0, color: colorForLane(0) });
    expect(mEdges.some((e) => e.toLane === 1)).toBe(true);
    // f (lane 1) merges back into b (lane 0) in the gap below it.
    expect(layout.rows[1].edges.some((e) => e.fromLane === 1 && e.toLane === 0)).toBe(true);
  });

  it("handles multiple disjoint roots", () => {
    const layout = computeGraphLayout([
      { sha: "x", parents: [] },
      { sha: "y", parents: [] },
    ]);
    expect(layout.rows[0].lane).toBe(0);
    expect(layout.rows[1].lane).toBe(0);
    expect(layout.rows[0].edges).toEqual([]);
  });

  it("assigns deterministic, cycling lane colors", () => {
    expect(colorForLane(0)).toBe(colorForLane(8));
    expect(colorForLane(0)).not.toBe(colorForLane(1));
  });
});
