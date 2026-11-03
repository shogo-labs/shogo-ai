// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `useWorkspaceInView()` — the workspace on screen (SHO-130). A workspace
 * hosted on a paired desktop is the selected cloud workspace like any other
 * (SHO-285); this only adds where its agent runs.
 */
import { useMemo } from 'react'
import { useIsRemoteSource } from '@shogo/shared-app/domain'
import { useActiveWorkspace } from './useActiveWorkspace'
import { workspaceInView, type WorkspaceInView } from '../lib/workspace-in-view'

export type { WorkspaceInView }

export function useWorkspaceInView(): WorkspaceInView | null {
  const cloud = useActiveWorkspace()
  const cloudId = cloud?.id ?? null
  const cloudName = cloud?.name ?? null
  const cloudKind = cloud?.kind ?? null
  const hostInstanceId = (cloud as { hostInstanceId?: string | null } | null)?.hostInstanceId || null
  return useMemo(
    () => workspaceInView(cloudId ? { id: cloudId, name: cloudName, kind: cloudKind, hostInstanceId } : null),
    [cloudId, cloudName, cloudKind, hostInstanceId],
  )
}

export interface WorkspaceDataScope {
  /** The workspace whose rows a list shows; `null` while none is selected. */
  workspaceId: string | null
  /**
   * A remote desktop (Remote Control) reports its rows under workspace ids the
   * cloud doesn't know, so its lists stay unscoped.
   */
  everyWorkspace: boolean
}

/** What a list of workspace data (projects, tasks, activity) is scoped to. */
export function useWorkspaceDataScope(): WorkspaceDataScope {
  const inView = useWorkspaceInView()
  const isRemoteSource = useIsRemoteSource()
  const workspaceId = inView?.id ?? null
  const everyWorkspace = isRemoteSource
  return useMemo(() => ({ workspaceId, everyWorkspace }), [workspaceId, everyWorkspace])
}
