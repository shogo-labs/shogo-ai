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
import { Platform } from 'react-native'
import { setActiveWorkspaceId } from './workspace-store'

export type WorkspaceProjectCollection = {
  clear: () => void
  loadAll: (params: { workspaceId: string }) => Promise<unknown>
}

let pending: ReturnType<typeof setTimeout> | null = null

export function scheduleWorkspaceSwitch(
  workspaceId: string,
  projects: WorkspaceProjectCollection,
  onSwitched?: () => void,
): void {
  if (pending != null) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    setActiveWorkspaceId(workspaceId)
    onSwitched?.()
    projects.clear()
    void projects.loadAll({ workspaceId }).catch((error) => {
      console.error('[workspace] Failed to load projects after switch:', error)
    })
  }, 0)
}

/**
 * The active workspace's `kind` decides which sidebar/shell chrome renders
 * (`useWorkspaceExperience`: `WorkspaceAgentShell`/`MobileWorkspaceShell` vs.
 * the classic `AppSidebar`, plus every collection scoped to the old
 * workspace). Reactively reconciling all of that mounted UI in place after a
 * switch is fragile, so on web/desktop force a clean reload instead — the
 * newly active workspace id is already persisted by the time this runs.
 * Native call sites may pass this too; it's a no-op off web.
 */
export function reloadAfterWorkspaceSwitch(): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.reload()
  }
}
