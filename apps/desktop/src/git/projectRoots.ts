// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// In-memory `projectId → absoluteRoot` registry. Populated by the
// renderer right after a successful `POST /from-folders` (via
// `useOpenLocalFolder.ts`) so the git service can resolve external
// (folder-bound) projects without round-tripping to the API.
//
// We DO NOT persist to disk in G2 — the registry rebuilds on app launch
// from the renderer's project list (each project page mounts Workbench,
// which re-registers on resolve). Persistence is a G3 polish item.

import { resolve as resolvePath } from "node:path";

const REGISTRY = new Map<string, string>(); // projectId → absolute root

export function setProjectRoot(projectId: string, root: string): void {
  if (!projectId || !root) return;
  REGISTRY.set(projectId, resolvePath(root));
}

export function getProjectRoot(projectId: string): string | null {
  return REGISTRY.get(projectId) ?? null;
}

export function unsetProjectRoot(projectId: string): void {
  REGISTRY.delete(projectId);
}

export function clearProjectRoots(): void {
  REGISTRY.clear();
}
