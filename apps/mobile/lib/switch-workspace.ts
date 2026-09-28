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

type WorkspaceSwitchedListener = () => void
const workspaceSwitchedListeners = new Set<WorkspaceSwitchedListener>()

/** Personal opens the companion chat. Team opens the project builder. */
export function homePathForWorkspaceKind(
  kind: string | null | undefined,
): '/(app)' | '/(app)/new-project' {
  return kind === 'personal' ? '/(app)' : '/(app)/new-project'
}

/** Shells subscribe so a workspace switch can reset route and chrome. */
export function subscribeWorkspaceSwitched(
  listener: WorkspaceSwitchedListener,
): () => void {
  workspaceSwitchedListeners.add(listener)
  return () => {
    workspaceSwitchedListeners.delete(listener)
  }
}

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
    reloadProjects(workspaceId, projects)
  }, 0)
}

function reloadProjects(workspaceId: string, projects: WorkspaceProjectCollection): void {
  projects.clear()
  void projects.loadAll({ workspaceId }).catch((error) => {
    console.error('[workspace] Failed to load projects after switch:', error)
  })
}

/**
 * The active workspace's `kind` decides which sidebar/shell chrome renders
 * (`useWorkspaceExperience`: `WorkspaceAgentShell`/`MobileWorkspaceShell` vs.
 * the classic `AppSidebar`, plus every collection scoped to the old
 * workspace). Reactively reconciling all of that mounted UI in place after a
 * switch is fragile, so on web/desktop force a clean reload instead — the
 * newly active workspace id is already persisted by the time this runs.
 * Listeners reset the route: personal lands on main chat, team on the
 * project builder. On web that listener does a full navigation. Reload
 * only if nothing is listening (the shell is not mounted).
 */
export function reloadAfterWorkspaceSwitch(): void {
  for (const listener of workspaceSwitchedListeners) listener()
  if (workspaceSwitchedListeners.size > 0) return
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.reload()
  }
}

/**
 * Make `workspaceId` active and open `path` (an Expo Router href) in it.
 * Same-workspace targets are a plain push; cross-workspace targets do a full
 * navigation on web for the reason described on `reloadAfterWorkspaceSwitch`.
 * On native the switch is applied like `scheduleWorkspaceSwitch` (projects
 * reloaded for the new workspace) and the target is pushed so Back still
 * works.
 */
export function openInWorkspace(
  router: { push: (href: any) => void },
  workspaceId: string | undefined,
  path: string,
  currentWorkspaceId: string | undefined,
  projects?: WorkspaceProjectCollection,
): void {
  if (!workspaceId || workspaceId === currentWorkspaceId) {
    router.push(path)
    return
  }
  // A queued switch from an earlier tap would otherwise land after this one.
  if (pending != null) {
    clearTimeout(pending)
    pending = null
  }
  setActiveWorkspaceId(workspaceId)
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // Route groups like `(app)` aren't part of the URL.
    window.location.assign(path.replace(/\/\([^)]+\)/g, '') || '/')
    return
  }
  if (projects) reloadProjects(workspaceId, projects)
  router.push(path)
}
