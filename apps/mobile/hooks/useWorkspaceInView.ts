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
