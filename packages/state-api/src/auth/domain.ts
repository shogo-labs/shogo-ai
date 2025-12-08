/**
 * Auth Domain Store
 *
 * Schema-first implementation using createStoreFromScope.
 * Defines AuthUser and AuthSession entities with enhancement hooks
 * for computed views, collection queries, and domain actions.
 */

import { scope } from "arktype"
import { getEnv } from "mobx-state-tree"
import { createStoreFromScope } from "../schematic"
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
// 3. STORE FACTORY WITH ENHANCEMENT HOOKS
// ============================================================

export function createAuthStore(options: CreateAuthStoreOptions = {}) {
  return createStoreFromScope(AuthDomain, {
    validateReferences: options.validateReferences,

    // --------------------------------------------------------
    // enhanceModels: Add computed views to individual entities
    // --------------------------------------------------------
    enhanceModels: (models) => ({
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
    // enhanceCollections: Add query methods to collections
    // --------------------------------------------------------
    enhanceCollections: (collections) => ({
      ...collections,
      // Basic collection access is already provided by createStoreFromScope
      // Add any custom queries here if needed
    }),

    // --------------------------------------------------------
    // enhanceRootStore: Add domain actions and volatile state
    // --------------------------------------------------------
    enhanceRootStore: (RootModel) =>
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
  })
}
