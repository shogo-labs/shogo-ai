/**
 * Studio Core Domain Store
 *
 * Uses the domain() composition API to define Organization, Team, Project, Member,
 * BillingAccount, Invitation entities with enhancement hooks for computed views (level, isExpired),
 * collection queries (findByUserId, findForResource, findByOrganization, findPending),
 * and permission resolution.
 */

import { scope } from "arktype"
import { getRoot } from "mobx-state-tree"
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
    status: "'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled'",
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

      OrganizationCollection: collections.OrganizationCollection.views((self: any) => ({
        /**
         * Find all organizations where a user has direct membership.
         * This is used by the org switcher UI to show available orgs.
         *
         * @param userId - The user ID to find organizations for
         * @returns Array of Organization instances
         */
        findByMembership(userId: string): any[] {
          // Get all members for this user that have org membership
          const root = getRoot(self) as any
          const userMembers = root.memberCollection.findByUserId(userId)

          // Filter to only org memberships and get the org instances
          const orgs: any[] = []
          for (const member of userMembers) {
            if (member.organization) {
              orgs.push(member.organization)
            }
          }
          return orgs
        },
      })),

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

        /**
         * Find all invitations for a given resource (organization, team, or project)
         */
        findForResource(resourceType: "organization" | "team" | "project", resourceId: string): any[] {
          return self.all().filter((i: any) => {
            if (resourceType === "organization") {
              return i.organization?.id === resourceId
            } else if (resourceType === "team") {
              return i.team?.id === resourceId
            } else if (resourceType === "project") {
              return i.project?.id === resourceId
            }
            return false
          })
        },

        /**
         * Find all invitations sent to a specific email address
         */
        findByEmail(email: string): any[] {
          return self.all().filter((i: any) => i.email === email)
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

        /**
         * Create a personal organization for a user (auto-created on signup).
         * Uses special naming and slug conventions.
         *
         * @param userId - The user's ID
         * @param userName - The user's display name
         * @returns The created Organization instance
         */
        async createPersonalOrganization(userId: string, userName: string): Promise<any> {
          // Generate slug from userId prefix (first 8 chars, no dashes)
          const userIdPrefix = userId.substring(0, 8).replace(/-/g, "")
          const slug = `user-${userIdPrefix}-personal`

          // Organization name: "{userName} Personal"
          const orgName = `${userName || "User"} Personal`

          const now = Date.now()
          const orgId = crypto.randomUUID()

          // Create the organization
          await self.organizationCollection.insertOne({
            id: orgId,
            name: orgName,
            slug,
            createdAt: now,
          })

          // Create the owner membership
          await self.memberCollection.insertOne({
            id: crypto.randomUUID(),
            userId,
            role: "owner",
            organizationId: orgId,
            createdAt: now,
          })

          return self.organizationCollection.get(orgId)
        },

        /**
         * Create a new organization and add the creator as owner.
         *
         * @param name - The organization name
         * @param description - Optional description
         * @param userId - The ID of the user creating the org (becomes owner)
         * @returns The created Organization instance
         */
        createOrganization(name: string, description: string | undefined, userId: string): any {
          // Generate slug from name (lowercase, replace spaces and special chars with dashes)
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")

          // Create the organization first
          const org = self.organizationCollection.add({
            id: crypto.randomUUID(),
            name,
            slug,
            description,
            createdAt: Date.now(),
          })

          // Then create the owner membership
          self.memberCollection.add({
            id: crypto.randomUUID(),
            userId,
            role: "owner",
            organization: org.id,
            createdAt: Date.now(),
          })

          return org
        },

        /**
         * Create a new project within an organization.
         *
         * @param name - The project name
         * @param organizationId - The ID of the organization to create the project in
         * @param description - Optional description
         * @param userId - The ID of the user creating the project
         * @returns The created Project instance
         */
        createProject(
          name: string,
          organizationId: string,
          description: string | undefined,
          userId: string
        ): any {
          // Create the project
          const project = self.projectCollection.add({
            id: crypto.randomUUID(),
            name,
            description,
            organization: organizationId,
            tier: "starter",
            status: "active",
            createdBy: userId,
            createdAt: Date.now(),
          })

          return project
        },

        // --------------------------------------------------------
        // Member Management Actions
        // --------------------------------------------------------

        /**
         * Update a member's role.
         * Validates that acting user has permission to change the role.
         *
         * Rules:
         * - Acting user's role level must be >= target member's current level
         * - Acting user's role level must be >= new role level
         * - Cannot promote someone above your own level
         *
         * @param memberId - The ID of the member to update
         * @param newRole - The new role to assign
         * @param actingUserId - The ID of the user performing the action
         */
        async updateMemberRole(memberId: string, newRole: string, actingUserId: string): Promise<void> {
          // Get the target member
          const targetMember = await self.memberCollection.query().where({ id: memberId }).first()
          if (!targetMember) {
            throw new Error("Member not found")
          }

          // Determine the resource for permission check
          let resourceType: "organization" | "team" | "project"
          let resourceId: string

          if (targetMember.organizationId) {
            resourceType = "organization"
            resourceId = targetMember.organizationId
          } else if (targetMember.teamId) {
            resourceType = "team"
            resourceId = targetMember.teamId
          } else if (targetMember.projectId) {
            resourceType = "project"
            resourceId = targetMember.projectId
          } else {
            throw new Error("Member has no resource reference")
          }

          // Load acting user's memberships to check permissions
          await self.memberCollection.loadAll()

          // Get acting user's role level on this resource
          const actingUserRole = self.resolvePermissions(actingUserId, resourceType, resourceId)
          if (!actingUserRole) {
            throw new Error("Permission denied: no access to this resource")
          }

          const actingUserLevel = RoleLevels[actingUserRole] ?? 0
          const targetCurrentLevel = RoleLevels[targetMember.role] ?? 0
          const newRoleLevel = RoleLevels[newRole] ?? 0

          // Check: acting user level must be >= target's current level
          if (actingUserLevel < targetCurrentLevel) {
            throw new Error("Permission denied: cannot manage a member with higher role")
          }

          // Check: acting user cannot promote above their own level
          if (newRoleLevel > actingUserLevel) {
            throw new Error("Cannot promote above your own level")
          }

          // Update the member's role
          await self.memberCollection.updateOne(memberId, {
            role: newRole,
            updatedAt: Date.now(),
          })
        },

        /**
         * Remove a member from an organization/team/project.
         * Validates that acting user has permission and prevents removing the last owner.
         *
         * @param memberId - The ID of the member to remove
         * @param actingUserId - The ID of the user performing the action
         */
        async removeMember(memberId: string, actingUserId: string): Promise<void> {
          // Get the target member
          const targetMember = await self.memberCollection.query().where({ id: memberId }).first()
          if (!targetMember) {
            throw new Error("Member not found")
          }

          // Determine the resource for permission check
          let resourceType: "organization" | "team" | "project"
          let resourceId: string

          if (targetMember.organizationId) {
            resourceType = "organization"
            resourceId = targetMember.organizationId
          } else if (targetMember.teamId) {
            resourceType = "team"
            resourceId = targetMember.teamId
          } else if (targetMember.projectId) {
            resourceType = "project"
            resourceId = targetMember.projectId
          } else {
            throw new Error("Member has no resource reference")
          }

          // Load acting user's memberships to check permissions
          await self.memberCollection.loadAll()

          // Get acting user's role level on this resource
          const actingUserRole = self.resolvePermissions(actingUserId, resourceType, resourceId)
          if (!actingUserRole) {
            throw new Error("Permission denied: no access to this resource")
          }

          const actingUserLevel = RoleLevels[actingUserRole] ?? 0
          const targetLevel = RoleLevels[targetMember.role] ?? 0

          // Check: acting user level must be >= target's level
          if (actingUserLevel < targetLevel) {
            throw new Error("Permission denied: cannot remove a member with higher role")
          }

          // If target is an owner, check last-owner protection
          if (targetMember.role === "owner" && resourceType === "organization") {
            const allMembers = self.memberCollection.findForResource(resourceType, resourceId)
            const owners = allMembers.filter((m: any) => m.role === "owner")
            if (owners.length <= 1) {
              throw new Error("Cannot remove the last owner of an organization")
            }
          }

          // Delete the member
          await self.memberCollection.deleteOne(memberId)
        },

        /**
         * Accept an invitation, creating a member and updating invitation status.
         *
         * Rules:
         * - Invitation must exist and be in 'pending' status
         * - Invitation must not be expired
         *
         * @param invitationId - The ID of the invitation to accept
         * @param userId - The ID of the user accepting the invitation
         */
        async acceptInvitation(invitationId: string, userId: string): Promise<void> {
          // Get the invitation
          const invitation = await self.invitationCollection.query().where({ id: invitationId }).first()
          if (!invitation) {
            throw new Error("Invitation not found")
          }

          // Check status is pending
          if (invitation.status !== "pending") {
            throw new Error("Invitation is not pending")
          }

          // Check if expired (using the computed view isExpired)
          // Load into MST to get computed view
          await self.invitationCollection.loadAll()
          const mstInvitation = self.invitationCollection.get(invitationId)
          if (mstInvitation && mstInvitation.isExpired) {
            throw new Error("Invitation is expired")
          }

          // Determine resource reference
          const memberData: any = {
            id: crypto.randomUUID(),
            userId,
            role: invitation.role,
            createdAt: Date.now(),
          }

          if (invitation.organizationId) {
            memberData.organizationId = invitation.organizationId
          } else if (invitation.teamId) {
            memberData.teamId = invitation.teamId
          } else if (invitation.projectId) {
            memberData.projectId = invitation.projectId
          }

          // Create the member
          await self.memberCollection.insertOne(memberData)

          // Update invitation status
          await self.invitationCollection.updateOne(invitationId, {
            status: "accepted",
            updatedAt: Date.now(),
          })
        },

        /**
         * Decline an invitation, updating its status to declined.
         *
         * @param invitationId - The ID of the invitation to decline
         */
        async declineInvitation(invitationId: string): Promise<void> {
          // Get the invitation
          const invitation = await self.invitationCollection.query().where({ id: invitationId }).first()
          if (!invitation) {
            throw new Error("Invitation not found")
          }

          // Update invitation status
          await self.invitationCollection.updateOne(invitationId, {
            status: "declined",
            updatedAt: Date.now(),
          })
        },

        /**
         * Cancel an invitation (admin/owner action).
         * Validates that acting user has admin/owner permission on the invitation's resource.
         *
         * @param invitationId - The ID of the invitation to cancel
         * @param actingUserId - The ID of the user performing the action
         */
        async cancelInvitation(invitationId: string, actingUserId: string): Promise<void> {
          // Get the invitation
          const invitation = await self.invitationCollection.query().where({ id: invitationId }).first()
          if (!invitation) {
            throw new Error("Invitation not found")
          }

          // Determine resource for permission check
          let resourceType: "organization" | "team" | "project"
          let resourceId: string

          if (invitation.organizationId) {
            resourceType = "organization"
            resourceId = invitation.organizationId
          } else if (invitation.teamId) {
            resourceType = "team"
            resourceId = invitation.teamId
          } else if (invitation.projectId) {
            resourceType = "project"
            resourceId = invitation.projectId
          } else {
            throw new Error("Invitation has no resource reference")
          }

          // Load acting user's memberships to check permissions
          await self.memberCollection.loadAll()

          // Get acting user's role level on this resource
          const actingUserRole = self.resolvePermissions(actingUserId, resourceType, resourceId)
          if (!actingUserRole) {
            throw new Error("Permission denied: no access to this resource")
          }

          const actingUserLevel = RoleLevels[actingUserRole] ?? 0

          // Only admin (30) or owner (40) can cancel invitations
          if (actingUserLevel < RoleLevels.admin) {
            throw new Error("Permission denied: only admins or owners can cancel invitations")
          }

          // Update invitation status to cancelled
          await self.invitationCollection.updateOne(invitationId, {
            status: "cancelled",
            updatedAt: Date.now(),
          })
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
