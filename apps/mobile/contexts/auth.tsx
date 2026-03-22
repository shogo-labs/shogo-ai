// SPDX-License-Identifier: AGPL-3.0-or-later
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

export { useAuth } from '@shogo/shared-app/auth'
export type { AuthUser, AuthContextValue } from '@shogo/shared-app/auth'

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SharedAuthProvider authClient={authClient}>
      {children}
    </SharedAuthProvider>
  )
}
