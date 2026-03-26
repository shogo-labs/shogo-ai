// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared AuthProvider
 *
 * Provides sign-in, sign-up, sign-out actions and user state.
 * Uses Better Auth client for all auth operations.
 * Platform-agnostic (pure React hooks).
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { AuthClient } from './client'

export interface AuthUser {
  id: string
  name: string
  email: string
  image?: string | null
  createdAt?: string | Date
}

export interface SignUpResult {
  requiresVerification: boolean
}

export class EmailNotVerifiedError extends Error {
  constructor(message = 'Email is not verified') {
    super(message)
    this.name = 'EmailNotVerifiedError'
  }
}

export interface AuthContextValue {
  user: AuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (name: string, email: string, password: string) => Promise<SignUpResult>
  signInWithGoogle: () => void
  signOut: () => Promise<void>
  updateUser: (fields: { name?: string; image?: string }) => Promise<void>
  refreshSession: () => Promise<void>
  sendVerificationEmail: (email: string, callbackURL?: string) => Promise<void>
  clearError: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** Derive the current frontend origin (e.g. `http://localhost:8081`) on web. Returns `/` on native. */
function getFrontendOrigin(): string {
  if (typeof document !== 'undefined' && window.location?.protocol?.startsWith('http')) {
    const { protocol, hostname, port } = window.location
    const host = /^192\.168\./.test(hostname) ? 'localhost' : hostname
    return `${protocol}//${host}${port ? `:${port}` : ''}`
  }
  return ''
}

export interface AuthProviderProps {
  authClient: AuthClient
  children: ReactNode
}

export function AuthProvider({ authClient, children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    authClient.getSession().then(({ data }) => {
      if (data?.user) setUser(data.user as AuthUser)
      setIsLoading(false)
    }).catch(() => setIsLoading(false))
  }, [authClient])

  const handleSignIn = useCallback(async (email: string, password: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const { data, error: err } = await authClient.signIn.email({ email, password })
      if (err) {
        if (err.status === 403) {
          throw new EmailNotVerifiedError(err.message || 'Email is not verified')
        }
        throw new Error(err.message || 'Sign in failed')
      }
      if (data?.user) setUser(data.user as AuthUser)
    } catch (e: any) {
      if (e instanceof EmailNotVerifiedError) throw e
      const msg = e.message || 'Sign in failed'
      setError(msg)
      throw e
    } finally {
      setIsLoading(false)
    }
  }, [authClient])

  const handleSignUp = useCallback(async (name: string, email: string, password: string): Promise<SignUpResult> => {
    setIsLoading(true)
    setError(null)
    try {
      const origin = getFrontendOrigin()
      const { data, error: err } = await authClient.signUp.email({
        name, email, password,
        callbackURL: origin ? `${origin}/sign-in` : '/sign-in',
      })
      if (err) throw new Error(err.message || 'Sign up failed')
      const hasSession = !!(data as any)?.session || !!(data as any)?.token
      if (hasSession && data?.user) {
        setUser(data.user as AuthUser)
      }
      return { requiresVerification: !hasSession }
    } catch (e: any) {
      const msg = e.message || 'Sign up failed'
      setError(msg)
      throw e
    } finally {
      setIsLoading(false)
    }
  }, [authClient])

  const handleSignInWithGoogle = useCallback(async () => {
    setError(null)
    const origin = getFrontendOrigin()
    const callbackURL = origin ? `${origin}/` : '/'
    try {
      const result = await (authClient as any).signIn.social({
        provider: 'google',
        callbackURL,
      })
      if (result?.error) {
        console.error('[Auth] Google sign-in error:', result.error)
        setError(result.error.message || 'Google sign-in failed')
        return
      }
      if (result?.data?.user) {
        setUser(result.data.user as AuthUser)
        return
      }
      // Fallback: re-fetch session (expo plugin stores token in SecureStore
      // but the promise may not return user data directly)
      const { data } = await authClient.getSession()
      if (data?.user) setUser(data.user as AuthUser)
    } catch (e: any) {
      console.error('[Auth] Google sign-in exception:', e)
      setError(e.message || 'Google sign-in failed')
    }
  }, [authClient])

  const handleSignOut = useCallback(async () => {
    try { await authClient.signOut() } finally { setUser(null) }
  }, [authClient])

  const handleUpdateUser = useCallback(async (fields: { name?: string; image?: string }) => {
    const { data, error: err } = await (authClient as any).updateUser(fields)
    if (err) throw new Error(err.message || 'Failed to update profile')
    if (data?.user) {
      setUser(data.user as AuthUser)
    } else {
      setUser(prev => prev ? { ...prev, ...fields } : prev)
    }
  }, [authClient])

  const handleRefreshSession = useCallback(async () => {
    const { data } = await authClient.getSession()
    if (data?.user) setUser(data.user as AuthUser)
    else setUser(null)
  }, [authClient])

  const handleSendVerificationEmail = useCallback(async (email: string, callbackURL?: string) => {
    const origin = getFrontendOrigin()
    await (authClient as any).sendVerificationEmail({
      email,
      callbackURL: callbackURL ?? (origin ? `${origin}/sign-in` : '/sign-in'),
    })
  }, [authClient])

  return (
    <AuthContext.Provider value={{
      user, isLoading, isAuthenticated: !!user, error,
      signIn: handleSignIn, signUp: handleSignUp, signInWithGoogle: handleSignInWithGoogle, signOut: handleSignOut,
      updateUser: handleUpdateUser,
      refreshSession: handleRefreshSession,
      sendVerificationEmail: handleSendVerificationEmail,
      clearError: () => setError(null),
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
