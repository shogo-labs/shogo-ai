// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { GitGraphCommit, GitRef } from "@shogo/shared-app/hooks";

import type { GraphEdge } from "./graphLayout";

export const ROW_HEIGHT = 30;
export const LANE_WIDTH = 16;
export const GRAPH_PAD_LEFT = 14;
export const NODE_RADIUS = 6;

/** A single rendered row, shared across the branch rail / graph / message columns. */
export interface DisplayRow {
  kind: "wip" | "commit";
  sha: string | null;
  commit?: GitGraphCommit;
  lane: number;
  color: string;
  /** Edges drawn in the gap below this row. */
  edges: GraphEdge[];
  refs: GitRef[];
  isCheckpoint: boolean;
  /** True for the commit currently published/live (resolved from the publish pointer tag). */
  isLive: boolean;
  /** Working-dir change count, only for the WIP row. */
  wipCount?: number;
}

export function laneCenterX(lane: number): number {
  return GRAPH_PAD_LEFT + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

export function graphWidth(maxLanes: number): number {
  return GRAPH_PAD_LEFT * 2 + Math.max(1, maxLanes) * LANE_WIDTH;
}
