// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mobile Auth Context
 *
 * Thin wrapper around the shared AuthProvider from @shogo/shared-app.
 * Just provides the platform-specific auth client.
 */

import type { ReactNode } from 'react'
import { AuthProvider as SharedAuthProvider, useAuth } from '@shogo/shared-app/auth'
import { authClient } from '../lib/auth-client'
import { clearActiveWorkspaceId } from '../lib/workspace-store'

export { useAuth } from '@shogo/shared-app/auth'
export type { AuthUser, AuthContextValue } from '@shogo/shared-app/auth'

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    // `shogo:active-workspace-id` is a bare, unscoped-by-user cache key.
    // Without clearing it here, signing out and into a different account
    // on the same browser/device leaves the previous account's workspace
    // id active, and every workspace-scoped fetch for the new account
    // 400/403s with "Access denied to this workspace" until they manually
    // switch workspaces. See `lib/workspace-store.ts`.
    <SharedAuthProvider authClient={authClient} onSignOut={clearActiveWorkspaceId}>
      {children}
    </SharedAuthProvider>
  )
}
