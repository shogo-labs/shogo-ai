/**
 * Studio Core Domain Store
 *
 * Uses the domain() composition API to define Workspace, Project, Member,
 * BillingAccount, Invitation entities with enhancement hooks for computed views (level, isExpired),
 * collection queries (findByUserId, findForResource, findByWorkspace, findPending),
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
  Workspace: {
    id: "string.uuid",
    name: "string",
    slug: "string",
    "description?": "string",
    "ssoSettings?": "unknown", // Opaque JSON for SSO configs
    createdAt: "number",
    "updatedAt?": "number",
  },

  Project: {
    id: "string.uuid",
    name: "string",
    "description?": "string",
    workspace: "Workspace", // Reference to Workspace
    tier: "'starter' | 'pro' | 'enterprise' | 'internal'",
    status: "'draft' | 'active' | 'archived'",
    "schemas?": "string[]", // Array of schema names
    "createdBy?": "string", // Loose string ref to AuthUser.id
    createdAt: "number",
    "updatedAt?": "number",
    "folderId?": "string", // Optional folder ID (loose string ref)
  },

  Folder: {
    id: "string.uuid",
    name: "string",
    workspace: "Workspace", // Reference to Workspace
    "parentId?": "string", // Optional parent folder ID (loose string ref)
    "createdBy?": "string", // Loose string ref to AuthUser.id
    createdAt: "number",
    "updatedAt?": "number",
  },

  Member: {
    id: "string.uuid",
    userId: "string", // Loose string ref to AuthUser.id
    role: "'owner' | 'admin' | 'member' | 'viewer'",
    "workspace?": "Workspace", // Polymorphic: exactly one of workspace/project
    "project?": "Project",
    "isBillingAdmin?": "boolean",
    createdAt: "number",
    "updatedAt?": "number",
  },

  BillingAccount: {
    id: "string.uuid",
    workspace: "Workspace", // Reference to Workspace
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
    "workspace?": "Workspace", // Polymorphic like Member
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

      WorkspaceCollection: collections.WorkspaceCollection.views((self: any) => ({
        /**
         * Find all workspaces where a user has direct membership.
         * This is used by the workspace switcher UI to show available workspaces.
         *
         * @param userId - The user ID to find workspaces for
         * @returns Array of Workspace instances
         */
        findByMembership(userId: string): any[] {
          // Get all members for this user that have workspace membership
          const root = getRoot(self) as any
          const userMembers = root.memberCollection.findByUserId(userId)

          // Filter to only workspace memberships and get the workspace instances
          const workspaces: any[] = []
          for (const member of userMembers) {
            if (member.workspace) {
              workspaces.push(member.workspace)
            }
          }
          return workspaces
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
         * Find all members for a given resource (workspace or project)
         */
        findForResource(resourceType: "workspace" | "project", resourceId: string): any[] {
          return self.all().filter((m: any) => {
            if (resourceType === "workspace") {
              return m.workspace?.id === resourceId
            } else if (resourceType === "project") {
              return m.project?.id === resourceId
            }
            return false
          })
        },
      })),

      ProjectCollection: collections.ProjectCollection.views((self: any) => ({
        /**
         * Find all projects for a given workspace
         */
        findByWorkspace(workspaceId: string): any[] {
          return self.all().filter((p: any) => p.workspace?.id === workspaceId)
        },

        /**
         * Find all projects in a specific folder
         */
        findByFolder(folderId: string): any[] {
          return self.all().filter((p: any) => p.folderId === folderId)
        },

        /**
         * Find all root-level projects (no folder) for a workspace
         */
        findRootProjects(workspaceId: string): any[] {
          return self.all().filter((p: any) => p.workspace?.id === workspaceId && !p.folderId)
        },
      })),

      FolderCollection: collections.FolderCollection.views((self: any) => ({
        /**
         * Find all folders for a given workspace
         */
        findByWorkspace(workspaceId: string): any[] {
          return self.all().filter((f: any) => f.workspace?.id === workspaceId)
        },

        /**
         * Find root-level folders (no parent) for a workspace
         */
        findRootFolders(workspaceId: string): any[] {
          return self.all().filter((f: any) => f.workspace?.id === workspaceId && !f.parentId)
        },

        /**
         * Find child folders of a given parent
         */
        findByParent(parentId: string): any[] {
          return self.all().filter((f: any) => f.parentId === parentId)
        },

        /**
         * Get folder hierarchy path (breadcrumb trail from root to folder)
         */
        getAncestors(folderId: string): any[] {
          const ancestors: any[] = []
          let current = self.get(folderId)
          while (current?.parentId) {
            current = self.get(current.parentId)
            if (current) ancestors.unshift(current)
          }
          return ancestors
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
         * Find all invitations for a given resource (workspace or project)
         */
        findForResource(resourceType: "workspace" | "project", resourceId: string): any[] {
          return self.all().filter((i: any) => {
            if (resourceType === "workspace") {
              return i.workspace?.id === resourceId
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
         * Returns the highest role the user has at any level.
         *
         * @param userId - The user to check permissions for
         * @param resourceType - "workspace" | "project"
         * @param resourceId - The ID of the resource
         * @returns The highest role, or null if no permissions
         */
        resolvePermissions(
          userId: string,
          resourceType: "workspace" | "project",
          resourceId: string
        ): string | null {
          let maxLevel = 0
          let maxRole: string | null = null

          // Helper to check user members directly
          const checkUserMembers = (type: "workspace" | "project", id: string) => {
            const userMembers = self.memberCollection.findByUserId(userId)
            for (const m of userMembers) {
              if (type === "workspace" && m.workspace?.id === id) {
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

          if (resourceType === "workspace") {
            // Check direct workspace membership
            checkUserMembers("workspace", resourceId)
          } else if (resourceType === "project") {
            // Get the project
            const project = self.projectCollection.get(resourceId)
            if (!project) return null

            // Check direct project membership
            checkUserMembers("project", resourceId)

            // Check workspace-level membership (projects are directly under workspaces in this schema)
            checkUserMembers("workspace", project.workspace.id)
          }

          return maxRole
        },
      })).actions((self: any) => ({
        /**
         * Create a member with polymorphic validation.
         * Ensures exactly one of workspace/project is set.
         */
        createMember(data: any): any {
          const resourceCount = [data.workspace, data.project].filter(Boolean).length
          if (resourceCount !== 1) {
            throw new Error("Member must have exactly one of: workspace or project")
          }
          return self.memberCollection.add(data)
        },

        /**
         * Create an invitation with polymorphic validation.
         * Ensures exactly one of workspace/project is set.
         */
        createInvitation(data: any): any {
          const resourceCount = [data.workspace, data.project].filter(Boolean).length
          if (resourceCount !== 1) {
            throw new Error("Invitation must have exactly one of: workspace or project")
          }
          return self.invitationCollection.add(data)
        },

        /**
         * Create a personal workspace for a user (auto-created on signup).
         * Uses special naming and slug conventions.
         *
         * @param userId - The user's ID
         * @param userName - The user's display name
         * @returns The created Workspace instance
         */
        async createPersonalWorkspace(userId: string, userName: string): Promise<any> {
          // Generate slug from userId prefix (first 8 chars, no dashes)
          const userIdPrefix = userId.substring(0, 8).replace(/-/g, "")
          const slug = `user-${userIdPrefix}-personal`

          // Workspace name: "{userName} Personal"
          const workspaceName = `${userName || "User"} Personal`

          const now = Date.now()
          const workspaceId = crypto.randomUUID()

          // Create the workspace
          await self.workspaceCollection.insertOne({
            id: workspaceId,
            name: workspaceName,
            slug,
            createdAt: now,
          })

          // Create the owner membership
          await self.memberCollection.insertOne({
            id: crypto.randomUUID(),
            userId,
            role: "owner",
            workspaceId: workspaceId,
            createdAt: now,
          })

          return self.workspaceCollection.get(workspaceId)
        },

        /**
         * Create a new workspace and add the creator as owner.
         *
         * @param name - The workspace name
         * @param description - Optional description
         * @param userId - The ID of the user creating the workspace (becomes owner)
         * @returns The created Workspace instance
         */
        async createWorkspace(name: string, description: string | undefined, userId: string): Promise<any> {
          // Generate slug from name (lowercase, replace spaces and special chars with dashes)
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")

          const now = Date.now()
          const workspaceId = crypto.randomUUID()

          // Create the workspace first (insertOne persists to backend)
          await self.workspaceCollection.insertOne({
            id: workspaceId,
            name,
            slug,
            description,
            createdAt: now,
          })

          // Then create the owner membership
          await self.memberCollection.insertOne({
            id: crypto.randomUUID(),
            userId,
            role: "owner",
            workspaceId: workspaceId,
            createdAt: now,
          })

          return self.workspaceCollection.get(workspaceId)
        },

        /**
         * Create a new project within a workspace.
         *
         * @param name - The project name
         * @param workspaceId - The ID of the workspace to create the project in
         * @param description - Optional description
         * @param userId - The ID of the user creating the project
         * @returns The created Project instance
         */
        async createProject(
          name: string,
          workspaceId: string,
          description: string | undefined,
          userId: string
        ): Promise<any> {
          // Create the project via insertOne to persist to backend
          const project = await self.projectCollection.insertOne({
            id: crypto.randomUUID(),
            name,
            description,
            workspace: workspaceId,
            tier: "starter",
            status: "active",
            createdBy: userId,
            createdAt: Date.now(),
          })

          return project
        },

        /**
         * Update a project's properties.
         *
         * @param projectId - The ID of the project to update
         * @param updates - The properties to update (name, description, status)
         */
        async updateProject(
          projectId: string,
          updates: { name?: string; description?: string; status?: string }
        ): Promise<void> {
          await self.projectCollection.updateOne(projectId, {
            ...updates,
            updatedAt: Date.now(),
          })
        },

        /**
         * Delete a project.
         *
         * @param projectId - The ID of the project to delete
         */
        async deleteProject(projectId: string): Promise<void> {
          await self.projectCollection.deleteOne(projectId)
        },

        // --------------------------------------------------------
        // Folder Management Actions
        // --------------------------------------------------------

        /**
         * Create a new folder within a workspace.
         *
         * @param name - The folder name
         * @param workspaceId - The ID of the workspace to create the folder in
         * @param parentId - Optional parent folder ID for nesting
         * @param userId - The ID of the user creating the folder
         * @returns The created Folder instance
         */
        async createFolder(
          name: string,
          workspaceId: string,
          parentId: string | null,
          userId: string
        ): Promise<any> {
          const folder = await self.folderCollection.insertOne({
            id: crypto.randomUUID(),
            name,
            workspace: workspaceId,
            parentId: parentId || undefined,
            createdBy: userId,
            createdAt: Date.now(),
          })
          return folder
        },

        /**
         * Update a folder's properties.
         *
         * @param folderId - The ID of the folder to update
         * @param updates - The properties to update (name, parentId)
         */
        async updateFolder(
          folderId: string,
          updates: { name?: string; parentId?: string | null }
        ): Promise<void> {
          const updateData: any = { updatedAt: Date.now() }
          if (updates.name !== undefined) updateData.name = updates.name
          if (updates.parentId !== undefined) {
            updateData.parentId = updates.parentId || undefined
          }
          await self.folderCollection.updateOne(folderId, updateData)
        },

        /**
         * Delete a folder and move its contents to parent (or root).
         * Projects inside move to parent folder; subfolders move to parent.
         *
         * @param folderId - The ID of the folder to delete
         */
        async deleteFolder(folderId: string): Promise<void> {
          const folder = self.folderCollection.get(folderId)
          if (!folder) throw new Error("Folder not found")

          const targetParentId = folder.parentId || null

          // Move all projects in this folder to parent
          const projectsInFolder = self.projectCollection.findByFolder(folderId)
          for (const project of projectsInFolder) {
            await self.projectCollection.updateOne(project.id, {
              folderId: targetParentId || undefined,
              updatedAt: Date.now(),
            })
          }

          // Move all subfolders to parent
          const subfolders = self.folderCollection.findByParent(folderId)
          for (const subfolder of subfolders) {
            await self.folderCollection.updateOne(subfolder.id, {
              parentId: targetParentId || undefined,
              updatedAt: Date.now(),
            })
          }

          // Delete the folder
          await self.folderCollection.deleteOne(folderId)
        },

        /**
         * Move a project to a folder (or root if folderId is null).
         *
         * @param projectId - The ID of the project to move
         * @param folderId - The target folder ID, or null for root
         */
        async moveProjectToFolder(
          projectId: string,
          folderId: string | null
        ): Promise<void> {
          await self.projectCollection.updateOne(projectId, {
            folderId: folderId || undefined,
            updatedAt: Date.now(),
          })
        },

        /**
         * Move a folder to a new parent (or root if parentId is null).
         * Validates against circular references.
         *
         * @param folderId - The ID of the folder to move
         * @param newParentId - The target parent folder ID, or null for root
         */
        async moveFolderToParent(
          folderId: string,
          newParentId: string | null
        ): Promise<void> {
          // Prevent circular reference
          if (newParentId) {
            const ancestors = self.folderCollection.getAncestors(newParentId)
            if (ancestors.some((a: any) => a.id === folderId) || newParentId === folderId) {
              throw new Error("Cannot move folder into its own descendant")
            }
          }

          await self.folderCollection.updateOne(folderId, {
            parentId: newParentId || undefined,
            updatedAt: Date.now(),
          })
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
          let resourceType: "workspace" | "project"
          let resourceId: string

          if (targetMember.workspaceId) {
            resourceType = "workspace"
            resourceId = targetMember.workspaceId
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
         * Remove a member from a workspace/project.
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
          let resourceType: "workspace" | "project"
          let resourceId: string

          if (targetMember.workspaceId) {
            resourceType = "workspace"
            resourceId = targetMember.workspaceId
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
          if (targetMember.role === "owner" && resourceType === "workspace") {
            const allMembers = self.memberCollection.findForResource(resourceType, resourceId)
            const owners = allMembers.filter((m: any) => m.role === "owner")
            if (owners.length <= 1) {
              throw new Error("Cannot remove the last owner of a workspace")
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

          if (invitation.workspaceId) {
            memberData.workspaceId = invitation.workspaceId
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
          let resourceType: "workspace" | "project"
          let resourceId: string

          if (invitation.workspaceId) {
            resourceType = "workspace"
            resourceId = invitation.workspaceId
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
