// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A React `key` that changes when the user moves to a different workspace, and
 * only then.
 *
 * `key={activeWorkspace?.id ?? "workspace-loading"}` also changed when the
 * workspace list finished loading on a cold start (`null` → the persisted id),
 * so every phone route mounted twice: the whole navigator under
 * `MobileWorkspaceShell` was torn down and rebuilt a moment after its first
 * paint. A screen's composer could be visible and then gone (SHO-298: the
 * WebKit `phone-build-first` failure, "home composer has no layout box").
 *
 * Loading → first workspace keeps the key. A different workspace, including
 * one chosen after a sign-out (`null` in between), bumps it.
 */
export interface WorkspaceRemountState {
  /** The last real workspace id seen; `null` until one loads. */
  id: string | null
  /** Bumped each time a different real workspace replaces `id`. */
  generation: number
}

export const INITIAL_WORKSPACE_REMOUNT_STATE: WorkspaceRemountState = { id: null, generation: 0 }

export function nextWorkspaceRemountState(
  state: WorkspaceRemountState,
  workspaceId: string | null | undefined,
): WorkspaceRemountState {
  if (!workspaceId || workspaceId === state.id) return state
  if (state.id === null) return { id: workspaceId, generation: state.generation }
  return { id: workspaceId, generation: state.generation + 1 }
}

export function workspaceRemountKey(state: WorkspaceRemountState): string {
  return `workspace-${state.generation}`
}
