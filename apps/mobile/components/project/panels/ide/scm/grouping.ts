// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Single source of truth for routing a GitSnapshot into the three SCM
// sections (Merge / Staged / Changes). Previously this rule lived inline in
// ChangesList and was re-implemented in tests; both now delegate here.

import type { GitShortCode, GitSnapshot } from "../git/bridge";
import { isCountedGitCode } from "../git/git-counting";

export type ChangesSection = "merge" | "staged" | "changes";

/** Render the +added/-removed badge for a file row (caps each side at "99+"). */
export function formatChangeCount(added?: number, removed?: number): string {
  if (added === undefined && removed === undefined) return "";
  const a = added ?? 0;
  const r = removed ?? 0;
  const parts: string[] = [];
  if (a > 0) parts.push(`+${a > 99 ? "99+" : a}`);
  if (r > 0) parts.push(`-${r > 99 ? "99+" : r}`);
  return parts.join(" ");
}

export type SectionFile = {
  path: string;
  code: GitShortCode;
  added?: number;
  removed?: number;
};

/**
 * Return the files belonging to a single SCM section of a snapshot.
 *
 * - `merge`: every conflict path (code falls back to `U` when missing).
 * - `staged` / `changes`: counted, non-conflict files partitioned by whether
 *   they currently have a staged status entry.
 */
export function getFilesForSection(
  snapshot: GitSnapshot,
  section: ChangesSection,
): SectionFile[] {
  const result: SectionFile[] = [];
  const stagedPaths = new Set(Object.keys(snapshot.stagedStatus));

  if (section === "merge") {
    for (const path of snapshot.conflictPaths) {
      const code = snapshot.fileStatus[path] ?? "U";
      result.push({ path, code });
    }
    return result;
  }

  for (const [path, code] of Object.entries(snapshot.fileStatus)) {
    if (snapshot.conflictPaths.includes(path)) continue;
    if (!isCountedGitCode(code)) continue;
    const isStaged = stagedPaths.has(path);
    if (section === "staged" && !isStaged) continue;
    if (section === "changes" && isStaged) continue;
    const changes = snapshot.fileChanges?.[path];
    result.push({ path, code, added: changes?.added, removed: changes?.removed });
  }
  return result;
}

// ── Tree view (VS Code "Tree" mode) ──────────────────────────────
export interface TreeFileNode { type: "file"; name: string; file: SectionFile }
export interface TreeDirNode { type: "dir"; name: string; path: string; children: TreeNode[] }
export type TreeNode = TreeFileNode | TreeDirNode;

/**
 * Group flat file paths into a nested folder tree, compacting chains of
 * single-child directories (e.g. `src/components` → one node) like VS Code.
 */
export function buildChangesTree(files: SectionFile[]): TreeNode[] {
  const root: TreeDirNode = { type: "dir", name: "", path: "", children: [] };

  for (const file of files) {
    const segments = file.path.split("/");
    const fileName = segments.pop() ?? file.path;
    let cursor = root;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let next = cursor.children.find(
        (c): c is TreeDirNode => c.type === "dir" && c.name === segment,
      );
      if (!next) {
        next = { type: "dir", name: segment, path: prefix, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({ type: "file", name: fileName, file });
  }

  const compact = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((node) => {
      if (node.type !== "dir") return node;
      let dir = node;
      // Collapse `a` → `a/b` when `a` has exactly one child directory.
      while (dir.children.length === 1 && dir.children[0].type === "dir") {
        const only = dir.children[0];
        dir = { type: "dir", name: `${dir.name}/${only.name}`, path: only.path, children: only.children };
      }
      return { ...dir, children: compact(dir.children) };
    });

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    const dirs = nodes.filter((n): n is TreeDirNode => n.type === "dir").sort((a, b) => a.name.localeCompare(b.name));
    const filesOnly = nodes.filter((n): n is TreeFileNode => n.type === "file").sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) d.children = sortNodes(d.children);
    return [...dirs, ...filesOnly];
  };

  return sortNodes(compact(root.children));
}
