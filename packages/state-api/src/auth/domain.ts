/**
 * Auth Domain Store
 *
 * Uses the domain() composition API to define AuthUser and AuthSession
 * entities with enhancement hooks for computed views, volatile state,
 * and domain actions.
 *
 * Migration note: Switched from createStoreFromScope to domain() API.
 * CollectionPersistable is now auto-composed by domain().
 */

import { scope } from "arktype"
import { getEnv } from "mobx-state-tree"
import { domain } from "../domain"
import type { IEnvironment } from "../environment/types"
import type { AuthCredentials, AuthSession as ServiceAuthSession } from "./types"

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================

export const AuthDomain = scope({
  AuthUser: {
    id: "string.uuid",
    email: "string",
    "emailVerified?": "boolean",
    "createdAt?": "string",
  },

  AuthSession: {
    id: "string.uuid",
    userId: "AuthUser", // Reference to AuthUser
    accessToken: "string",
    "refreshToken?": "string",
    expiresAt: "string",
  },
})

// ============================================================
// 2. STORE FACTORY OPTIONS
// ============================================================

export interface CreateAuthStoreOptions {
  /** Enable reference validation (default: true in dev) */
  validateReferences?: boolean
}

// ============================================================
// 3. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Auth domain with all enhancements.
 * Registered in enhancement registry for meta-store integration.
 */
export const authDomain = domain({
  name: "auth",
  from: AuthDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,
      AuthSession: models.AuthSession.views((self: any) => ({
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
            const users = self.authUserCollection.all()
            return users.length > 0 ? users[0] : null
          },

          /**
           * Get current session, or null if not authenticated
           */
          get currentSession(): any | null {
            const sessions = self.authSessionCollection.all()
            return sessions.length > 0 ? sessions[0] : null
          },

          /**
           * Check if user is currently authenticated
           */
          get isAuthenticated(): boolean {
            return self.authSessionCollection.all().length > 0
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
          syncFromServiceSession(session: ServiceAuthSession) {
            // Clear existing data first
            self.authUserCollection.clear()
            self.authSessionCollection.clear()

            // Add user
            const user = self.authUserCollection.add({
              id: session.user.id,
              email: session.user.email,
              emailVerified: session.user.emailVerified,
              createdAt: session.user.createdAt,
            })

            // Add session with reference to user
            self.authSessionCollection.add({
              id: crypto.randomUUID(),
              userId: user.id,
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
              expiresAt: session.expiresAt,
            })
          },

          /**
           * Clear all auth state
           */
          clearAuthState() {
            self.authUserCollection.clear()
            self.authSessionCollection.clear()
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
              self.syncFromServiceSession(session)
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
              self.syncFromServiceSession(session)
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
           */
          async initialize() {
            const env = getEnv<IEnvironment>(self)
            const authService = env.services.auth
            if (!authService) {
              return // No auth service, nothing to initialize
            }

            self.setAuthStatus("loading")

            try {
              const session = await authService.getSession()
              if (session) {
                self.syncFromServiceSession(session)
              }
              self.setAuthStatus("idle")
            } catch (error: any) {
              self.setAuthStatus("error", error.message || "Initialize failed")
              // Don't throw on initialize - just log
              console.error("Failed to initialize auth:", error)
            }
          },
        })),
  },
})

// ============================================================
// 4. BACKWARD-COMPATIBLE STORE FACTORY
// ============================================================

/**
 * Creates auth store with backward-compatible API.
 * Returns object with createStore and RootStoreModel for compatibility
 * with existing code that expects createStoreFromScope shape.
 */
export function createAuthStore(_options: CreateAuthStoreOptions = {}) {
  return {
    createStore: authDomain.createStore,
    RootStoreModel: authDomain.RootStoreModel,
    // Also expose domain result for new code
    domain: authDomain,
  }
}
