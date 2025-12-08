/**
 * Mock Auth Service
 *
 * In-memory implementation of IAuthService for testing.
 * Stores users in a Map, generates fake tokens, and supports
 * configurable delays for async testing scenarios.
 */

import type {
  IAuthService,
  AuthCredentials,
  AuthUser,
  AuthSession,
  AuthError,
} from "./types"

export interface MockAuthServiceOptions {
  /** Delay in milliseconds for async operations (default: 0) */
  delay?: number
}

/**
 * In-memory mock implementation of IAuthService.
 *
 * Features:
 * - Stores users in Map<email, { user, password }>
 * - Generates fake tokens for sessions
 * - Notifies subscribers on auth state changes
 * - clear() method for test isolation
 * - Configurable delays for async testing
 */
export class MockAuthService implements IAuthService {
  private users = new Map<string, { user: AuthUser; password: string }>()
  private currentSession: AuthSession | null = null
  private subscribers = new Set<(session: AuthSession | null) => void>()
  private delay: number

  constructor(options: MockAuthServiceOptions = {}) {
    this.delay = options.delay ?? 0
  }

  private async wait(): Promise<void> {
    if (this.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delay))
    }
  }

  private generateToken(): string {
    return `mock-token-${Date.now()}-${Math.random().toString(36).substring(2)}`
  }

  private generateId(): string {
    return crypto.randomUUID()
  }

  private notifySubscribers(): void {
    for (const callback of this.subscribers) {
      callback(this.currentSession)
    }
  }

  async signUp(credentials: AuthCredentials): Promise<AuthSession> {
    await this.wait()

    const { email, password } = credentials

    // Check for existing user
    if (this.users.has(email)) {
      const error: AuthError = {
        code: "email_exists",
        message: `User with email ${email} already exists`,
      }
      throw error
    }

    // Create user
    const user: AuthUser = {
      id: this.generateId(),
      email,
      emailVerified: false,
      createdAt: new Date().toISOString(),
    }

    // Store user with password
    this.users.set(email, { user, password })

    // Create session
    const session: AuthSession = {
      accessToken: this.generateToken(),
      refreshToken: this.generateToken(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour
      user,
    }

    this.currentSession = session
    this.notifySubscribers()

    return session
  }

  async signIn(credentials: AuthCredentials): Promise<AuthSession> {
    await this.wait()

    const { email, password } = credentials

    // Find user
    const stored = this.users.get(email)
    if (!stored || stored.password !== password) {
      const error: AuthError = {
        code: "invalid_credentials",
        message: "Invalid email or password",
      }
      throw error
    }

    // Create session
    const session: AuthSession = {
      accessToken: this.generateToken(),
      refreshToken: this.generateToken(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour
      user: stored.user,
    }

    this.currentSession = session
    this.notifySubscribers()

    return session
  }

  async signOut(): Promise<void> {
    await this.wait()

    this.currentSession = null
    this.notifySubscribers()
  }

  async getSession(): Promise<AuthSession | null> {
    await this.wait()
    return this.currentSession
  }

  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void {
    this.subscribers.add(callback)

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback)
    }
  }

  /**
   * Reset all state for test isolation.
   * Clears users, current session, and all subscribers.
   */
  clear(): void {
    this.users.clear()
    this.currentSession = null
    this.subscribers.clear()
  }
}
