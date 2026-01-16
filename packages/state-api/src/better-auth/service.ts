/**
 * BetterAuth Service Implementation
 *
 * Implements IBetterAuthService interface, wrapping BetterAuth client
 * and mapping its responses to the IAuthService contract.
 *
 * Tasks:
 * - task-ba-004: Core service implementation (signUp, signIn, signOut, getSession)
 * - task-ba-010: onAuthStateChange with nanostore subscription
 */

import type { AuthCredentials, AuthSession, AuthUser, AuthError } from "../auth/types"
import type { IBetterAuthService, BetterAuthUser, BetterAuthSession } from "./types"

/**
 * Configuration for BetterAuthService
 */
export interface BetterAuthServiceConfig {
  /** Base URL for the BetterAuth API */
  baseUrl: string
  /**
   * Optional BetterAuth client instance for nanostore subscription.
   * When provided, onAuthStateChange will use the client's useSession.subscribe()
   * for reactive session updates.
   */
  authClient?: BetterAuthClient
}

/**
 * BetterAuth client type for the useSession subscription pattern.
 * This represents the shape of the client created by better-auth/react's createAuthClient.
 */
interface BetterAuthClient {
  useSession: {
    subscribe: (callback: (value: BetterAuthSessionState) => void) => () => void
  }
}

/**
 * BetterAuth session state from the nanostore.
 * This is the structure returned by useSession.subscribe callback.
 */
interface BetterAuthSessionState {
  data: {
    session: BetterAuthSessionData | null
    user: BetterAuthUserData | null
  } | null
  isPending: boolean
  error: Error | null
}

/**
 * BetterAuth session data from nanostore (with Date objects, not strings)
 */
interface BetterAuthSessionData {
  id: string
  token: string
  userId: string
  expiresAt: Date
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * BetterAuth user data from nanostore (with Date objects, not strings)
 */
interface BetterAuthUserData {
  id: string
  email: string
  name: string
  image: string | null
  emailVerified: boolean
  createdAt: Date
  updatedAt: Date
}

/**
 * Maps BetterAuth user to AuthUser
 */
function mapUser(baUser: BetterAuthUser | BetterAuthUserData): AuthUser {
  return {
    id: baUser.id,
    email: baUser.email,
    name: baUser.name,
    image: baUser.image,
    emailVerified: baUser.emailVerified,
    createdAt:
      typeof baUser.createdAt === "string"
        ? baUser.createdAt
        : (baUser.createdAt as Date).toISOString(),
  }
}

/**
 * Maps BetterAuth session + user to AuthSession
 */
function mapSession(
  baSession: BetterAuthSession | BetterAuthSessionData,
  baUser: BetterAuthUser | BetterAuthUserData
): AuthSession {
  return {
    accessToken: baSession.token,
    refreshToken: null, // BetterAuth uses cookie-based sessions, no refresh token exposed
    expiresAt:
      typeof baSession.expiresAt === "string"
        ? baSession.expiresAt
        : (baSession.expiresAt as Date).toISOString(),
    user: mapUser(baUser),
  }
}

/**
 * Maps HTTP status codes to AuthError codes
 */
function mapErrorCode(status: number, message: string): string {
  if (status === 401) {
    return "invalid_credentials"
  }
  if (status === 400 && message.toLowerCase().includes("exists")) {
    return "email_exists"
  }
  return "unknown_error"
}

/**
 * BetterAuth Service - implements IBetterAuthService
 *
 * Wraps BetterAuth API calls and maps to the IAuthService contract.
 * Supports both direct fetch-based API calls and reactive nanostore
 * subscriptions via the optional authClient parameter.
 */
export class BetterAuthService implements IBetterAuthService {
  private readonly baseUrl: string
  private readonly _authClient?: BetterAuthClient
  private readonly callbacks: Set<(session: AuthSession | null) => void> = new Set()

  constructor(config: BetterAuthServiceConfig) {
    this.baseUrl = config.baseUrl
    this._authClient = config.authClient
  }

  /**
   * Register a new user with email/password
   */
  async signUp(credentials: AuthCredentials): Promise<AuthSession> {
    const response = await fetch(`${this.baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: credentials.name,
        email: credentials.email,
        password: credentials.password,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      const authError: AuthError = {
        code: mapErrorCode(response.status, error.message || ""),
        message: error.message || "Sign up failed",
      }
      throw authError
    }

    const data = await response.json()
    // BetterAuth sign-up returns { token, user } directly (not nested in session)
    const session = data.session || { token: data.token, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() }
    return mapSession(session, data.user)
  }

  /**
   * Sign in an existing user with email/password
   */
  async signIn(credentials: AuthCredentials): Promise<AuthSession> {
    const response = await fetch(`${this.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      const authError: AuthError = {
        code: mapErrorCode(response.status, error.message || ""),
        message: error.message || "Sign in failed",
      }
      throw authError
    }

    const data = await response.json()
    // BetterAuth sign-in returns { token, user } directly (not nested in session)
    const session = data.session || { token: data.token, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() }
    return mapSession(session, data.user)
  }

  /**
   * Sign out the current user
   */
  async signOut(): Promise<void> {
    await fetch(`${this.baseUrl}/api/auth/sign-out`, {
      method: "POST",
      credentials: "include",
    })
  }

  /**
   * Get the current session, or null if not authenticated
   */
  async getSession(): Promise<AuthSession | null> {
    const response = await fetch(`${this.baseUrl}/api/auth/get-session`, {
      method: "GET",
      credentials: "include",
    })

    if (!response.ok) {
      return null
    }

    const data = await response.json()

    // Handle null response or missing session/user
    if (!data || !data.session || !data.user) {
      return null
    }

    return mapSession(data.session, data.user)
  }

  /**
   * Subscribe to auth state changes.
   *
   * When authClient is provided, uses the nanostore subscription pattern
   * from better-auth/react. The nanostore details are fully encapsulated.
   *
   * @returns Unsubscribe function for cleanup
   */
  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void {
    // If authClient is provided, use nanostore subscription
    if (this._authClient) {
      const unsubscribe = this._authClient.useSession.subscribe((state) => {
        // Skip callback during loading/pending state
        if (state.isPending) {
          return
        }

        // Map BA session state to AuthSession or null
        if (!state.data || !state.data.session || !state.data.user) {
          callback(null)
        } else {
          const authSession = mapSession(state.data.session, state.data.user)
          callback(authSession)
        }
      })

      return unsubscribe
    }

    // Fallback: store callback for manual notification (for testing without authClient)
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  /**
   * Initiate Google OAuth sign-in flow
   *
   * In browser environments, redirects to the OAuth URL.
   * In other environments, this is a no-op.
   */
  async signInWithGoogle(): Promise<void> {
    const url = this.getGoogleSignInUrl()

    // Only redirect in browser environment
    if (typeof window !== "undefined" && window.location) {
      window.location.href = url
    }
  }

  /**
   * Get the Google OAuth sign-in URL
   */
  getGoogleSignInUrl(): string {
    return `${this.baseUrl}/api/auth/sign-in/social?provider=google`
  }
}
