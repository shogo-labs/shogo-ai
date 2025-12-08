/**
 * AuthContext - React context for auth store
 *
 * Provides an auth store with IAuthService integration.
 * The store syncs with auth service state changes and provides
 * reactive views and actions for auth flows.
 *
 * Usage:
 * ```tsx
 * import { createClient } from '@supabase/supabase-js'
 * import { SupabaseAuthService } from '@shogo/state-api'
 *
 * const supabase = createClient(url, key)
 * const authService = new SupabaseAuthService(supabase)
 *
 * <AuthProvider authService={authService}>
 *   <MyApp />
 * </AuthProvider>
 *
 * function MyApp() {
 *   const auth = useAuth()
 *
 *   if (auth.isAuthenticated) {
 *     return <div>Welcome, {auth.currentUser.email}</div>
 *   }
 *
 *   return <button onClick={() => auth.signIn({ email, password })}>Sign In</button>
 * }
 * ```
 */

import { createContext, useContext, useRef, useEffect, type ReactNode } from "react"
import {
  createAuthStore,
  NullPersistence,
  type IAuthService,
  type AuthSession,
} from "@shogo/state-api"

interface AuthContextValue {
  store: any
}

const AuthContext = createContext<AuthContextValue | null>(null)

export interface AuthProviderProps {
  /** Auth service for handling auth operations */
  authService: IAuthService
  children: ReactNode
}

/**
 * Provider that creates an auth store connected to the given auth service.
 *
 * Features:
 * - Creates stable store instance (useRef)
 * - Subscribes to auth service state changes
 * - Syncs external auth events to store state
 * - Cleans up subscription on unmount
 */
export function AuthProvider({ authService, children }: AuthProviderProps) {
  const contextRef = useRef<AuthContextValue | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  // Initialize store once
  if (!contextRef.current) {
    const env = {
      services: {
        persistence: new NullPersistence(),
        auth: authService,
      },
      context: {
        schemaName: "auth",
      },
    }

    const result = createAuthStore()
    const store = result.createStore(env)

    contextRef.current = { store }
  }

  // Subscribe to auth state changes
  useEffect(() => {
    const store = contextRef.current?.store
    if (!store) return

    // Subscribe to external auth state changes (e.g., from other tabs)
    unsubscribeRef.current = authService.onAuthStateChange(async (session: AuthSession | null) => {
      if (session) {
        // Sync session to store if not already there
        // The store's syncFromServiceSession handles this
        if (!store.isAuthenticated || store.currentSession?.accessToken !== session.accessToken) {
          store.syncFromServiceSession(session)
        }
      } else {
        // Clear store on sign out
        if (store.isAuthenticated) {
          store.clearAuthState()
        }
      }
    })

    // Initialize store with current session
    store.initialize()

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [authService])

  return (
    <AuthContext.Provider value={contextRef.current}>
      {children}
    </AuthContext.Provider>
  )
}

/**
 * Hook to access the auth store.
 *
 * The auth store provides:
 * - Views: isAuthenticated, currentUser, currentSession, authStatus, authError
 * - Actions: signUp(credentials), signIn(credentials), signOut()
 *
 * Use with observer() from mobx-react-lite for reactive updates:
 * ```tsx
 * import { observer } from 'mobx-react-lite'
 *
 * const MyComponent = observer(() => {
 *   const auth = useAuth()
 *   return <div>{auth.isAuthenticated ? 'Yes' : 'No'}</div>
 * })
 * ```
 *
 * @returns The auth store instance
 * @throws Error if used outside AuthProvider
 */
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider")
  }
  return context.store
}
