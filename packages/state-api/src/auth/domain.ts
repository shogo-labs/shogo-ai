/**
 * Auth domain store with ArkType scope and enhancement hooks
 * Task: task-auth-005
 * Requirement: req-auth-004
 *
 * Follows the domain.ts pattern:
 * - Define entities as ArkType scope
 * - Use createStoreFromScope with enhancement hooks
 * - Add computed views, query methods, and domain actions
 */

import { scope } from "arktype"
import { types, getEnv, IAnyModelType } from "mobx-state-tree"
import { createStoreFromScope } from "../schematic"
import type { IEnvironment } from "../environment/types"
import type { AuthSession } from "./types"

/**
 * AuthDomain ArkType scope
 *
 * Defines the auth entities with proper reference syntax.
 * AuthSession.user is an optional reference to AuthUser.
 * Optional references become `undefined` in MST when not set.
 */
export const AuthDomain = scope({
  AuthUser: {
    id: "string",
    email: "string",
    createdAt: "string",
  },
  AuthSession: {
    id: "string",
    // Optional reference to AuthUser - undefined when not authenticated
    "user?": "AuthUser",
    lastRefreshedAt: "string",
  },
})

/**
 * Enhancement hook for entity models
 * Adds computed views to entities
 */
function enhanceModels(models: Record<string, IAnyModelType>): Record<string, IAnyModelType> {
  const enhanced: Record<string, IAnyModelType> = { ...models }

  // Add isAuthenticated computed view to AuthSession
  if (enhanced.AuthSession) {
    enhanced.AuthSession = enhanced.AuthSession.views((self: any) => ({
      get isAuthenticated(): boolean {
        return !!self.user
      },
    }))
  }

  return enhanced
}

/**
 * Enhancement hook for collection models
 * Adds query methods to collections
 */
function enhanceCollections(collections: Record<string, IAnyModelType>): Record<string, IAnyModelType> {
  const enhanced: Record<string, IAnyModelType> = { ...collections }

  // Add findByEmail to AuthUserCollection
  if (enhanced.AuthUserCollection) {
    enhanced.AuthUserCollection = enhanced.AuthUserCollection.views((self: any) => ({
      findByEmail(email: string) {
        return self.all().find((user: any) => user.email === email)
      },
    }))
  }

  return enhanced
}

/**
 * Enhancement hook for root store
 * Adds domain actions that integrate with IAuthService
 */
function enhanceRootStore(RootStoreModel: IAnyModelType): IAnyModelType {
  return RootStoreModel.actions((self: any) => ({
    /**
     * Initialize auth state from the auth service
     * Called on app mount to restore session
     */
    async initializeAuth() {
      const env = getEnv<IEnvironment>(self)
      const authService = env.services.auth

      if (!authService) {
        console.warn("[auth] No auth service configured")
        return
      }

      // Ensure current session entity exists
      if (!self.authSessionCollection.has("current")) {
        self.authSessionCollection.add({
          id: "current",
          // user is optional, omit it for undefined
          lastRefreshedAt: new Date().toISOString(),
        })
      }

      // Get session from service
      const session = await authService.getSession()

      if (session?.user) {
        // Sync the user and session state
        self.syncAuthState(session)
      }
    },

    /**
     * Sync auth state from an auth event
     * Called when auth state changes (sign in, sign out, token refresh)
     */
    syncAuthState(session: AuthSession | null) {
      // Ensure current session entity exists
      if (!self.authSessionCollection.has("current")) {
        self.authSessionCollection.add({
          id: "current",
          // user is optional, omit it for undefined
          lastRefreshedAt: new Date().toISOString(),
        })
      }

      const currentSession = self.authSessionCollection.get("current")

      if (session?.user) {
        // Add or update user
        if (!self.authUserCollection.has(session.user.id)) {
          self.authUserCollection.add({
            id: session.user.id,
            email: session.user.email,
            createdAt: session.user.createdAt,
          })
        }

        // Update session reference
        currentSession.setUser(session.user.id)
        currentSession.setLastRefreshedAt(session.lastRefreshedAt)
      } else {
        // Clear user reference (sign out) - use undefined for optional reference
        currentSession.setUser(undefined)
        currentSession.setLastRefreshedAt(new Date().toISOString())
      }
    },
  }))
}

/**
 * Create auth store factory
 *
 * @param env - MST environment with auth service
 * @returns Auth store instance
 */
export function createAuthStore(env: IEnvironment) {
  const result = createStoreFromScope(AuthDomain, {
    enhanceModels,
    enhanceCollections,
    enhanceRootStore,
    generateActions: true,
  })

  return result.createStore(env)
}
