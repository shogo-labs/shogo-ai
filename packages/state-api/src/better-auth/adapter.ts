/**
 * BetterAuth Adapter
 * 
 * Lightweight adapter between BetterAuth and our app.
 * Instead of syncing full auth entities to MST, we just expose
 * what the app needs: user identity and auth status.
 * 
 * BetterAuth handles:
 * - Session storage (cookies)
 * - Token refresh
 * - User/Session/Account database records
 * 
 * Our app uses:
 * - userId: for API calls and data filtering
 * - user metadata: for display (name, email, image)
 * - isAuthenticated: for routing/UI decisions
 */

export interface AuthUser {
  id: string
  email: string
  name?: string
  image?: string | null
  emailVerified: boolean
}

export interface AuthState {
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
}

/**
 * Maps BetterAuth session response to our app's AuthUser format
 */
export function mapBetterAuthUser(betterAuthUser: any): AuthUser | null {
  if (!betterAuthUser) return null
  
  return {
    id: betterAuthUser.id,
    email: betterAuthUser.email,
    name: betterAuthUser.name ?? undefined,
    image: betterAuthUser.image ?? null,
    emailVerified: betterAuthUser.emailVerified ?? false,
  }
}

/**
 * Maps BetterAuth session to our AuthState
 */
export function mapBetterAuthSession(session: any): AuthState {
  if (!session?.user) {
    return {
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    }
  }

  return {
    user: mapBetterAuthUser(session.user),
    isAuthenticated: true,
    isLoading: false,
    error: null,
  }
}

/**
 * Creates initial loading state
 */
export function createLoadingState(): AuthState {
  return {
    user: null,
    isAuthenticated: false,
    isLoading: true,
    error: null,
  }
}

/**
 * Creates error state
 */
export function createErrorState(error: string): AuthState {
  return {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error,
  }
}
