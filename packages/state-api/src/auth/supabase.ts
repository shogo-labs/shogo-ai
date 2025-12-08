/**
 * Supabase Auth Service
 *
 * Production implementation of IAuthService using Supabase Auth.
 * Wraps Supabase client methods and maps responses to IAuthService types.
 */

import type {
  IAuthService,
  AuthCredentials,
  AuthUser,
  AuthSession,
  AuthError,
} from "./types"

// Supabase client type (minimal interface we depend on)
// This avoids requiring @supabase/supabase-js as a direct dependency
interface SupabaseAuthClient {
  signUp(credentials: { email: string; password: string }): Promise<{
    data: { session: SupabaseSession | null; user: SupabaseUser | null }
    error: SupabaseError | null
  }>
  signInWithPassword(credentials: { email: string; password: string }): Promise<{
    data: { session: SupabaseSession | null; user: SupabaseUser | null }
    error: SupabaseError | null
  }>
  signOut(): Promise<{ error: SupabaseError | null }>
  getSession(): Promise<{
    data: { session: SupabaseSession | null }
    error: SupabaseError | null
  }>
  onAuthStateChange(
    callback: (event: string, session: SupabaseSession | null) => void
  ): { data: { subscription: { unsubscribe: () => void } } }
}

interface SupabaseUser {
  id: string
  email?: string
  email_confirmed_at?: string | null
  created_at?: string
}

interface SupabaseSession {
  access_token: string
  refresh_token?: string
  expires_at?: number
  user: SupabaseUser
}

interface SupabaseError {
  message: string
  status?: number
}

interface SupabaseClient {
  auth: SupabaseAuthClient
}

/**
 * Map Supabase user to IAuthService AuthUser
 */
function mapSupabaseUser(user: SupabaseUser): AuthUser {
  return {
    id: user.id,
    email: user.email ?? "",
    emailVerified: !!user.email_confirmed_at,
    createdAt: user.created_at ?? new Date().toISOString(),
  }
}

/**
 * Map Supabase session to IAuthService AuthSession
 */
function mapSupabaseSession(session: SupabaseSession): AuthSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token ?? null,
    expiresAt: session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : new Date(Date.now() + 3600000).toISOString(),
    user: mapSupabaseUser(session.user),
  }
}

/**
 * Map Supabase error to IAuthService AuthError
 */
function mapSupabaseError(error: SupabaseError): AuthError {
  // Map common Supabase error messages to error codes
  let code = "unknown_error"

  if (error.message.toLowerCase().includes("invalid login credentials")) {
    code = "invalid_credentials"
  } else if (error.message.toLowerCase().includes("already registered")) {
    code = "email_exists"
  } else if (error.message.toLowerCase().includes("email not confirmed")) {
    code = "email_not_verified"
  } else if (error.status === 400) {
    code = "bad_request"
  } else if (error.status === 401) {
    code = "unauthorized"
  } else if (error.status === 422) {
    code = "validation_error"
  }

  return {
    code,
    message: error.message,
  }
}

/**
 * Supabase implementation of IAuthService.
 *
 * Usage:
 * ```typescript
 * import { createClient } from '@supabase/supabase-js'
 *
 * const supabase = createClient(url, key)
 * const authService = new SupabaseAuthService(supabase)
 * ```
 */
export class SupabaseAuthService implements IAuthService {
  private client: SupabaseClient

  constructor(client: SupabaseClient) {
    this.client = client
  }

  async signUp(credentials: AuthCredentials): Promise<AuthSession> {
    const { data, error } = await this.client.auth.signUp({
      email: credentials.email,
      password: credentials.password,
    })

    if (error) {
      throw mapSupabaseError(error)
    }

    if (!data.session) {
      // Supabase may return null session if email confirmation is required
      // In that case, we still have the user but no active session
      if (data.user) {
        // Create a temporary session-like response
        // The user will need to verify email before full session
        return {
          accessToken: "",
          refreshToken: null,
          expiresAt: new Date().toISOString(),
          user: mapSupabaseUser(data.user),
        }
      }
      throw { code: "no_session", message: "Sign up succeeded but no session returned" } as AuthError
    }

    return mapSupabaseSession(data.session)
  }

  async signIn(credentials: AuthCredentials): Promise<AuthSession> {
    const { data, error } = await this.client.auth.signInWithPassword({
      email: credentials.email,
      password: credentials.password,
    })

    if (error) {
      throw mapSupabaseError(error)
    }

    if (!data.session) {
      throw { code: "no_session", message: "Sign in succeeded but no session returned" } as AuthError
    }

    return mapSupabaseSession(data.session)
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut()

    if (error) {
      throw mapSupabaseError(error)
    }
  }

  async getSession(): Promise<AuthSession | null> {
    const { data, error } = await this.client.auth.getSession()

    if (error) {
      throw mapSupabaseError(error)
    }

    if (!data.session) {
      return null
    }

    return mapSupabaseSession(data.session)
  }

  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      if (session) {
        callback(mapSupabaseSession(session))
      } else {
        callback(null)
      }
    })

    return () => {
      data.subscription.unsubscribe()
    }
  }
}
