/**
 * AuthContext - React context for authentication state
 * Task: task-auth-008
 * Requirement: req-auth-005
 *
 * Provides:
 * - Supabase client instance (stable via useRef)
 * - Auth store with MST reactivity
 * - Auto-initializes auth on mount
 * - Cleans up auth state listener on unmount
 */

import {
  createContext,
  useContext,
  useRef,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import {
  SupabaseAuthService,
  createAuthStore,
  NullPersistence,
  type IAuthService,
  type IEnvironment,
} from "@shogo/state-api"

// Type for the auth store instance
type AuthStore = ReturnType<typeof createAuthStore>

// Context for the auth store
const AuthStoreContext = createContext<AuthStore | null>(null)

export interface AuthProviderProps {
  children: ReactNode
  /** Optional: Override auth service for testing */
  authService?: IAuthService
  /** Optional: Override Supabase client for testing */
  supabaseClient?: SupabaseClient
}

/**
 * AuthProvider component
 *
 * Creates and manages the auth store lifecycle:
 * 1. Creates Supabase client from env vars (stable via useRef)
 * 2. Creates auth store with SupabaseAuthService
 * 3. Initializes auth on mount (restores session)
 * 4. Sets up auth state change listener
 * 5. Cleans up listener on unmount
 */
export function AuthProvider({
  children,
  authService: providedAuthService,
  supabaseClient: providedClient,
}: AuthProviderProps) {
  // Track initialization state
  const [isInitializing, setIsInitializing] = useState(true)

  // Stable Supabase client reference
  const clientRef = useRef<SupabaseClient | null>(null)
  if (!clientRef.current && !providedClient) {
    const url = import.meta.env.VITE_SUPABASE_URL
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY

    if (!url || !key) {
      console.warn(
        "[AuthProvider] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY"
      )
    } else {
      clientRef.current = createClient(url, key)
    }
  }

  const client = providedClient ?? clientRef.current

  // Stable auth service reference
  const authServiceRef = useRef<IAuthService | null>(null)
  if (!authServiceRef.current) {
    if (providedAuthService) {
      authServiceRef.current = providedAuthService
    } else if (client) {
      authServiceRef.current = new SupabaseAuthService(client)
    }
  }

  // Stable auth store reference
  const storeRef = useRef<AuthStore | null>(null)
  if (!storeRef.current && authServiceRef.current) {
    const env: IEnvironment = {
      services: {
        persistence: new NullPersistence(),
        auth: authServiceRef.current,
      },
      context: {
        schemaName: "auth",
      },
    }
    storeRef.current = createAuthStore(env)
  }

  // Initialize auth and set up listener on mount
  useEffect(() => {
    const store = storeRef.current
    const authService = authServiceRef.current

    if (!store || !authService) {
      setIsInitializing(false)
      return
    }

    // Initialize auth (restore session)
    store.initializeAuth().finally(() => {
      setIsInitializing(false)
    })

    // Set up auth state change listener
    const unsubscribe = authService.onAuthStateChange((session) => {
      store.syncAuthState(session)
    })

    // Cleanup on unmount
    return () => {
      unsubscribe()
    }
  }, [])

  // If no auth service, render children without context
  // This allows the app to work without auth configured
  if (!storeRef.current) {
    console.warn("[AuthProvider] No auth service configured")
    return <>{children}</>
  }

  // During initialization, render children but with loading state
  // This allows SSR to work while client-side hydration completes init

  return (
    <AuthStoreContext.Provider value={storeRef.current}>
      {children}
    </AuthStoreContext.Provider>
  )
}

/**
 * Hook to access the auth store
 *
 * Must be used within AuthProvider.
 * Returns the MST store with collections and actions.
 */
export function useAuthStore(): AuthStore {
  const store = useContext(AuthStoreContext)
  if (!store) {
    throw new Error("useAuthStore must be used within AuthProvider")
  }
  return store
}
