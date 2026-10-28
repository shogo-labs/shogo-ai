// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useWorkspaceInView()` — the workspace on screen, including a paired
 * computer's own workspace while it is open (SHO-130).
 *
 * `useActiveWorkspace()` answers the *cloud* workspace (identity, billing,
 * membership). Anything that shows or scopes workspace data — a chat session,
 * a project filter, the channels — must use this, or a machine workspace
 * renders as whatever cloud workspace happens to be selected.
 */
import { useMemo } from 'react'
import { useIsRemoteSource } from '@shogo/shared-app/domain'
import { useActiveInstance } from '../contexts/active-instance'
import { useActiveWorkspace } from './useActiveWorkspace'
import { workspaceInView, type WorkspaceInView } from '../lib/workspace-in-view'

export type { WorkspaceInView }

export function useWorkspaceInView(): WorkspaceInView | null {
  const cloud = useActiveWorkspace()
  const { instance } = useActiveInstance()
  const cloudId = cloud?.id ?? null
  const cloudName = cloud?.name ?? null
  const cloudKind = cloud?.kind ?? null
  return useMemo(
    () => workspaceInView(cloudId ? { id: cloudId, name: cloudName, kind: cloudKind } : null, instance),
    [cloudId, cloudName, cloudKind, instance],
  )
}

export interface WorkspaceDataScope {
  /** The workspace whose rows a list shows; `null` while none is selected. */
  workspaceId: string | null
  /**
   * A remote desktop that is not one of its own workspaces in view reports its
   * rows under workspace ids the cloud doesn't know, so its lists stay
   * unscoped. A machine workspace never is: unscoped, the cloud copy answers
   * with every workspace the cloud account can see.
   */
  everyWorkspace: boolean
}

/** What a list of workspace data (projects, tasks, activity) is scoped to. */
export function useWorkspaceDataScope(): WorkspaceDataScope {
  const inView = useWorkspaceInView()
  const isRemoteSource = useIsRemoteSource()
  const workspaceId = inView?.id ?? null
  const everyWorkspace = isRemoteSource && inView?.host !== 'machine'
  return useMemo(() => ({ workspaceId, everyWorkspace }), [workspaceId, everyWorkspace])
}
