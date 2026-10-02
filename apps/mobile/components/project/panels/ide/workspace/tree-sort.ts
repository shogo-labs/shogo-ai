// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Explorer ordering shared by every workspace backend: folders first, then
// names compared case-insensitively with natural number ordering
// (`file2` before `file10`). Mirrors VS Code's default `explorer.sortOrder`
// and `compareWorkspaceTreeNodes` in the agent-runtime walker, so the order is
// identical whichever backend (cloud, desktop IPC, local folder) served it.

import type { WsNode } from "./types";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareTreeNodes(a: Pick<WsNode, "name" | "kind">, b: Pick<WsNode, "name" | "kind">): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const byName = collator.compare(a.name, b.name);
  if (byName !== 0) return byName;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Returns `nodes` sorted (new array); recursively sorts loaded children. */
export function sortTree<T extends WsNode>(nodes: readonly T[]): T[] {
  return [...nodes]
    .sort(compareTreeNodes)
    .map((n) => (n.children ? { ...n, children: sortTree(n.children) } : n)) as T[];
}
