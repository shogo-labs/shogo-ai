/**
 * Shared SessionProvider
 *
 * Wraps Better Auth's useSession to provide a single source of truth
 * for session data. Prevents duplicate /api/auth/get-session calls.
 * Optionally fetches user role from /api/me for admin checks.
 */

import { createContext, useContext, useMemo, useState, useEffect, useCallback, type ReactNode } from 'react'
import type { AuthClient } from './client'

export type UserRole = 'user' | 'super_admin'

interface SessionUser {
  id: string
  email: string
  name?: string
  image?: string
  createdAt: Date
  updatedAt: Date
  emailVerified: boolean
}

interface SessionToken {
  id: string
  userId: string
  token: string
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
  ipAddress?: string
  userAgent?: string
}

export interface SessionData {
  user: SessionUser | null
  session: SessionToken | null
}

export interface SessionContextValue {
  data: SessionData | null
  isPending: boolean
  isAuthenticated: boolean
  userId: string | null
  userRole: UserRole | null
  isSuperAdmin: boolean
  error: Error | null
  refetch: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function useSessionContext(): SessionContextValue {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSessionContext must be used within a SessionProvider')
  }
  return context
}

export function useSession() {
  const context = useSessionContext()
  return {
    data: context.data,
    isPending: context.isPending,
    error: context.error,
    refetch: context.refetch,
  }
}

export interface SessionProviderProps {
  authClient: AuthClient
  apiBaseUrl?: string
  fetchUserRole?: boolean
  children: ReactNode
}

export function SessionProvider({ authClient, apiBaseUrl = '', fetchUserRole = true, children }: SessionProviderProps) {
  const betterAuthSession = authClient.useSession()
  const [userRole, setUserRole] = useState<UserRole | null>(null)

  const sessionData = betterAuthSession.data as SessionData | null
  const userId = sessionData?.user?.id ?? null

  useEffect(() => {
    if (!userId || !fetchUserRole) {
      setUserRole(null)
      return
    }

    let cancelled = false
    fetch(`${apiBaseUrl}/api/me`, { credentials: 'include' })
      .then((res) => res.json())
      .then((data: any) => {
        if (!cancelled && data.ok && data.data?.role) {
          setUserRole(data.data.role as UserRole)
        }
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [userId, apiBaseUrl, fetchUserRole])

  const refetch = useCallback(() => {
    betterAuthSession.refetch()
    if (userId && fetchUserRole) {
      fetch(`${apiBaseUrl}/api/me`, { credentials: 'include' })
        .then((res) => res.json())
        .then((data: any) => {
          if (data.ok && data.data?.role) {
            setUserRole(data.data.role as UserRole)
          }
        })
        .catch(() => {})
    }
  }, [betterAuthSession.refetch, userId, apiBaseUrl, fetchUserRole])

  const contextValue = useMemo<SessionContextValue>(() => ({
    data: sessionData,
    isPending: betterAuthSession.isPending,
    isAuthenticated: !!userId,
    userId,
    userRole,
    isSuperAdmin: userRole === 'super_admin',
    error: betterAuthSession.error ?? null,
    refetch,
  }), [sessionData, betterAuthSession.isPending, betterAuthSession.error, refetch, userId, userRole])

  return (
    <SessionContext.Provider value={contextValue}>
      {children}
    </SessionContext.Provider>
  )
}
