/**
 * Mock auth service for testing
 * Task: task-auth-003
 * Requirement: req-auth-006
 */

import type { IAuthService, AuthUser, AuthSession, AuthResult } from "./types"

interface StoredUser {
  user: AuthUser
  password: string
}

/**
 * In-memory mock implementation of IAuthService for testing
 */
export class MockAuthService implements IAuthService {
  private users = new Map<string, StoredUser>()
  private currentSession: AuthSession | null = null
  private listeners = new Set<(session: AuthSession | null) => void>()

  async signUp(email: string, password: string): Promise<AuthResult> {
    // Check for duplicate email
    if (this.users.has(email)) {
      return { user: null, error: "Email already registered" }
    }

    // Create new user
    const user: AuthUser = {
      id: crypto.randomUUID(),
      email,
      createdAt: new Date().toISOString(),
    }

    // Store user with password
    this.users.set(email, { user, password })

    // Set current session
    this.currentSession = {
      user,
      lastRefreshedAt: new Date().toISOString(),
    }

    // Notify listeners
    this.notifyListeners()

    return { user, error: null }
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    const stored = this.users.get(email)

    // Check if user exists and password matches
    if (!stored || stored.password !== password) {
      return { user: null, error: "Invalid credentials" }
    }

    // Set current session
    this.currentSession = {
      user: stored.user,
      lastRefreshedAt: new Date().toISOString(),
    }

    // Notify listeners
    this.notifyListeners()

    return { user: stored.user, error: null }
  }

  async signOut(): Promise<void> {
    this.currentSession = null
    this.notifyListeners()
  }

  async getSession(): Promise<AuthSession | null> {
    return this.currentSession
  }

  onAuthStateChange(callback: (session: AuthSession | null) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /**
   * Reset all state for testing
   */
  reset(): void {
    this.users.clear()
    this.currentSession = null
    this.listeners.clear()
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.currentSession)
    }
  }
}
