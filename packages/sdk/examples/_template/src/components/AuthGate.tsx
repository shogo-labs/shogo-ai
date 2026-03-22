// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AuthGate - Protects routes requiring authentication
 *
 * Production-grade auth protection:
 * - Shows loading state during auth initialization
 * - Renders LoginPage for unauthenticated users
 * - Renders children for authenticated users
 * - MobX observer for reactive auth state updates
 */

import { observer } from 'mobx-react-lite'
import { useStores } from '../stores'
import { LoginPage } from './LoginPage'
import { LoadingSpinner } from './LoadingSpinner'

interface AuthGateProps {
  children: React.ReactNode
}

/**
 * AuthGate component
 *
 * Wrap protected content with this component to require authentication.
 * Automatically handles loading states and redirects to login.
 */
export const AuthGate = observer(function AuthGate({ children }: AuthGateProps) {
  const { auth } = useStores()

  // Show loading during initial auth check
  if (auth.isLoading && !auth.user) {
    return <LoadingSpinner message="Checking authentication..." />
  }

  // Show login if not authenticated
  if (!auth.isAuthenticated) {
    return <LoginPage />
  }

  // Render protected content
  return <>{children}</>
})
