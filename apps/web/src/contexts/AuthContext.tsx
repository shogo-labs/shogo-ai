/**
 * AuthContext - React context for auth store
 *
 * Provides an auth store with IAuthService integration.
 * The store syncs with auth service state changes and provides
 * reactive views and actions for auth flows.
 *
 * IMPORTANT: This provider receives session data from SessionProvider.
 * It does NOT make its own /api/auth/get-session calls to avoid duplicates.
 * See: https://github.com/better-auth/better-auth/issues/duplicate-calls
 *
 * Usage:
 * ```tsx
 * import { createClient } from '@supabase/supabase-js'
 * import { SupabaseAuthService } from '@shogo/state-api'
 *
 * const supabase = createClient(url, key)
 * const authService = new SupabaseAuthService(supabase)
 *
 * <SessionProvider>
 *   <AuthProvider authService={authService}>
 *     <MyApp />
 *   </AuthProvider>
 * </SessionProvider>
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
import { useSessionContext } from "./SessionProvider"

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
 * - Syncs session data from SessionProvider (no duplicate API calls)
 * - Subscribes to auth service state changes for cross-tab sync
 * - Cleans up subscription on unmount
 *
 * OPTIMIZATION: This provider no longer calls store.initialize() which made
 * a redundant /api/auth/get-session call. Instead, it syncs session data
 * from SessionProvider which already has the session from Better Auth's useSession.
 */
export function AuthProvider({ authService, children }: AuthProviderProps) {
  const contextRef = useRef<AuthContextValue | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  
  // Get session data from SessionProvider (already fetched, no new API call)
  const sessionContext = useSessionContext()

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

  // Sync session data from SessionProvider to the auth store
  // This replaces the redundant store.initialize() call that was making duplicate API requests
  useEffect(() => {
    const store = contextRef.current?.store
    if (!store || sessionContext.isPending) return

    if (sessionContext.data?.user && sessionContext.data?.session) {
      // Map SessionProvider data to AuthSession format
      const authSession: AuthSession = {
        accessToken: sessionContext.data.session.token,
        refreshToken: null,
        expiresAt: sessionContext.data.session.expiresAt instanceof Date 
          ? sessionContext.data.session.expiresAt.toISOString()
          : String(sessionContext.data.session.expiresAt),
        user: {
          id: sessionContext.data.user.id,
          email: sessionContext.data.user.email,
          name: sessionContext.data.user.name ?? undefined,
          image: sessionContext.data.user.image ?? undefined,
          emailVerified: sessionContext.data.user.emailVerified,
          createdAt: sessionContext.data.user.createdAt instanceof Date
            ? sessionContext.data.user.createdAt.toISOString()
            : String(sessionContext.data.user.createdAt),
        },
      }
      
      // Sync to store if not already there or if session changed
      if (!store.isAuthenticated || store.currentSession?.accessToken !== authSession.accessToken) {
        store.syncFromServiceSession(authSession)
        store.setAuthStatus("idle")
      }
    } else if (!sessionContext.data && store.isAuthenticated) {
      // User logged out
      store.clearAuthState()
    }
  }, [sessionContext.data, sessionContext.isPending])

  // Subscribe to auth state changes for cross-tab sync only
  // This subscription handles events like logout in another tab
  useEffect(() => {
    const store = contextRef.current?.store
    if (!store) return

    // Subscribe to external auth state changes (e.g., from other tabs)
    unsubscribeRef.current = authService.onAuthStateChange(async (session: AuthSession | null) => {
      if (session) {
        // Sync session to store if not already there
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

    // NOTE: We intentionally do NOT call store.initialize() here anymore.
    // Session data comes from SessionProvider which already called Better Auth's useSession.
    // This eliminates duplicate /api/auth/get-session calls.

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
