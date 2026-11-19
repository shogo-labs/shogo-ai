// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The invite dialog's open/close channel (SHO-454), kept in its own module so
 * the many entry points that only need `openInviteDialog()` do not pull the
 * dialog's React Native, icon and API imports into their module graph.
 *
 * It is a module-level store rather than a React context on purpose. Gluestack
 * renders popover content through its `PortalProvider`, which sits above
 * `(app)/_layout.tsx` in the tree, so a context provided there is invisible to
 * anything inside a popover — and the workspace menu, the + menu and the
 * team-chat pickers are all popovers. A store has no tree position, so every
 * entry point can open the dialog and `InviteDialogProvider` (which does need
 * the domain and auth contexts) is the only thing that has to be mounted.
 *
 * `InviteDialog.tsx` owns the provider and the dialog itself.
 */
import { useSyncExternalStore } from 'react'

export interface OpenInviteDialogOptions {
  /** Addresses to pre-fill, e.g. one typed into a team-chat picker. */
  emails?: string[]
}

export interface InviteDialogRequest {
  workspaceId: string | null
  emails: string[]
}

export interface InviteDialogContextValue {
  /** Open the dialog for a workspace (defaults to the active one). */
  openInviteDialog: (workspaceId?: string | null, opts?: OpenInviteDialogOptions) => void
  closeInviteDialog: () => void
}

let request: InviteDialogRequest | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function openInviteDialog(
  workspaceId?: string | null,
  opts?: OpenInviteDialogOptions,
): void {
  request = { workspaceId: workspaceId ?? null, emails: opts?.emails ?? [] }
  emit()
}

export function closeInviteDialog(): void {
  if (!request) return
  request = null
  emit()
}

const value: InviteDialogContextValue = { openInviteDialog, closeInviteDialog }

export function useInviteDialog(): InviteDialogContextValue {
  return value
}

/** Kept for callers that only want the dialog when the shell is mounted. */
export function useInviteDialogOptional(): InviteDialogContextValue {
  return value
}

/** The open request, or null when the dialog is closed. */
export function useInviteDialogRequest(): InviteDialogRequest | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => request,
    () => request,
  )
}

/** Test seam: drop any open request and every subscriber. */
export function _resetInviteDialogForTests(): void {
  request = null
  listeners.clear()
}
