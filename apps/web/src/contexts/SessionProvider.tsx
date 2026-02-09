/**
 * SessionProvider - Centralized session state management
 *
 * Wraps Better Auth's useSession to provide a single source of truth
 * for session data across all components. This prevents duplicate
 * /api/auth/get-session calls when multiple components use session data.
 *
 * Also fetches the user's role from /api/me for super admin checks.
 *
 * Usage:
 * 1. Wrap your app with <SessionProvider>
 * 2. Use useSessionContext() instead of useSession() in components
 */

import { createContext, useContext, useMemo, useState, useEffect, useCallback, type ReactNode } from 'react'
import { useSession as useBetterAuthSession } from '@/auth/client'

export type UserRole = 'user' | 'super_admin'

/**
 * Session data from Better Auth
 */
interface SessionData {
  user: {
    id: string
    email: string
    name?: string
    image?: string
    createdAt: Date
    updatedAt: Date
    emailVerified: boolean
  } | null
  session: {
    id: string
    userId: string
    token: string
    expiresAt: Date
    createdAt: Date
    updatedAt: Date
    ipAddress?: string
    userAgent?: string
  } | null
}

/**
 * Session context value
 */
interface SessionContextValue {
  /** Session data (user + session) */
  data: SessionData | null
  /** Whether the session is still loading */
  isPending: boolean
  /** Whether the user is authenticated */
  isAuthenticated: boolean
  /** Current user ID (convenience accessor) */
  userId: string | null
  /** User role from the database (fetched via /api/me) */
  userRole: UserRole | null
  /** Whether the user is a super admin */
  isSuperAdmin: boolean
  /** Error if session fetch failed */
  error: Error | null
  /** Refetch the session */
  refetch: () => void
}

const SessionContext = createContext<SessionContextValue | null>(null)

/**
 * Hook to access session context.
 * Must be used within a SessionProvider.
 */
export function useSessionContext(): SessionContextValue {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSessionContext must be used within a SessionProvider')
  }
  return context
}

/**
 * Props for SessionProvider
 */
interface SessionProviderProps {
  children: ReactNode
}

/**
 * Provides centralized session state to the app.
 * Only makes a single Better Auth session request, shared across all consumers.
 * Also fetches user role from /api/me for admin access control.
 */
export function SessionProvider({ children }: SessionProviderProps) {
  // This is the ONLY place we call Better Auth's useSession
  // All other components should use useSessionContext() instead
  const betterAuthSession = useBetterAuthSession()
  const [userRole, setUserRole] = useState<UserRole | null>(null)

  const sessionData = betterAuthSession.data as SessionData | null
  const userId = sessionData?.user?.id ?? null

  // Fetch user role from /api/me when authenticated
  useEffect(() => {
    if (!userId) {
      setUserRole(null)
      return
    }

    let cancelled = false
    fetch('/api/me', { credentials: 'include' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data.ok && data.data?.role) {
          setUserRole(data.data.role as UserRole)
        }
      })
      .catch(() => {
        // Silently fail - role will remain null
      })

    return () => {
      cancelled = true
    }
  }, [userId])

  const refetch = useCallback(() => {
    betterAuthSession.refetch()
    // Also re-fetch role
    if (userId) {
      fetch('/api/me', { credentials: 'include' })
        .then((res) => res.json())
        .then((data) => {
          if (data.ok && data.data?.role) {
            setUserRole(data.data.role as UserRole)
          }
        })
        .catch(() => {})
    }
  }, [betterAuthSession.refetch, userId])

  // Memoize the context value to prevent unnecessary re-renders
  const contextValue = useMemo<SessionContextValue>(() => {
    const isAuthenticated = !!userId

    return {
      data: sessionData,
      isPending: betterAuthSession.isPending,
      isAuthenticated,
      userId,
      userRole,
      isSuperAdmin: userRole === 'super_admin',
      error: betterAuthSession.error ?? null,
      refetch,
    }
  }, [sessionData, betterAuthSession.isPending, betterAuthSession.error, refetch, userId, userRole])

  return (
    <SessionContext.Provider value={contextValue}>
      {children}
    </SessionContext.Provider>
  )
}

/**
 * Backwards-compatible hook that mimics Better Auth's useSession return type.
 * Use this when migrating from direct useSession() calls.
 */
export function useSession() {
  const context = useSessionContext()
  
  // Return a shape compatible with Better Auth's useSession
  return {
    data: context.data,
    isPending: context.isPending,
    error: context.error,
    refetch: context.refetch,
  }
}
