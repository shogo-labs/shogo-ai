/**
 * Auth Service Types
 *
 * Pure type definitions for the authentication layer.
 * NO runtime imports - interface contract only.
 */

/**
 * Credentials for email/password authentication
 */
export interface AuthCredentials {
  name?: string
  email: string
  password: string
}

/**
 * Authenticated user information
 */
export interface AuthUser {
  id: string
  email: string
  emailVerified: boolean
  createdAt: string
}

/**
 * Authentication session with tokens
 */
export interface AuthSession {
  accessToken: string
  refreshToken: string | null
  expiresAt: string
  user: AuthUser
}

/**
 * Authentication error
 */
export interface AuthError {
  code: string
  message: string
}

/**
 * Auth service interface - contract for auth providers
 *
 * Implementations:
 * - SupabaseAuthService: Real Supabase authentication
 * - MockAuthService: In-memory mock for testing
 */
export interface IAuthService {
  /**
   * Register a new user with email/password
   */
  signUp(credentials: AuthCredentials): Promise<AuthSession>

  /**
   * Sign in an existing user with email/password
   */
  signIn(credentials: AuthCredentials): Promise<AuthSession>

  /**
   * Sign out the current user
   */
  signOut(): Promise<void>

  /**
   * Get the current session, or null if not authenticated
   */
  getSession(): Promise<AuthSession | null>

  /**
   * Subscribe to auth state changes
   * @returns Unsubscribe function for cleanup
   */
  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void
}
