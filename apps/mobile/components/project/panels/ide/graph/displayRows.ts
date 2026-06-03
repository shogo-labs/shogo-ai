// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Shared (web + native) builder that turns raw git-graph data into the
// aligned DisplayRow[] both renderers draw: it runs the pure lane layout,
// flags which commits are checkpoints (so they can be highlighted), and
// prepends a synthetic WIP row when the working tree is dirty.

import type { GitGraphCommit, GitStatus } from "@shogo/shared-app/hooks";

import { computeGraphLayout } from "./graphLayout";
import type { DisplayRow } from "./types";

export interface BuiltDisplayRows {
  rows: DisplayRow[];
  maxLanes: number;
}

/**
 * @param commits - commits in display (date/topo) order, newest first
 * @param workingStatus - working-tree status used to decide the WIP row
 * @param checkpointShas - SHAs that correspond to a checkpoint commit
 */
export function buildDisplayRows(
  commits: GitGraphCommit[],
  workingStatus: GitStatus | null,
  checkpointShas: Set<string>,
): BuiltDisplayRows {
  const layout = computeGraphLayout(
    commits.map((c) => ({ sha: c.sha, parents: c.parents })),
  );

  const commitRows: DisplayRow[] = layout.rows.map((r, i) => ({
    kind: "commit",
    sha: commits[i].sha,
    commit: commits[i],
    lane: r.lane,
    color: r.color,
    edges: r.edges,
    refs: commits[i].refs,
    isCheckpoint: checkpointShas.has(commits[i].sha),
  }));

  const ws = workingStatus as (GitStatus & { modified?: string[] }) | null;
  const wipCount = ws
    ? (ws.staged?.length ?? 0) +
      (ws.unstaged?.length ?? 0) +
      (ws.modified?.length ?? 0) +
      (ws.untracked?.length ?? 0)
    : 0;

  if (workingStatus?.hasChanges && commitRows.length > 0) {
    const headLane = commitRows[0].lane;
    const wip: DisplayRow = {
      kind: "wip",
      sha: null,
      lane: headLane,
      color: commitRows[0].color,
      edges: [{ fromLane: headLane, toLane: commitRows[0].lane, color: commitRows[0].color }],
      refs: [],
      isCheckpoint: false,
      wipCount,
    };
    return { rows: [wip, ...commitRows], maxLanes: layout.maxLanes };
  }

  return { rows: commitRows, maxLanes: layout.maxLanes };
}
