/**
 * StudioCore Domain
 *
 * Imports generated schema from Prisma and adds hand-written enhancements.
 * Schema regeneration: bun run generate:domain
 */

import { domain } from "../domain"
import { getRoot } from "mobx-state-tree"
import { StudioCoreScope } from "../generated/studio-core.schema"

// ============================================================================
// Constants
// ============================================================================

export const RoleLevels: Record<string, number> = {
  owner: 40,
  admin: 30,
  member: 20,
  viewer: 10,
}

// ============================================================================
// Domain Definition
// ============================================================================

export const studioCoreDomain = domain({
  name: "studio-core",
  from: StudioCoreScope,
  enhancements: {
    // --------------------------------------------------
    // Model enhancements: computed views on entities
    // --------------------------------------------------
    models: (models) => ({
      ...models,

      Member: models.Member.views((self: any) => ({
        get level(): number {
          return RoleLevels[self.role] ?? 0
        },
      })),

      Invitation: models.Invitation.views((self: any) => ({
        get isExpired(): boolean {
          return Date.now() > self.expiresAt
        },
      })),

      Notification: models.Notification.views((self: any) => ({
        get isUnread(): boolean {
          return self.readAt === undefined || self.readAt === null
        },
      })),
    }),

    // --------------------------------------------------
    // Collection enhancements: query methods
    // --------------------------------------------------
    collections: (collections) => ({
      ...collections,

      WorkspaceCollection: collections.WorkspaceCollection.views((self: any) => ({
        findByMembership(userId: string): any[] {
          const root = getRoot(self) as any
          const userMembers = root.memberCollection.findByUserId(userId)
          return userMembers
            .filter((m: any) => m.workspace)
            .map((m: any) => m.workspace)
        },
      })),

      MemberCollection: collections.MemberCollection.views((self: any) => ({
        findByUserId(userId: string): any[] {
          return self.all().filter((m: any) => m.userId === userId)
        },
        findForResource(resourceType: "workspace" | "project", resourceId: string): any[] {
          return self.all().filter((m: any) => {
            if (resourceType === "workspace") return m.workspace?.id === resourceId
            if (resourceType === "project") return m.project?.id === resourceId
            return false
          })
        },
      })),

      ProjectCollection: collections.ProjectCollection.views((self: any) => ({
        findByWorkspace(workspaceId: string): any[] {
          return self.all().filter((p: any) => p.workspace?.id === workspaceId)
        },
      })),

      FolderCollection: collections.FolderCollection.views((self: any) => ({
        findByWorkspace(workspaceId: string): any[] {
          return self.all().filter((f: any) => f.workspace?.id === workspaceId)
        },
      })),

      InvitationCollection: collections.InvitationCollection.views((self: any) => ({
        findPending(): any[] {
          return self.all().filter((i: any) => i.status === "pending")
        },
        findByEmail(email: string): any[] {
          return self.all().filter((i: any) => i.email === email)
        },
        findPendingByEmail(email: string): any[] {
          return self.all().filter((i: any) => i.email === email && i.status === "pending")
        },
      })),

      NotificationCollection: collections.NotificationCollection.views((self: any) => ({
        forUser(userId: string): any[] {
          return self.all().filter((n: any) => n.userId === userId)
        },
        unreadForUser(userId: string): any[] {
          return self.all().filter((n: any) => n.userId === userId && n.isUnread)
        },
      })),

      StarredProjectCollection: collections.StarredProjectCollection.views((self: any) => ({
        findByUser(userId: string): any[] {
          return self.all().filter((s: any) => s.userId === userId)
        },
        isStarred(userId: string, projectId: string): boolean {
          return self.all().some((s: any) => s.userId === userId && s.projectId === projectId)
        },
      })),
    }),

    // --------------------------------------------------
    // Root store enhancements: domain-level views and actions
    // --------------------------------------------------
    rootStore: (RootModel) =>
      RootModel.views((self: any) => ({
        resolvePermissions(
          userId: string,
          resourceType: "workspace" | "project",
          resourceId: string
        ): string | null {
          let maxLevel = 0
          let maxRole: string | null = null

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
            checkUserMembers("workspace", resourceId)
          } else if (resourceType === "project") {
            const project = self.projectCollection.get(resourceId)
            if (!project) return null
            checkUserMembers("project", resourceId)
            checkUserMembers("workspace", project.workspace.id)
          }

          return maxRole
        },
      })).actions((self: any) => ({
        createMember(data: any): any {
          const resourceCount = [data.workspace, data.project].filter(Boolean).length
          if (resourceCount !== 1) {
            throw new Error("Member must have exactly one of: workspace or project")
          }
          return self.memberCollection.add(data)
        },

        createInvitation(data: any): any {
          const resourceCount = [data.workspace, data.project].filter(Boolean).length
          if (resourceCount !== 1) {
            throw new Error("Invitation must have exactly one of: workspace or project")
          }
          return self.invitationCollection.add(data)
        },

        createWorkspace(name: string, description: string | undefined, userId: string): any {
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")

          const now = Date.now()
          const workspaceId = crypto.randomUUID()

          const ws = self.workspaceCollection.add({
            id: workspaceId,
            name,
            slug,
            description,
            createdAt: now,
          })

          self.memberCollection.add({
            id: crypto.randomUUID(),
            userId,
            role: "owner",
            workspace: workspaceId,
            createdAt: now,
          })

          return ws
        },

        async createProject(name: string, workspaceId: string, description?: string, createdBy?: string): Promise<any> {
          const now = Date.now()
          const projectId = crypto.randomUUID()

          // Make API call to create project in database
          const apiUrl = typeof window !== 'undefined' 
            ? '/api/projects' 
            : `${process.env.VITE_API_URL || ''}/api/projects`

          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: projectId,
              name,
              description,
              workspaceId,
              createdBy,
              createdAt: new Date(now).toISOString(),
              updatedAt: new Date(now).toISOString(),
              tier: "starter",
              status: "draft",
            }),
          })

          if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Failed to create project' }))
            throw new Error(error.error?.message || error.message || 'Failed to create project')
          }

          const result = await response.json()
          const projectData = result.data

          // Also add to local MST store for immediate UI updates
          const project = self.projectCollection.add({
            id: projectData.id,
            name: projectData.name,
            description: projectData.description,
            workspace: workspaceId,
            createdBy: projectData.createdBy,
            createdAt: new Date(projectData.createdAt).getTime(),
            updatedAt: new Date(projectData.updatedAt).getTime(),
            tier: projectData.tier || "starter",
            status: projectData.status || "draft",
          })

          return project
        },

        async toggleStarProject(
          userId: string,
          projectId: string,
          workspaceId: string
        ): Promise<boolean> {
          const existing = self.starredProjectCollection
            .all()
            .find((s: any) => s.userId === userId && s.projectId === projectId)

          if (existing) {
            await self.starredProjectCollection.deleteOne(existing.id)
            return false
          } else {
            await self.starredProjectCollection.insertOne({
              id: crypto.randomUUID(),
              userId,
              projectId,
              workspaceId,
              createdAt: Date.now(),
            })
            return true
          }
        },
      })),
  },
})

// ============================================================================
// Exports
// ============================================================================

/** Factory that returns { createStore } for backwards compatibility with tests */
export function createStudioCoreStore() {
  return {
    createStore: studioCoreDomain.createStore,
  }
}

export default studioCoreDomain
