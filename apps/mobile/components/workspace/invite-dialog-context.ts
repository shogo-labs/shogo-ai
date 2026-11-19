// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The invite dialog's context (SHO-454), kept in its own module so the many
 * entry points that only need `openInviteDialog()` do not pull the dialog's
 * React Native, icon and API imports into their module graph.
 *
 * `InviteDialog.tsx` owns the provider and the dialog itself.
 */
import { createContext, useContext } from 'react'

export interface OpenInviteDialogOptions {
  /** Addresses to pre-fill, e.g. one typed into a team-chat picker. */
  emails?: string[]
}

export interface InviteDialogContextValue {
  /** Open the dialog for a workspace (defaults to the active one). */
  openInviteDialog: (workspaceId?: string | null, opts?: OpenInviteDialogOptions) => void
  closeInviteDialog: () => void
}

export const InviteDialogContext = createContext<InviteDialogContextValue | null>(null)

export function useInviteDialog(): InviteDialogContextValue {
  const ctx = useContext(InviteDialogContext)
  if (!ctx) throw new Error('useInviteDialog must be used inside <InviteDialogProvider>')
  return ctx
}

/** Null outside the provider, so a component can render without the shell. */
export function useInviteDialogOptional(): InviteDialogContextValue | null {
  return useContext(InviteDialogContext)
}
