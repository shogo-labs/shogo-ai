/**
 * Supabase auth service implementation
 * Task: task-auth-002
 * Requirement: req-auth-001
 */

import type { IAuthService, AuthUser, AuthSession, AuthResult } from "./types"

/**
 * Minimal Supabase client interface for auth operations
 * This allows us to accept the real @supabase/supabase-js client without
 * adding it as a direct dependency to state-api
 */
export interface SupabaseAuthClient {
  auth: {
    signUp(credentials: {
      email: string
      password: string
    }): Promise<{
      data: { user: { id: string; email?: string; created_at: string } | null }
      error: { message: string } | null
    }>
    signInWithPassword(credentials: {
      email: string
      password: string
    }): Promise<{
      data: { user: { id: string; email?: string; created_at: string } | null }
      error: { message: string } | null
    }>
    signOut(): Promise<{ error: { message: string } | null }>
    getSession(): Promise<{
      data: {
        session: {
          user: { id: string; email?: string; created_at: string }
        } | null
      }
      error: { message: string } | null
    }>
    onAuthStateChange(
      callback: (
        event: string,
        session: { user: { id: string; email?: string; created_at: string } } | null
      ) => void
    ): { data: { subscription: { unsubscribe: () => void } } }
  }
}

/**
 * Supabase implementation of IAuthService
 * Wraps the Supabase client for use with MST environment DI
 */
export class SupabaseAuthService implements IAuthService {
  constructor(private client: SupabaseAuthClient) {}

  async signUp(email: string, password: string): Promise<AuthResult> {
    const { data, error } = await this.client.auth.signUp({ email, password })

    if (error) {
      return { user: null, error: error.message }
    }

    if (!data.user) {
      return { user: null, error: "Sign up failed" }
    }

    return {
      user: this.mapUser(data.user),
      error: null,
    }
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    const { data, error } = await this.client.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      return { user: null, error: error.message }
    }

    if (!data.user) {
      return { user: null, error: "Sign in failed" }
    }

    return {
      user: this.mapUser(data.user),
      error: null,
    }
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut()
    if (error) {
      throw new Error(error.message)
    }
  }

  async getSession(): Promise<AuthSession | null> {
    const { data, error } = await this.client.auth.getSession()

    if (error || !data.session) {
      return null
    }

    return {
      user: this.mapUser(data.session.user),
      lastRefreshedAt: new Date().toISOString(),
    }
  }

  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      if (session) {
        callback({
          user: this.mapUser(session.user),
          lastRefreshedAt: new Date().toISOString(),
        })
      } else {
        callback(null)
      }
    })

    return () => {
      data.subscription.unsubscribe()
    }
  }

  private mapUser(supabaseUser: {
    id: string
    email?: string
    created_at: string
  }): AuthUser {
    return {
      id: supabaseUser.id,
      email: supabaseUser.email ?? "",
      createdAt: supabaseUser.created_at,
    }
  }
}
