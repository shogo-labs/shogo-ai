/**
 * StableAuthContext - Provides stable auth state that survives transient refetch states
 *
 * Better Auth's useSession() can return transient "no session" states during
 * tab focus refetches. This causes components that query by userId to see
 * empty results momentarily.
 *
 * This context provides a STABLE userId that:
 * - Updates when a valid user ID is received
 * - NEVER clears on transient null states
 * - Only clears on explicit logout (TODO: implement logout detection)
 *
 * Usage:
 * ```tsx
 * // In App.tsx - wrap your app
 * <StableAuthProvider session={session}>
 *   <DomainProvider>...</DomainProvider>
 * </StableAuthProvider>
 *
 * // In components - use stable auth instead of useSession() for userId
 * function MyComponent() {
 *   const { userId, isAuthenticated } = useStableAuth()
 *   const data = collection.findByUser(userId) // Stable!
 * }
 * ```
 */

import { createContext, useContext, useRef, useMemo, type ReactNode } from 'react'

// ============================================================================
// Types
// ============================================================================

export interface StableAuthState {
  /** Stable user ID - persists through transient refetch states */
  userId: string | undefined
  /** True if we have a stable user ID */
  isAuthenticated: boolean
  /** The raw session from Better Auth (may have transient states) */
  rawSession: {
    isPending: boolean
    data: { user?: { id?: string } } | null | undefined
  }
}

export interface StableAuthProviderProps {
  /** The session object from useSession() */
  session: {
    isPending: boolean
    data: { user?: { id?: string } } | null | undefined
  }
  children: ReactNode
}

// ============================================================================
// Context
// ============================================================================

const StableAuthContext = createContext<StableAuthState | null>(null)

// ============================================================================
// Provider
// ============================================================================

/**
 * Provider that stabilizes auth state from Better Auth's useSession().
 *
 * The key insight: we only UPDATE the stable userId when we see a valid ID,
 * and we NEVER clear it on null/undefined (which could be transient).
 */
export function StableAuthProvider({ session, children }: StableAuthProviderProps) {
  const lastKnownUserIdRef = useRef<string | null>(null)

  // Extract current user ID from session
  const currentUserId = session.data?.user?.id

  // Only update ref when we get a valid user ID - never clear it
  if (currentUserId) {
    lastKnownUserIdRef.current = currentUserId
  }

  // The stable user ID is the last known good value
  const stableUserId = lastKnownUserIdRef.current ?? undefined

  // Memoize the context value
  const value = useMemo<StableAuthState>(
    () => ({
      userId: stableUserId,
      isAuthenticated: !!stableUserId,
      rawSession: session,
    }),
    [stableUserId, session]
  )

  return (
    <StableAuthContext.Provider value={value}>
      {children}
    </StableAuthContext.Provider>
  )
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to access stable auth state.
 *
 * Use this instead of useSession() when you need a userId for data queries.
 * The userId will remain stable during Better Auth's transient refetch states.
 *
 * @throws Error if used outside StableAuthProvider
 */
export function useStableAuth(): StableAuthState {
  const context = useContext(StableAuthContext)
  if (!context) {
    throw new Error('useStableAuth must be used within StableAuthProvider')
  }
  return context
}

/**
 * Optional hook that returns undefined if outside provider (for library code).
 */
export function useOptionalStableAuth(): StableAuthState | undefined {
  return useContext(StableAuthContext) ?? undefined
}
