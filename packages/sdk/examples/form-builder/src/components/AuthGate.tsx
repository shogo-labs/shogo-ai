// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { observer } from 'mobx-react-lite'
import { useStores } from '../stores'
import { LoginPage } from './LoginPage'
import { LoadingSpinner } from './LoadingSpinner'

export const AuthGate = observer(function AuthGate({ children }: { children: React.ReactNode }) {
  const { auth } = useStores()
  if (auth.isLoading && !auth.user) return <LoadingSpinner message="Checking authentication..." />
  if (!auth.isAuthenticated) return <LoginPage />
  return <>{children}</>
})
