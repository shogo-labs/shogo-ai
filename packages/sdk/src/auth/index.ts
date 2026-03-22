// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Auth Module
 *
 * Handles authentication flows, token management, and auth state.
 */

import { AuthError } from '../errors.js'
import type { HttpClient } from '../http/client.js'
import type {
  StorageAdapter,
  ShogoUser,
  ShogoSession,
  AuthState,
  AuthStateChangeCallback,
  SignUpData,
  SignInData,
  AuthProvider,
  AuthTokens,
  ShogoAuthConfig,
} from '../types.js'

const STORAGE_KEY_TOKENS = 'auth_tokens'
const STORAGE_KEY_USER = 'auth_user'

export class ShogoAuth {
  private httpClient: HttpClient
  private storage: StorageAdapter
  private config: ShogoAuthConfig
  private state: AuthState = {
    user: null,
    session: null,
    isAuthenticated: false,
    isLoading: true,
  }
  private listeners: Set<AuthStateChangeCallback> = new Set()
  private initPromise: Promise<void> | null = null

  constructor(
    httpClient: HttpClient,
    storage: StorageAdapter,
    config: ShogoAuthConfig = {}
  ) {
    this.httpClient = httpClient
    this.storage = storage
    this.config = config

    // Initialize auth state from storage
    this.initPromise = this.initialize()
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Initialize auth state from storage
   */
  private async initialize(): Promise<void> {
    try {
      const tokensStr = await this.storage.getItem(STORAGE_KEY_TOKENS)
      const userStr = await this.storage.getItem(STORAGE_KEY_USER)

      if (tokensStr && userStr) {
        const tokens: AuthTokens = JSON.parse(tokensStr)
        const user: ShogoUser = JSON.parse(userStr)

        // Check if token is expired
        if (tokens.expiresAt && Date.now() > tokens.expiresAt) {
          // Token expired, try to refresh or clear
          await this.clearAuth()
        } else {
          this.updateState({
            user,
            session: { user, token: tokens.accessToken },
            isAuthenticated: true,
            isLoading: false,
          })
          return
        }
      }
    } catch {
      // Storage read failed, start fresh
    }

    this.updateState({
      user: null,
      session: null,
      isAuthenticated: false,
      isLoading: false,
    })
  }

  /**
   * Wait for auth initialization to complete
   */
  async ready(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise
    }
  }

  // ==========================================================================
  // State Management
  // ==========================================================================

  /**
   * Get current auth state
   */
  getState(): AuthState {
    return { ...this.state }
  }

  /**
   * Get current user (sync, may be null if loading)
   */
  currentUser(): ShogoUser | null {
    return this.state.user
  }

  /**
   * Get current session
   */
  async getSession(): Promise<ShogoSession | null> {
    await this.ready()
    return this.state.session
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return this.state.isAuthenticated
  }

  /**
   * Get current access token
   */
  getToken(): string | null {
    return this.state.session?.token ?? null
  }

  /**
   * Subscribe to auth state changes
   */
  onAuthStateChanged(callback: AuthStateChangeCallback): () => void {
    this.listeners.add(callback)

    // Immediately call with current state
    callback(this.getState())

    // Return unsubscribe function
    return () => {
      this.listeners.delete(callback)
    }
  }

  /**
   * Update auth state and notify listeners
   */
  private updateState(newState: Partial<AuthState>): void {
    this.state = { ...this.state, ...newState }
    this.notifyListeners()
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    const state = this.getState()
    this.listeners.forEach(callback => {
      try {
        callback(state)
      } catch {
        // Ignore listener errors
      }
    })
  }

  // ==========================================================================
  // Token Management
  // ==========================================================================

  /**
   * Save tokens to storage
   */
  private async saveTokens(tokens: AuthTokens): Promise<void> {
    // Calculate expiration time
    const expiresAt = tokens.expiresIn
      ? Date.now() + tokens.expiresIn * 1000
      : undefined

    const tokensWithExpiry: AuthTokens = {
      ...tokens,
      expiresAt,
    }

    await this.storage.setItem(STORAGE_KEY_TOKENS, JSON.stringify(tokensWithExpiry))
  }

  /**
   * Save user to storage
   */
  private async saveUser(user: ShogoUser): Promise<void> {
    await this.storage.setItem(STORAGE_KEY_USER, JSON.stringify(user))
  }

  /**
   * Clear auth from storage
   */
  private async clearAuth(): Promise<void> {
    await this.storage.removeItem(STORAGE_KEY_TOKENS)
    await this.storage.removeItem(STORAGE_KEY_USER)
    this.httpClient.resetMcpSession()
  }

  /**
   * Set auth session from tokens (for manual token injection)
   */
  async setSession(tokens: AuthTokens, user?: ShogoUser): Promise<ShogoUser> {
    await this.saveTokens(tokens)

    // Fetch user if not provided
    const currentUser = user ?? await this.fetchCurrentUser(tokens.accessToken)
    await this.saveUser(currentUser)

    this.updateState({
      user: currentUser,
      session: { user: currentUser, token: tokens.accessToken },
      isAuthenticated: true,
      isLoading: false,
    })

    return currentUser
  }

  // ==========================================================================
  // Auth Flows
  // ==========================================================================

  /**
   * Sign up with email and password
   */
  async signUp(data: SignUpData): Promise<ShogoUser> {
    this.updateState({ isLoading: true })

    try {
      const response = await this.httpClient.authRequest<{
        user: ShogoUser
        token: string
        expiresIn?: number
      }>('/sign-up/email', {
        method: 'POST',
        body: {
          email: data.email,
          password: data.password,
          name: data.name,
          ...data.metadata,
        },
      })

      const { user, token, expiresIn } = response.data

      await this.saveTokens({
        accessToken: token,
        expiresIn,
      })
      await this.saveUser(user)

      this.updateState({
        user,
        session: { user, token },
        isAuthenticated: true,
        isLoading: false,
      })

      return user
    } catch (error) {
      this.updateState({ isLoading: false })

      if (error instanceof AuthError) {
        throw error
      }
      throw new AuthError(
        error instanceof Error ? error.message : 'Sign up failed',
        'UNKNOWN'
      )
    }
  }

  /**
   * Sign in with email and password
   */
  async signIn(data: SignInData): Promise<ShogoUser> {
    this.updateState({ isLoading: true })

    try {
      const response = await this.httpClient.authRequest<{
        user: ShogoUser
        token: string
        expiresIn?: number
      }>('/sign-in/email', {
        method: 'POST',
        body: {
          email: data.email,
          password: data.password,
        },
      })

      const { user, token, expiresIn } = response.data

      await this.saveTokens({
        accessToken: token,
        expiresIn,
      })
      await this.saveUser(user)

      this.updateState({
        user,
        session: { user, token },
        isAuthenticated: true,
        isLoading: false,
      })

      return user
    } catch (error) {
      this.updateState({ isLoading: false })

      if (error instanceof AuthError) {
        throw error
      }
      throw AuthError.invalidCredentials()
    }
  }

  /**
   * Sign in with OAuth provider
   */
  async signInWithProvider(provider: AuthProvider): Promise<void> {
    // For OAuth, we redirect to the provider
    const redirectUrl = this.config.redirectUrl ?? window?.location?.href

    const authUrl = new URL(
      this.httpClient.getAuthUrl(`/sign-in/${provider}`),
      window?.location?.origin
    )
    authUrl.searchParams.set('callbackURL', redirectUrl ?? '/')

    // Redirect to auth URL
    if (typeof window !== 'undefined') {
      window.location.href = authUrl.toString()
    }
  }

  /**
   * Sign in with Google
   */
  async signInWithGoogle(): Promise<void> {
    return this.signInWithProvider('google')
  }

  /**
   * Sign in with GitHub
   */
  async signInWithGitHub(): Promise<void> {
    return this.signInWithProvider('github')
  }

  /**
   * Sign in with Apple
   */
  async signInWithApple(): Promise<void> {
    return this.signInWithProvider('apple')
  }

  /**
   * Sign in with Microsoft
   */
  async signInWithMicrosoft(): Promise<void> {
    return this.signInWithProvider('microsoft')
  }

  /**
   * Sign out
   */
  async signOut(): Promise<void> {
    this.updateState({ isLoading: true })

    try {
      // Call server sign out
      await this.httpClient.authRequest('/sign-out', {
        method: 'POST',
      }).catch(() => {
        // Ignore server errors, still clear local state
      })
    } finally {
      await this.clearAuth()
      this.updateState({
        user: null,
        session: null,
        isAuthenticated: false,
        isLoading: false,
      })
    }
  }

  // ==========================================================================
  // User Operations
  // ==========================================================================

  /**
   * Fetch current user from server
   */
  private async fetchCurrentUser(token?: string): Promise<ShogoUser> {
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await this.httpClient.authRequest<{ user: ShogoUser }>(
      '/session',
      { headers }
    )

    return response.data.user
  }

  /**
   * Get current user (async, fetches from server)
   */
  async me(): Promise<ShogoUser> {
    await this.ready()

    if (!this.state.isAuthenticated) {
      throw AuthError.invalidToken()
    }

    return this.fetchCurrentUser()
  }

  /**
   * Update current user profile
   */
  async updateProfile(updates: Partial<ShogoUser>): Promise<ShogoUser> {
    if (!this.state.isAuthenticated) {
      throw AuthError.invalidToken()
    }

    const response = await this.httpClient.authRequest<{ user: ShogoUser }>(
      '/update-user',
      {
        method: 'POST',
        body: updates,
      }
    )

    const user = response.data.user
    await this.saveUser(user)

    this.updateState({
      user,
      session: this.state.session
        ? { ...this.state.session, user }
        : null,
    })

    return user
  }
}
