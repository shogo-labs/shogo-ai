/**
 * useAuth hook for authentication operations
 * Task: task-auth-009
 * Requirement: req-auth-007
 *
 * Provides a convenient API for auth operations:
 * - Current user and authentication state from MST store
 * - Sign in, sign up, sign out methods with loading/error handling
 * - MobX reactivity via observer pattern
 */

import { useState, useCallback, useMemo } from "react"
import { getEnv } from "mobx-state-tree"
import { useAuthStore } from "../contexts/AuthContext"
import type { AuthUser, IAuthService, IEnvironment } from "@shogo/state-api"

export interface UseAuthResult {
  /** Current authenticated user or null */
  user: AuthUser | null
  /** Whether user is authenticated */
  isAuthenticated: boolean
  /** Whether an auth operation is in progress */
  loading: boolean
  /** Error message from last operation, or null */
  error: string | null
  /** Sign in with email and password */
  signIn: (email: string, password: string) => Promise<void>
  /** Sign up with email and password */
  signUp: (email: string, password: string) => Promise<void>
  /** Sign out current user */
  signOut: () => Promise<void>
  /** Clear error state */
  clearError: () => void
}

/**
 * Hook for authentication operations
 *
 * Must be used within AuthProvider.
 * Returns reactive state and async methods for auth operations.
 */
export function useAuth(): UseAuthResult {
  const store = useAuthStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Get auth service from MST environment
  const authService = useMemo(() => {
    try {
      const env = getEnv<IEnvironment>(store)
      return env.services.auth
    } catch {
      return null
    }
  }, [store])

  // Get current session
  const session = store.authSessionCollection.get("current")

  // Derive user and isAuthenticated from store state
  const user = session?.user ?? null
  const isAuthenticated = session?.isAuthenticated ?? false

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!authService) {
        setError("Auth service not configured")
        return
      }

      setLoading(true)
      setError(null)

      try {
        const result = await authService.signIn(email, password)
        if (result.error) {
          setError(result.error)
        }
        // On success, onAuthStateChange will update the store
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign in failed")
      } finally {
        setLoading(false)
      }
    },
    [authService]
  )

  const signUp = useCallback(
    async (email: string, password: string) => {
      if (!authService) {
        setError("Auth service not configured")
        return
      }

      setLoading(true)
      setError(null)

      try {
        const result = await authService.signUp(email, password)
        if (result.error) {
          setError(result.error)
        }
        // On success, onAuthStateChange will update the store
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign up failed")
      } finally {
        setLoading(false)
      }
    },
    [authService]
  )

  const signOut = useCallback(async () => {
    if (!authService) {
      setError("Auth service not configured")
      return
    }

    setLoading(true)
    setError(null)

    try {
      await authService.signOut()
      // onAuthStateChange will update the store
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign out failed")
    } finally {
      setLoading(false)
    }
  }, [authService])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    user,
    isAuthenticated,
    loading,
    error,
    signIn,
    signUp,
    signOut,
    clearError,
  }
}
