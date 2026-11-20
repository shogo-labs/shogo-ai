// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Projects in the active workspace, pinned first then most-recently updated. */
export function recentProjects<T extends { id?: string; workspaceId?: string | null; updatedAt?: unknown }>(
  all: T[],
  workspaceId: string | null | undefined,
  limit?: number,
  pinnedIds?: Set<string>,
): T[] {
  const filtered = all.filter((p) => !workspaceId || p.workspaceId === workspaceId)
  filtered.sort((a, b) => {
    const aPinned = pinnedIds?.has((a as any).id ?? '') ? 1 : 0
    const bPinned = pinnedIds?.has((b as any).id ?? '') ? 1 : 0
    if (bPinned !== aPinned) return bPinned - aPinned
    return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
  })
  return limit !== undefined ? filtered.slice(0, limit) : filtered
}
