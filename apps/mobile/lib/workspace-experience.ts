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

/** A paired desktop's own workspace, as far as the shell cares. */
export interface MachineWorkspaceIdentity {
  instanceId: string
  localWorkspaceId: string
  kind?: string | null
}

function experienceKind(kind: unknown): CachedWorkspaceKind | null {
  if (kind === 'personal' || kind === 'team') return kind
  return null
}

/**
 * Cache key for a machine workspace's kind. Cloud and machine workspace ids
 * come from different databases and can collide, and both are remembered by a
 * single (id, kind) entry, so the machine's is namespaced by its instance.
 */
export function machineWorkspaceKindKey(machine: MachineWorkspaceIdentity): string {
  return `${machine.instanceId}:${machine.localWorkspaceId}`
}

/**
 * Map a loaded workspace (or a cached kind) to chrome. `resolved` is false
 * only when both are missing — unknown is not treated as team.
 *
 * `machine` is the paired desktop workspace in view, if any. Its kind wins over
 * the cloud workspace's: opening Samsara (team) from `samasra` while a personal
 * cloud workspace is selected must render the team shell, and the reverse.
 * Without a kind on the machine record (state persisted by an older client) the
 * cloud-kind result is kept rather than guessed at.
 */
export function deriveWorkspaceExperience(
  workspace: { id?: string; kind?: string } | null | undefined,
  cachedKind: CachedWorkspaceKind | null,
  machine?: MachineWorkspaceIdentity | null,
): WorkspaceExperienceState {
  const rawKind = workspace ? (experienceKind(workspace.kind) ?? 'team') : null

  let kind = rawKind ?? cachedKind
  let machineKind: CachedWorkspaceKind | null = null
  if (machine?.localWorkspaceId) {
    machineKind =
      experienceKind(machine.kind) ?? getCachedWorkspaceKind(machineWorkspaceKindKey(machine))
    if (machineKind) kind = machineKind
  }

  // The cache holds one entry, so write only what is actually in view — the
  // machine's key while its workspace is open, the cloud id otherwise. Writing
  // both would evict the machine kind and flash the cloud shell on remount.
  const rememberKey =
    machine && machineKind && machine.localWorkspaceId
      ? machineWorkspaceKindKey(machine)
      : workspace?.id
  if (kind && rememberKey) rememberWorkspaceKind(rememberKey, kind)

  const experience = workspaceExperience(kind)
  if (kind) return { ...experience, resolved: true }
  return {
    ...experience,
    resolved: false,
    showProjectsTree: false,
    showMarketplace: false,
    showNewChat: false,
    showGoalsNav: false,
    showMeetingsNav: false,
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
