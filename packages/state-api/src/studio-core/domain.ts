/**
 * Studio Core Domain Store
 *
 * Uses the domain() composition API to define Organization, Team, Project, Member,
 * BillingAccount, Invitation entities with enhancement hooks for computed views (level, isExpired),
 * collection queries (findByUserId, findForResource, findByOrganization, findPending),
 * and permission resolution.
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

export const StudioCoreDomain = scope({
  Organization: {
    id: "string.uuid",
    name: "string",
    slug: "string",
    "description?": "string",
    "ssoSettings?": "unknown", // Opaque JSON for SSO configs
    createdAt: "number",
    "updatedAt?": "number",
  },

  Team: {
    id: "string.uuid",
    name: "string",
    "description?": "string",
    organization: "Organization", // Reference to Organization
    "parent?": "Team", // Optional self-reference for nested hierarchy
    createdAt: "number",
    "updatedAt?": "number",
  },

  Project: {
    id: "string.uuid",
    name: "string",
    "description?": "string",
    organization: "Organization", // Reference to Organization
    tier: "'starter' | 'pro' | 'enterprise' | 'internal'",
    status: "'draft' | 'active' | 'archived'",
    "schemas?": "string[]", // Array of schema names
    "createdBy?": "string", // Loose string ref to AuthUser.id
    createdAt: "number",
    "updatedAt?": "number",
  },

  Member: {
    id: "string.uuid",
    userId: "string", // Loose string ref to AuthUser.id
    role: "'owner' | 'admin' | 'member' | 'viewer'",
    "organization?": "Organization", // Polymorphic: exactly one of org/team/project
    "team?": "Team",
    "project?": "Project",
    "isBillingAdmin?": "boolean",
    createdAt: "number",
    "updatedAt?": "number",
  },

  BillingAccount: {
    id: "string.uuid",
    organization: "Organization", // Reference to Organization
    "stripeCustomerId?": "string",
    "taxId?": "string",
    "creditsBalance?": "number",
    createdAt: "number",
    "updatedAt?": "number",
  },

  Invitation: {
    id: "string.uuid",
    email: "string",
    role: "'owner' | 'admin' | 'member' | 'viewer'",
    "organization?": "Organization", // Polymorphic like Member
    "team?": "Team",
    "project?": "Project",
    status: "'pending' | 'accepted' | 'declined' | 'expired'",
    "invitedBy?": "string", // Loose string ref to userId who sent invitation
    expiresAt: "number",
    createdAt: "number",
    "updatedAt?": "number",
  },
})

// ============================================================
// 3. STORE FACTORY OPTIONS
// ============================================================

export interface CreateStudioCoreStoreOptions {
  /** Enable reference validation (default: true in dev) */
  validateReferences?: boolean
}

// ============================================================
// 4. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Studio Core domain with all enhancements.
 * Registered in enhancement registry for meta-store integration.
 */
export const studioCoreDomain = domain({
  name: "studio-core",
  from: StudioCoreDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,

      // Member.level - numeric role value for comparison
      Member: models.Member.views((self: any) => ({
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

      MemberCollection: collections.MemberCollection.views((self: any) => ({
        /**
         * Find all members for a given user
         */
        findByUserId(userId: string): any[] {
          return self.all().filter((m: any) => m.userId === userId)
        },

        /**
         * Find all members for a given resource (organization, team, or project)
         */
        findForResource(resourceType: "organization" | "team" | "project", resourceId: string): any[] {
          return self.all().filter((m: any) => {
            if (resourceType === "organization") {
              return m.organization?.id === resourceId
            } else if (resourceType === "team") {
              return m.team?.id === resourceId
            } else if (resourceType === "project") {
              return m.project?.id === resourceId
            }
            return false
          })
        },
      })),

      ProjectCollection: collections.ProjectCollection.views((self: any) => ({
        /**
         * Find all projects for a given organization
         */
        findByOrganization(orgId: string): any[] {
          return self.all().filter((p: any) => p.organization?.id === orgId)
        },
      })),

      InvitationCollection: collections.InvitationCollection.views((self: any) => ({
        /**
         * Find all pending invitations
         */
        findPending(): any[] {
          return self.all().filter((i: any) => i.status === "pending")
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
         * @param resourceType - "organization" | "team" | "project"
         * @param resourceId - The ID of the resource
         * @returns The highest role, or null if no permissions
         */
        resolvePermissions(
          userId: string,
          resourceType: "organization" | "team" | "project",
          resourceId: string
        ): string | null {
          let maxLevel = 0
          let maxRole: string | null = null

          // Helper to check user members directly
          const checkUserMembers = (type: "organization" | "team" | "project", id: string) => {
            const userMembers = self.memberCollection.findByUserId(userId)
            for (const m of userMembers) {
              if (type === "organization" && m.organization?.id === id) {
                if (m.level > maxLevel) {
                  maxLevel = m.level
                  maxRole = m.role
                }
              } else if (type === "team" && m.team?.id === id) {
                if (m.level > maxLevel) {
                  maxLevel = m.level
                  maxRole = m.role
                }
              } else if (type === "project" && m.project?.id === id) {
                if (m.level > maxLevel) {
                  maxLevel = m.level
                  maxRole = m.role
                }
              }
            }
          }

          if (resourceType === "organization") {
            // Check direct org membership
            checkUserMembers("organization", resourceId)
          } else if (resourceType === "team") {
            // Get the team
            const team = self.teamCollection.get(resourceId)
            if (!team) return null

            // Check direct team membership
            checkUserMembers("team", resourceId)

            // Walk up parent teams
            let currentTeam = team
            while (currentTeam.parent) {
              checkUserMembers("team", currentTeam.parent.id)
              currentTeam = currentTeam.parent
            }

            // Check org-level membership (highest in hierarchy)
            checkUserMembers("organization", team.organization.id)
          } else if (resourceType === "project") {
            // Get the project
            const project = self.projectCollection.get(resourceId)
            if (!project) return null

            // Check direct project membership
            checkUserMembers("project", resourceId)

            // Check org-level membership (projects are directly under orgs in this schema)
            checkUserMembers("organization", project.organization.id)
          }

          return maxRole
        },
      })).actions((self: any) => ({
        /**
         * Create a member with polymorphic validation.
         * Ensures exactly one of organization/team/project is set.
         */
        createMember(data: any): any {
          const resourceCount = [data.organization, data.team, data.project].filter(Boolean).length
          if (resourceCount !== 1) {
            throw new Error("Member must have exactly one of: organization, team, or project")
          }
          return self.memberCollection.add(data)
        },

        /**
         * Create an invitation with polymorphic validation.
         * Ensures exactly one of organization/team/project is set.
         */
        createInvitation(data: any): any {
          const resourceCount = [data.organization, data.team, data.project].filter(Boolean).length
          if (resourceCount !== 1) {
            throw new Error("Invitation must have exactly one of: organization, team, or project")
          }
          return self.invitationCollection.add(data)
        },
      })),
  },
})

// ============================================================
// 5. BACKWARD-COMPATIBLE STORE FACTORY
// ============================================================

/**
 * Creates studio-core store with backward-compatible API.
 * Returns object with createStore and RootStoreModel for compatibility
 * with existing code that expects createStoreFromScope shape.
 */
export function createStudioCoreStore(_options: CreateStudioCoreStoreOptions = {}) {
  return {
    createStore: studioCoreDomain.createStore,
    RootStoreModel: studioCoreDomain.RootStoreModel,
    // Also expose domain result for new code
    domain: studioCoreDomain,
  }
}
