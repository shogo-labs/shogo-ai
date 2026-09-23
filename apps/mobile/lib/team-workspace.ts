// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

interface WorkspaceLike {
  id: string
  kind?: string
}

interface MembershipLike {
  workspaceId?: string | null
  userId?: string | null
  role?: string | null
}

/**
 * The user's own Team workspace: the non-personal workspace they own, falling
 * back to the first non-personal one (e.g. memberships not loaded yet, or
 * they only belong to teams they were invited to).
 */
export function pickTeamWorkspace<T extends WorkspaceLike>(
  workspaces: readonly T[],
  memberships: readonly MembershipLike[],
  userId: string | undefined,
): T | undefined {
  const teams = workspaces.filter((w) => w.kind !== 'personal')
  const owned = teams.find((w) =>
    memberships.some(
      (m) => m.workspaceId === w.id && m.role === 'owner' && (!userId || m.userId === userId),
    ),
  )
  return owned ?? teams[0]
}
