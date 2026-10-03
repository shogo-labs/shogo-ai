// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

const RECENT_PROJECTS = 6

/** Recently touched projects in the active workspace, newest first. */
export function recentProjects<T extends { workspaceId?: string | null; updatedAt?: unknown }>(all: T[], workspaceId: string | null | undefined, limit = RECENT_PROJECTS): T[] {
  return all
    .filter((p) => !workspaceId || p.workspaceId === workspaceId)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, limit)
}
