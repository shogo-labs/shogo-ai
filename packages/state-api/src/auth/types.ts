/**
 * Auth service interface and types
 * Task: task-auth-001
 * Requirement: req-auth-006
 */

/**
 * Represents an authenticated user
 */
export interface AuthUser {
  id: string
  email: string
  createdAt: string
}

/**
 * Represents the current auth session
 */
export interface AuthSession {
  user: AuthUser | null
  lastRefreshedAt: string
}

/**
 * Result of an auth operation (sign in, sign up)
 */
export interface AuthResult {
  user: AuthUser | null
  error: string | null
}

/**
 * Auth service interface for dependency injection
 * Implementations: SupabaseAuthService (real), MockAuthService (testing)
 */
export interface IAuthService {
  /**
   * Sign up a new user with email and password
   */
  signUp(email: string, password: string): Promise<AuthResult>

  /**
   * Sign in an existing user with email and password
   */
  signIn(email: string, password: string): Promise<AuthResult>

  /**
   * Sign out the current user
   */
  signOut(): Promise<void>

  /**
   * Get the current session, if any
   */
  getSession(): Promise<AuthSession | null>

  /**
   * Subscribe to auth state changes
   * @returns Unsubscribe function
   */
  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void
}
