// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo, useSyncExternalStore } from 'react'
import { reaction } from 'mobx'
import { useWorkspaceCollection } from '../contexts/domain'
import { useActiveWorkspace } from './useActiveWorkspace'
import { getActiveWorkspaceId } from '../lib/workspace-store'
import {
  cachedKindForActiveWorkspace,
  deriveWorkspaceExperience,
  type WorkspaceExperienceState,
} from '../lib/workspace-experience'

export type { WorkspaceExperienceState }

/**
 * Re-render when the workspace collection's ids or kinds change, including
 * from components that are not MobX observers.
 */
function useWorkspaceListVersion(): string {
  const workspaces = useWorkspaceCollection()
  const read = () =>
    workspaces?.all
      .map((workspace: { id: string; kind?: string }) => `${workspace.id}:${workspace.kind ?? ''}`)
      .join('|') ?? ''
  return useSyncExternalStore(
    (onStoreChange) => {
      if (!workspaces) return () => {}
      return reaction(read, () => onStoreChange())
    },
    read,
    read,
  )
}

/**
 * The single hook every mobile surface should use to decide what varies
 * between workspace shells (sidebar nav, bottom tabs, home route, composer
 * capabilities, ...) instead of reading `workspace?.kind === 'personal'`
 * ad-hoc. See `workspaceExperience()` in `@shogo/shared-app` for the
 * descriptor and rationale.
 *
 * While the collection is still loading, a kind cached for the active
 * workspace id is used and `resolved` stays true, so returning users do not
 * flash the team shell. With no cache, `resolved` is false.
 */
export function useWorkspaceExperience(): WorkspaceExperienceState {
  const workspace = useActiveWorkspace()
  const listVersion = useWorkspaceListVersion()
  const activeId = getActiveWorkspaceId()
  const cachedKind = cachedKindForActiveWorkspace(workspace, activeId)
  return useMemo(
    () => deriveWorkspaceExperience(workspace, cachedKind),
    [workspace, cachedKind, listVersion],
  )
}
