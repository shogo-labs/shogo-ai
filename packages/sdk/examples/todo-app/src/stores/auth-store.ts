/**
 * AuthStore - MobX store for authentication state
 *
 * Uses server functions for database operations:
 * - Sign up creates a user via createUser server function
 * - Sign in verifies user via signInUser server function
 * - Session is stored in localStorage for persistence
 */

import { makeAutoObservable, runInAction } from 'mobx'
import { getUserById, signInUser, createUser, type UserType } from '../utils/auth'

const SESSION_KEY = 'todo_app_user_id'

export type User = UserType

export class AuthStore {
  user: User | null = null
  isLoading = true
  isAuthenticated = false
  error: string | null = null

  constructor() {
    makeAutoObservable(this)
  }

  /**
   * Initialize auth state from localStorage
   */
  async initialize() {
    console.log('[AuthStore] initialize called, window:', typeof window)
    
    // Only run on client side
    if (typeof window === 'undefined') {
      console.log('[AuthStore] SSR mode, setting isLoading = false')
      // During SSR, set to not loading so the page renders properly
      runInAction(() => {
        this.isLoading = false
      })
      return
    }

    try {
      const userId = localStorage.getItem(SESSION_KEY)
      console.log('[AuthStore] userId from localStorage:', userId)

      if (!userId) {
        console.log('[AuthStore] No saved session, setting isLoading = false')
        // No saved session, done loading
        runInAction(() => {
          console.log('[AuthStore] Inside runInAction - before setting isLoading')
          this.isLoading = false
          this.isAuthenticated = false
          this.user = null
          console.log('[AuthStore] Inside runInAction - after setting isLoading:', this.isLoading)
        })
        console.log('[AuthStore] After runInAction, isLoading:', this.isLoading)
        return
      }

      // Verify user exists in database via server function
      const user = await getUserById({ data: { userId } })

      if (user) {
        runInAction(() => {
          this.user = user
          this.isAuthenticated = true
          this.isLoading = false
        })
      } else {
        // User no longer exists, clear session
        localStorage.removeItem(SESSION_KEY)
        runInAction(() => {
          this.isLoading = false
          this.isAuthenticated = false
          this.user = null
        })
      }
    } catch (e) {
      console.error('Auth initialization failed:', e)
      runInAction(() => {
        this.isLoading = false
        this.isAuthenticated = false
        this.user = null
      })
    }
  }

  /**
   * Sign in with email and password
   */
  async signIn(email: string, password: string) {
    runInAction(() => {
      this.isLoading = true
      this.error = null
    })

    try {
      // Verify user via server function
      const user = await signInUser({ data: { email, password } })

      // Save session to localStorage
      localStorage.setItem(SESSION_KEY, user.id)

      runInAction(() => {
        this.user = user
        this.isAuthenticated = true
        this.isLoading = false
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : 'Sign in failed'
        this.isLoading = false
      })
    }
  }

  /**
   * Sign up with email, password, and optional name
   */
  async signUp(email: string, _password: string, name?: string) {
    runInAction(() => {
      this.isLoading = true
      this.error = null
    })

    try {
      // Create user via server function
      const user = await createUser({ data: { email, name } })

      // Save session to localStorage
      localStorage.setItem(SESSION_KEY, user.id)

      runInAction(() => {
        this.user = user
        this.isAuthenticated = true
        this.isLoading = false
      })
    } catch (e) {
      runInAction(() => {
        this.error = e instanceof Error ? e.message : 'Sign up failed'
        this.isLoading = false
      })
    }
  }

  /**
   * Sign out current user
   */
  signOut() {
    localStorage.removeItem(SESSION_KEY)

    runInAction(() => {
      this.user = null
      this.isAuthenticated = false
      this.error = null
    })
  }

  /**
   * Clear error state
   */
  clearError() {
    this.error = null
  }
}
