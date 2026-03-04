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
}

export interface AuthContextValue {
  user: AuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signUp: (name: string, email: string, password: string) => Promise<void>
  signInWithGoogle: () => void
  signOut: () => Promise<void>
  updateUser: (fields: { name?: string; image?: string }) => Promise<void>
  clearError: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

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
      if (err) throw new Error(err.message || 'Sign in failed')
      if (data?.user) setUser(data.user as AuthUser)
    } catch (e: any) {
      const msg = e.message || 'Sign in failed'
      setError(msg)
      throw e
    } finally {
      setIsLoading(false)
    }
  }, [authClient])

  const handleSignUp = useCallback(async (name: string, email: string, password: string) => {
    setIsLoading(true)
    setError(null)
    try {
      const { data, error: err } = await authClient.signUp.email({ name, email, password })
      if (err) throw new Error(err.message || 'Sign up failed')
      if (data?.user) setUser(data.user as AuthUser)
    } catch (e: any) {
      const msg = e.message || 'Sign up failed'
      setError(msg)
      throw e
    } finally {
      setIsLoading(false)
    }
  }, [authClient])

  const handleSignInWithGoogle = useCallback(() => {
    let callbackURL = '/'
    if (typeof window !== 'undefined' && window.location?.protocol?.startsWith('http')) {
      const { protocol, hostname, port } = window.location
      const host = /^192\.168\./.test(hostname) ? 'localhost' : hostname
      callbackURL = `${protocol}//${host}${port ? `:${port}` : ''}/`
    }
    ;(authClient as any).signIn.social({
      provider: 'google',
      callbackURL,
    })
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

  return (
    <AuthContext.Provider value={{
      user, isLoading, isAuthenticated: !!user, error,
      signIn: handleSignIn, signUp: handleSignUp, signInWithGoogle: handleSignInWithGoogle, signOut: handleSignOut,
      updateUser: handleUpdateUser,
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
