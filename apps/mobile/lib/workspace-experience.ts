// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Leaf import: the `@shogo/shared-app` barrel also loads the domain SDK.
import {
  workspaceExperience,
  type WorkspaceExperience,
} from '../../../packages/shared-app/src/hooks/useWorkspaceExperience'
import {
  getCachedWorkspaceKind,
  rememberWorkspaceKind,
  type CachedWorkspaceKind,
} from './workspace-store'

export interface WorkspaceExperienceState extends WorkspaceExperience {
  /**
   * False only when no workspace is loaded and no cached kind exists for
   * the active id. Callers should keep chrome at a stable size (skeleton)
   * instead of painting the team shell and swapping it.
   */
  resolved: boolean
}

function experienceKind(kind: unknown): CachedWorkspaceKind | null {
  if (kind === 'personal' || kind === 'team') return kind
  return null
}

/**
 * Map a loaded workspace (or a cached kind) to chrome. `resolved` is false
 * only when both are missing — unknown is not treated as team.
 */
export function deriveWorkspaceExperience(
  workspace: { id?: string; kind?: string } | null | undefined,
  cachedKind: CachedWorkspaceKind | null,
): WorkspaceExperienceState {
  const rawKind = workspace ? (experienceKind(workspace.kind) ?? 'team') : null
  if (workspace?.id && rawKind) rememberWorkspaceKind(workspace.id, rawKind)
  const kind = rawKind ?? cachedKind
  const experience = workspaceExperience(kind)
  if (kind) return { ...experience, resolved: true }
  return {
    ...experience,
    resolved: false,
    showProjectsTree: false,
    showMarketplace: false,
    showNewChat: false,
    showGoalsNav: false,
    showSideChatsNav: false,
  }
}

export function cachedKindForActiveWorkspace(
  workspace: { id?: string } | null | undefined,
  activeWorkspaceId: string | null,
): CachedWorkspaceKind | null {
  if (workspace) return null
  return getCachedWorkspaceKind(activeWorkspaceId)
}
