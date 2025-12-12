/**
 * Teams Domain Store
 *
 * Uses the domain() composition API to define Organization, Team, Membership,
 * App, Invitation entities with enhancement hooks for computed views (level, isExpired),
 * collection queries (findByUserId, findForResource), and permission resolution.
 *
 * Migration note: Switched from createStoreFromScope to domain() API.
 * CollectionPersistable is now auto-composed by domain().
 */

import { scope } from "arktype"
import { domain } from "../domain"

// ============================================================
// 1. ROLE LEVELS (for permission comparison)
// ============================================================

export const RoleLevels: Record<string, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
}

// ============================================================
// 2. DOMAIN SCHEMA (ArkType)
// ============================================================

export const TeamsDomain = scope({
  Organization: {
    id: "string.uuid",
    name: "string",
    slug: "string",
    "description?": "string",
    createdAt: "number",
  },

  Team: {
    id: "string.uuid",
    name: "string",
    "description?": "string",
    organizationId: "Organization", // Reference to Organization
    "parentId?": "Team", // Optional self-reference for nested hierarchy
    createdAt: "number",
  },

  Membership: {
    id: "string.uuid",
    userId: "string", // External user ID (not managed by this domain)
    role: "'owner' | 'admin' | 'member' | 'viewer'",
    "organizationId?": "Organization", // Polymorphic: either org...
    "teamId?": "Team", // ...or team (exactly one should be set)
    createdAt: "number",
  },

  App: {
    id: "string.uuid",
    name: "string",
    "description?": "string",
    teamId: "Team", // Reference to owning Team
    createdAt: "number",
  },

  Invitation: {
    id: "string.uuid",
    email: "string",
    role: "'owner' | 'admin' | 'member' | 'viewer'",
    "organizationId?": "Organization", // Polymorphic like Membership
    "teamId?": "Team",
    status: "'pending' | 'accepted' | 'declined' | 'expired'",
    expiresAt: "number",
    createdAt: "number",
  },
})

// ============================================================
// 3. STORE FACTORY OPTIONS
// ============================================================

export interface CreateTeamsStoreOptions {
  /** Enable reference validation (default: true in dev) */
  validateReferences?: boolean
}

// ============================================================
// 4. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Teams domain with all enhancements.
 * Registered in enhancement registry for meta-store integration.
 */
export const teamsDomain = domain({
  name: "teams-workspace",
  from: TeamsDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,

      // Membership.level - numeric role value for comparison
      Membership: models.Membership.views((self: any) => ({
        /**
         * Get numeric level for role comparison
         * owner=40, admin=30, member=20, viewer=10
         */
        get level(): number {
          return RoleLevels[self.role] ?? 0
        },
      })),

      // Invitation.isExpired - check if invitation has expired
      Invitation: models.Invitation.views((self: any) => ({
        /**
         * Check if invitation is expired by comparing expiresAt to current time
         */
        get isExpired(): boolean {
          return Date.now() > self.expiresAt
        },
      })),
    }),

    // --------------------------------------------------------
    // collections: Add query methods (CollectionPersistable auto-composed)
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      MembershipCollection: collections.MembershipCollection.views((self: any) => ({
        /**
         * Find all memberships for a given user
         */
        findByUserId(userId: string): any[] {
          return self.all().filter((m: any) => m.userId === userId)
        },

        /**
         * Find all memberships for a given resource (organization or team)
         */
        findForResource(resourceType: "organization" | "team", resourceId: string): any[] {
          return self.all().filter((m: any) => {
            if (resourceType === "organization") {
              return m.organizationId?.id === resourceId
            } else {
              return m.teamId?.id === resourceId
            }
          })
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions and views
    // --------------------------------------------------------
    rootStore: (RootModel) =>
      RootModel.views((self: any) => ({
        /**
         * Resolve effective permissions for a user on a resource.
         * Walks up the hierarchy (team → parent team → org) and returns
         * the highest role the user has at any level.
         *
         * @param userId - The user to check permissions for
         * @param resourceType - "organization" | "team" | "app"
         * @param resourceId - The ID of the resource
         * @returns The highest role, or null if no permissions
         */
        resolvePermissions(
          userId: string,
          resourceType: "organization" | "team" | "app",
          resourceId: string
        ): string | null {
          let maxLevel = 0
          let maxRole: string | null = null

          // Helper to check user memberships directly
          const checkUserMemberships = (type: "organization" | "team", id: string) => {
            const userMemberships = self.membershipCollection.findByUserId(userId)
            for (const m of userMemberships) {
              if (type === "organization" && m.organizationId?.id === id) {
                if (m.level > maxLevel) {
                  maxLevel = m.level
                  maxRole = m.role
                }
              } else if (type === "team" && m.teamId?.id === id) {
                if (m.level > maxLevel) {
                  maxLevel = m.level
                  maxRole = m.role
                }
              }
            }
          }

          if (resourceType === "organization") {
            // Check direct org membership
            checkUserMemberships("organization", resourceId)
          } else if (resourceType === "team") {
            // Get the team
            const team = self.teamCollection.get(resourceId)
            if (!team) return null

            // Check direct team membership
            checkUserMemberships("team", resourceId)

            // Walk up parent teams
            let currentTeam = team
            while (currentTeam.parentId) {
              checkUserMemberships("team", currentTeam.parentId.id)
              currentTeam = currentTeam.parentId
            }

            // Check org-level membership (highest in hierarchy)
            checkUserMemberships("organization", team.organizationId.id)
          } else if (resourceType === "app") {
            // Get the app
            const app = self.appCollection.get(resourceId)
            if (!app) return null

            // App inherits from its team
            const team = app.teamId
            if (team) {
              // Recursively check team permissions
              return self.resolvePermissions(userId, "team", team.id)
            }
          }

          return maxRole
        },
      })),
  },
})

// ============================================================
// 5. BACKWARD-COMPATIBLE STORE FACTORY
// ============================================================

/**
 * Creates teams store with backward-compatible API.
 * Returns object with createStore and RootStoreModel for compatibility
 * with existing code that expects createStoreFromScope shape.
 */
export function createTeamsStore(_options: CreateTeamsStoreOptions = {}) {
  return {
    createStore: teamsDomain.createStore,
    RootStoreModel: teamsDomain.RootStoreModel,
    // Also expose domain result for new code
    domain: teamsDomain,
  }
}
