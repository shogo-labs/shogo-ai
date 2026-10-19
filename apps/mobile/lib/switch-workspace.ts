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

/**
 * Where a workspace switch lands: the workspace agent on a fresh chat for
 * every workspace kind. `/(app)` resolves the landing (see
 * `lib/root-destination`), so switching workspace and opening the app agree.
 */
export function homePathForWorkspaceKind(): '/(app)' {
  return '/(app)'
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
 * (`useWorkspaceExperience`: `MobileWorkspaceShell` vs.
 * the classic `AppSidebar`, plus every collection scoped to the old
 * workspace). Reactively reconciling all of that mounted UI in place after a
 * switch is fragile, so on web/desktop force a clean reload instead — the
 * newly active workspace id is already persisted by the time this runs.
 * Listeners reset the route: every workspace lands on its agent chat. On web
 * that listener does a full navigation. Reload only if nothing is listening
 * (the shell is not mounted).
 */
export function reloadAfterWorkspaceSwitch(): void {
  for (const listener of workspaceSwitchedListeners) listener()
  if (workspaceSwitchedListeners.size > 0) return
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.reload()
  }
}

/**
 * Whether a finishing turn should force the screen back to the workspace that
 * owns its chat.
 *
 * A legacy project session gets upgraded to a workspace session through several
 * collection refreshes, and one of those can briefly omit the team; restoring
 * the chat's own workspace before the sidebar reconciles keeps the selection
 * valid. It must **not** undo a switch the person just made: pressing a chat
 * chip for another workspace moves this screen to a different session, and the
 * source turn then finishes while the target is already open — clamping there
 * would put the app back in the workspace whose chat the person just left.
 */
export function shouldRestoreChatWorkspace(args: {
  chatWorkspaceId: string | null | undefined
  activeWorkspaceId: string | null
  finishedSessionId: string | null | undefined
  liveSessionId: string | null | undefined
}): boolean {
  if (!args.chatWorkspaceId) return false
  if (args.activeWorkspaceId === args.chatWorkspaceId) return false
  if (args.finishedSessionId && args.liveSessionId !== args.finishedSessionId) return false
  return true
}

/**
 * Adopt the workspace that owns a chat when a deep link opens a session the app
 * is not currently in — `/agent?chatSessionId=<id>` from a chat chip.
 *
 * Returns true when it switched, so the caller waits for the re-render instead
 * of loading the session against the wrong workspace (the server rejects a send
 * there with `session_not_in_workspace`). Deliberately *not* driven from a URL
 * param: on web the chip press is a full navigation, and the boot bounces
 * through `/`, replacing the URL before any mount effect reads it — which is
 * why `?workspace=` never survived. This runs after boot, from the fact the
 * screen already has (the session's own workspace), so no ordering race is left
 * and native (no reload at all) is covered too.
 */
export function adoptChatWorkspace(
  chatWorkspaceId: string | null | undefined,
  activeWorkspaceId: string | null | undefined,
  projects?: WorkspaceProjectCollection,
): boolean {
  if (!chatWorkspaceId || chatWorkspaceId === activeWorkspaceId) return false
  setActiveWorkspaceId(chatWorkspaceId)
  if (projects) reloadProjects(chatWorkspaceId, projects)
  return true
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
