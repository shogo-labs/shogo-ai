// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { TreeNode } from "./types";

export interface CompactFolderChain {
  node: TreeNode;
  names: string[];
  label: string;
  compacted: boolean;
}

export function buildCompactFolderChain(node: TreeNode): CompactFolderChain {
  const names = [node.name];

  if (node.kind !== "dir" || node.isRoot) {
    return { node, names, label: node.name, compacted: false };
  }

  let cursor = node;
  while (canCompactThrough(cursor)) {
    const child = cursor.children![0];
    names.push(child.name);
    cursor = child;
  }

  return {
    node: cursor,
    names,
    label: names.join("/"),
    compacted: cursor !== node,
  };
}

function canCompactThrough(node: TreeNode): node is TreeNode & { children: [TreeNode] } {
  if (node.kind !== "dir" || node.isRoot || node.lazy) return false;
  if (!node.children || node.children.length !== 1) return false;

  const [child] = node.children;
  if (child.kind !== "dir" || child.isRoot) return false;

  return true;
}
