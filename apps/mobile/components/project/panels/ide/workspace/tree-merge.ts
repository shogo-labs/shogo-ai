// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Incremental tree refresh helpers: when the agent writes `src/a/b.ts` we only
// re-list `src/a` instead of re-walking the whole workspace, and splice the
// result in without collapsing folders the user already expanded.

import type { TreeNode } from "../types";

/**
 * Merge a freshly listed directory into the previous one. Sub-directories the
 * user already loaded/expanded keep their (deeper) children when the fresh
 * listing only has an unloaded (`lazy`/childless) stub for them.
 */
export function mergeDirChildren(old: TreeNode[] | undefined, fresh: TreeNode[]): TreeNode[] {
  if (!old || old.length === 0) return fresh;
  const oldByPath = new Map(old.map((n) => [n.path, n]));
  return fresh.map((f) => {
    if (f.kind !== "dir") return f;
    const o = oldByPath.get(f.path);
    if (!o || o.kind !== "dir" || !o.children) return f;
    if (f.children) return { ...f, children: mergeDirChildren(o.children, f.children) };
    // Fresh stub (lazy / beyond depth) but we had it loaded: keep ours.
    return { ...f, children: o.children, lazy: undefined };
  });
}

/** The directory node at `path` ("" = the tree itself), or null. */
export function findDir(tree: TreeNode[], path: string): TreeNode | null {
  if (path === "") return null;
  for (const n of tree) {
    if (n.kind !== "dir") continue;
    if (n.path === path) return n;
    if (n.children && path.startsWith(n.path + "/")) {
      const hit = findDir(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Nearest directory at or above `dirPath` that is loaded in `tree` (so
 * re-listing it will surface the change). "" means "only the root qualifies".
 */
export function nearestLoadedDir(tree: TreeNode[], dirPath: string): string {
  let p = dirPath;
  while (p !== "") {
    const d = findDir(tree, p);
    if (d && d.children) return p;
    const i = p.lastIndexOf("/");
    p = i < 0 ? "" : p.slice(0, i);
  }
  return "";
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
