// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin console access check, and the gate decision the `(admin)` layout
 * renders and routes from.
 *
 * Why a decision type and not a boolean: "the session has not resolved yet" and
 * "the session exists without admin access" are indistinguishable to a client
 * that is still waiting, and in local mode they *are* the same thing until
 * auto-sign-in has run. A cold load of `/admin/…` never passes through
 * `app/index.tsx`, so this hook performs the local auto-sign-in itself and
 * reports `loading` until the answer is known. Deciding earlier forwarded every
 * local admin deep link to `/(app)` (SHO-116).
 */

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/auth'
import { useDomainHttp } from '../contexts/domain'
import { api } from '../lib/api'
import { autoSignInLocally } from '../lib/auth-client'
import { isLocalMode, usePlatformConfig } from '../lib/platform-config'

type UserRole = 'user' | 'super_admin'

export type AdminGateDecision = 'loading' | 'redirect' | 'render'

export type AdminGateInput = {
  /** Better Auth is still resolving the session. */
  authLoading: boolean
  /** `/api/me` is in flight. */
  adminCheckPending: boolean
  isAuthenticated: boolean
  hasAdminAccess: boolean
  localMode: boolean
  /** Local auto-sign-in finished — either it signed in or it definitively failed. */
  localSignInSettled: boolean
}

/**
 * `loading` → keep rendering the spinner, decide nothing.
 * `redirect` → a settled session genuinely lacks admin access; forward to the app.
 * `render`   → the session has admin access; mount the console.
 */
export function adminGateDecision(gate: AdminGateInput): AdminGateDecision {
  if (gate.authLoading || gate.adminCheckPending) return 'loading'
  if (gate.localMode && !gate.isAuthenticated && !gate.localSignInSettled) return 'loading'
  if (!gate.isAuthenticated || !gate.hasAdminAccess) return 'redirect'
  return 'render'
}

export function useAdminCheck() {
  const { user, isAuthenticated, isLoading: authLoading, refreshSession } = useAuth()
  // `isLocalMode()` is the build/desktop signal and is known on the first
  // render, unlike the fetched config — the gate must not decide before it.
  const localMode = usePlatformConfig().localMode || isLocalMode()
  const http = useDomainHttp()
  const [role, setRole] = useState<UserRole | null>(null)
  const [scopes, setScopes] = useState<string[]>([])
  const [checking, setChecking] = useState(true)
  const [localSignInSettled, setLocalSignInSettled] = useState(false)
  const localSignInAttempted = useRef(false)

  useEffect(() => {
    if (!localMode) return
    if (isAuthenticated) {
      setLocalSignInSettled(true)
      return
    }
    if (authLoading || localSignInAttempted.current) return
    localSignInAttempted.current = true
    autoSignInLocally()
      .then(() => refreshSession())
      .catch((err) => console.error('[AdminLayout] Local auto-sign-in failed:', err))
      .finally(() => setLocalSignInSettled(true))
  }, [authLoading, isAuthenticated, localMode, refreshSession])

  useEffect(() => {
    if (authLoading) return
    if (!isAuthenticated) {
      setChecking(false)
      return
    }
    let cancelled = false
    setChecking(true)
    api.getMe(http)
      .then((data) => {
        if (!cancelled && data.ok && data.data?.role) {
          setRole(data.data.role as UserRole)
          setScopes(Array.isArray(data.data.adminScopes) ? data.data.adminScopes : [])
        }
      })
      .catch((e) => console.error('[AdminLayout] Failed to verify admin role:', e))
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => { cancelled = true }
  }, [http, isAuthenticated, authLoading, user?.id])

  const isSuperAdmin = role === 'super_admin'
  // Portal access: full super admins OR users granted at least one scope.
  const hasAdminAccess = isSuperAdmin || scopes.length > 0

  return {
    isSuperAdmin,
    scopes,
    hasAdminAccess,
    // The console is a separate route group from (app), so a local deep link
    // into it is the one admin path that never went through the root gate.
    localMode,
    gate: adminGateDecision({
      authLoading,
      adminCheckPending: checking,
      isAuthenticated,
      hasAdminAccess,
      localMode,
      localSignInSettled: !localMode || localSignInSettled,
    }),
    isAuthenticated,
    userEmail: user?.email,
    userName: user?.name,
  }
}
