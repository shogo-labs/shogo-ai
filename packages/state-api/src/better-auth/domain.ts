/**
 * BetterAuth Domain Store
 *
 * Uses the domain() composition API to define User, Session, Account,
 * and Verification entities with enhancement hooks for computed views,
 * volatile state, and domain actions.
 *
 * Based on packages/state-api/src/auth/domain.ts pattern.
 */

import { getEnv } from "mobx-state-tree"
import { domain } from "../domain"
import type { IEnvironment } from "../environment/types"
import type { AuthCredentials, AuthSession as ServiceAuthSession } from "../auth/types"
import { BetterAuthSchema } from "./schema"

// ============================================================
// 1. STORE FACTORY OPTIONS
// ============================================================

export interface CreateBetterAuthStoreOptions {
  /** Enable reference validation (default: true in dev) */
  validateReferences?: boolean
}

// ============================================================
// 2. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * BetterAuth domain with all enhancements.
 * Registered in enhancement registry for meta-store integration.
 */
export const betterAuthDomain = domain({
  name: "better-auth",
  from: BetterAuthSchema,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,
      Session: models.Session.views((self: any) => ({
        /**
         * Check if session is expired by comparing expiresAt to current time
         */
        get isExpired(): boolean {
          const expiresAt = new Date(self.expiresAt).getTime()
          return Date.now() > expiresAt
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions and volatile state
    // --------------------------------------------------------
    rootStore: (RootModel) =>
      RootModel
        // Volatile state for auth status
        .volatile(() => ({
          authStatus: "idle" as "idle" | "loading" | "error",
          authError: null as string | null,
        }))
        // Views
        .views((self: any) => ({
          /**
           * Get current authenticated user, or null if not authenticated
           */
          get currentUser(): any | null {
            const users = self.userCollection.all()
            return users.length > 0 ? users[0] : null
          },

          /**
           * Get current session, or null if not authenticated
           */
          get currentSession(): any | null {
            const sessions = self.sessionCollection.all()
            return sessions.length > 0 ? sessions[0] : null
          },

          /**
           * Check if user is currently authenticated
           */
          get isAuthenticated(): boolean {
            return self.sessionCollection.all().length > 0
          },
        }))
        // Actions
        .actions((self: any) => ({
          /**
           * Set auth status (internal action)
           */
          setAuthStatus(status: "idle" | "loading" | "error", error?: string) {
            self.authStatus = status
            self.authError = error ?? null
          },

          /**
           * Sync auth service response to MST collections
           */
          syncFromSession(session: ServiceAuthSession) {
            // Clear existing data first
            self.userCollection.clear()
            self.sessionCollection.clear()

            // Add user
            const user = self.userCollection.add({
              id: session.user.id,
              name: session.user.email.split("@")[0], // derive name from email
              email: session.user.email,
              emailVerified: session.user.emailVerified,
              createdAt: session.user.createdAt,
              updatedAt: session.user.createdAt,
            })

            // Add session with reference to user
            self.sessionCollection.add({
              id: crypto.randomUUID(),
              userId: user.id,
              token: session.accessToken,
              expiresAt: session.expiresAt,
              ipAddress: "unknown",
              userAgent: "unknown",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            })
          },

          /**
           * Clear all auth state
           */
          clearAuthState() {
            self.userCollection.clear()
            self.sessionCollection.clear()
            self.authStatus = "idle"
            self.authError = null
          },

          /**
           * Sign up a new user
           */
          async signUp(credentials: AuthCredentials) {
            const env = getEnv<IEnvironment>(self)
            const authService = env.services.auth
            if (!authService) {
              throw new Error("Auth service not available in environment")
            }

            self.setAuthStatus("loading")

            try {
              const session = await authService.signUp(credentials)
              self.syncFromSession(session)
              self.setAuthStatus("idle")
              return session
            } catch (error: any) {
              self.setAuthStatus("error", error.message || "Sign up failed")
              throw error
            }
          },

          /**
           * Sign in an existing user
           */
          async signIn(credentials: AuthCredentials) {
            const env = getEnv<IEnvironment>(self)
            const authService = env.services.auth
            if (!authService) {
              throw new Error("Auth service not available in environment")
            }

            self.setAuthStatus("loading")

            try {
              const session = await authService.signIn(credentials)
              self.syncFromSession(session)
              self.setAuthStatus("idle")
              return session
            } catch (error: any) {
              self.setAuthStatus("error", error.message || "Sign in failed")
              throw error
            }
          },

          /**
           * Sign out the current user
           */
          async signOut() {
            const env = getEnv<IEnvironment>(self)
            const authService = env.services.auth
            if (!authService) {
              throw new Error("Auth service not available in environment")
            }

            self.setAuthStatus("loading")

            try {
              await authService.signOut()
              self.clearAuthState()
            } catch (error: any) {
              self.setAuthStatus("error", error.message || "Sign out failed")
              throw error
            }
          },

          /**
           * Initialize auth state from existing session (e.g., on app startup)
           * Also sets up onAuthStateChange subscription for reactive updates.
           */
          async initialize() {
            const env = getEnv<IEnvironment>(self)
            const authService = env.services.auth
            if (!authService) {
              return // No auth service, nothing to initialize
            }

            self.setAuthStatus("loading")

            try {
              // Fetch initial session
              const session = await authService.getSession()
              if (session) {
                self.syncFromSession(session)
              }
              self.setAuthStatus("idle")

              // Set up onAuthStateChange subscription if available
              if (typeof authService.onAuthStateChange === "function") {
                authService.onAuthStateChange((newSession: ServiceAuthSession | null) => {
                  if (newSession) {
                    self.syncFromSession(newSession)
                  } else {
                    self.clearAuthState()
                  }
                })
              }
            } catch (error: any) {
              self.setAuthStatus("error", error.message || "Initialize failed")
              // Don't throw on initialize - just log
              console.error("Failed to initialize auth:", error)
            }
          },

          /**
           * Initiate Google OAuth sign-in flow
           */
          async signInWithGoogle() {
            const env = getEnv<IEnvironment>(self)
            const authService = env.services.auth
            if (!authService) {
              throw new Error("Auth service not available in environment")
            }
            // Check if service has signInWithGoogle method (IBetterAuthService)
            if (typeof (authService as any).signInWithGoogle === "function") {
              await (authService as any).signInWithGoogle()
            } else {
              throw new Error("signInWithGoogle not available on auth service")
            }
          },
        })),
  },
})

// ============================================================
// 3. BACKWARD-COMPATIBLE STORE FACTORY
// ============================================================

/**
 * Creates better-auth store with backward-compatible API.
 * Returns object with createStore and RootStoreModel for compatibility
 * with existing code that expects createStoreFromScope shape.
 */
export function createBetterAuthStore(_options: CreateBetterAuthStoreOptions = {}) {
  return {
    createStore: betterAuthDomain.createStore,
    RootStoreModel: betterAuthDomain.RootStoreModel,
    // Also expose domain result for new code
    domain: betterAuthDomain,
  }
}
