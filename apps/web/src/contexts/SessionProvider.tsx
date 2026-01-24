/**
 * SessionProvider - Centralized session state management
 *
 * Wraps Better Auth's useSession to provide a single source of truth
 * for session data across all components. This prevents duplicate
 * /api/auth/get-session calls when multiple components use session data.
 *
 * Usage:
 * 1. Wrap your app with <SessionProvider>
 * 2. Use useSessionContext() instead of useSession() in components
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useSession as useBetterAuthSession } from '@/auth/client'

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
 */
export function SessionProvider({ children }: SessionProviderProps) {
  // This is the ONLY place we call Better Auth's useSession
  // All other components should use useSessionContext() instead
  const betterAuthSession = useBetterAuthSession()

  // Memoize the context value to prevent unnecessary re-renders
  const contextValue = useMemo<SessionContextValue>(() => {
    const sessionData = betterAuthSession.data as SessionData | null
    const userId = sessionData?.user?.id ?? null
    const isAuthenticated = !!userId

    return {
      data: sessionData,
      isPending: betterAuthSession.isPending,
      isAuthenticated,
      userId,
      error: betterAuthSession.error ?? null,
      refetch: betterAuthSession.refetch,
    }
  }, [betterAuthSession.data, betterAuthSession.isPending, betterAuthSession.error, betterAuthSession.refetch])

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
