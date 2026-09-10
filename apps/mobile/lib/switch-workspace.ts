// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Persist a workspace switch without blocking the tap that chose it.
 *
 * Account is a stacked page: the home screen and sidebar stay mounted and
 * observer `projects`. Clearing/reloading that collection on the same tick
 * freezes the account list so the checkmark never moves. Paint first, then
 * reload collections. `setTimeout(0)` is used instead of InteractionManager
 * so rapid taps can cancel the previous reload (`cancel()` is a no-op in
 * some RN test mocks).
 */
import { setActiveWorkspaceId } from './workspace-store'

export type WorkspaceProjectCollection = {
  clear: () => void
  loadAll: (params: { workspaceId: string }) => Promise<unknown>
}

let pending: ReturnType<typeof setTimeout> | null = null

export function scheduleWorkspaceSwitch(
  workspaceId: string,
  projects: WorkspaceProjectCollection,
): void {
  if (pending != null) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    setActiveWorkspaceId(workspaceId)
    projects.clear()
    void projects.loadAll({ workspaceId }).catch((error) => {
      console.error('[workspace] Failed to load projects after switch:', error)
    })
  }, 0)
}
