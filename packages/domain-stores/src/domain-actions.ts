/**
 * Domain Actions
 *
 * High-level orchestration methods that coordinate multiple collections.
 * These wrap SDK collection CRUD with business logic.
 */

import { flow, getEnv } from "mobx-state-tree"
import type { IDomainStore, ISDKEnvironment } from "./domain"

// ============================================================================
// Domain Action Helpers
// ============================================================================

/**
 * Create domain actions that can be attached to the store.
 * Call these from your components using the store instance.
 *
 * @example
 * ```tsx
 * const store = useSDKDomain()
 * const actions = createDomainActions(store)
 *
 * // Create workspace with owner membership
 * const workspace = await actions.createWorkspace("My Workspace", "Description", userId)
 * ```
 */
export function createDomainActions(store: IDomainStore) {
  return {
    // =========================================================================
    // Workspace Actions
    // =========================================================================

    /**
     * Create a workspace and add the user as owner
     */
    createWorkspace: async (
      name: string,
      description: string | undefined,
      userId: string
    ) => {
      // 1. Create the workspace
      const workspace = await store.workspaceCollection.create({
        name,
        description,
        slug: name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
      })

      if (!workspace) {
        throw new Error("Failed to create workspace")
      }

      // 2. Create owner membership
      await store.memberCollection.create({
        userId,
        workspaceId: workspace.id,
        role: "owner",
      })

      return workspace
    },

    /**
     * Update a workspace
     */
    updateWorkspace: async (
      workspaceId: string,
      changes: { name?: string; description?: string }
    ) => {
      return store.workspaceCollection.update(workspaceId, changes)
    },

    /**
     * Delete a workspace (cascades to members, projects, etc. via API)
     */
    deleteWorkspace: async (workspaceId: string) => {
      return store.workspaceCollection.delete(workspaceId)
    },

    // =========================================================================
    // Project Actions
    // =========================================================================

    /**
     * Create a project in a workspace
     */
    createProject: async (
      name: string,
      workspaceId: string,
      description: string | undefined,
      userId: string,
      type?: "APP" | "AGENT",
      templateId?: string
    ) => {
      const project = await store.projectCollection.create({
        name,
        workspaceId,
        description,
        createdBy: userId,
        tier: "starter",
        status: "draft",
        accessLevel: "anyone",
        schemas: [],
        type: type || "APP",
        ...(templateId ? { templateId } : {}),
      })

      return project
    },

    /**
     * Update a project
     */
    updateProject: async (
      projectId: string,
      changes: { name?: string; description?: string; status?: string }
    ) => {
      return store.projectCollection.update(projectId, changes)
    },

    /**
     * Delete a project
     */
    deleteProject: async (projectId: string) => {
      return store.projectCollection.delete(projectId)
    },

    /**
     * Move a project to a folder (or to root when folderId is null)
     */
    moveProjectToFolder: async (projectId: string, folderId: string | null) => {
      if (folderId) {
        // Moving to a specific folder - standard optimistic update
        return store.projectCollection.update(projectId, { folderId })
      }
      // Moving to root (remove from folder):
      // MST models use types.optional(types.string, "") so they can't accept null.
      // Use direct HTTP call to send null to the API, then reload to sync MST.
      const env = getEnv<ISDKEnvironment>(store)
      await env.http.patch(`/api/projects/${projectId}`, { folderId: null })
      return store.projectCollection.loadById(projectId)
    },

    // =========================================================================
    // Folder Actions
    // =========================================================================

    /**
     * Create a folder
     */
    createFolder: async (
      name: string,
      workspaceId: string,
      parentId: string | null
    ) => {
      // Build input without null values - MST models use types.optional(types.string, "")
      // for parentId, so null causes MST validation errors during optimistic updates
      const input: Record<string, any> = { name, workspaceId }
      if (parentId) {
        input.parentId = parentId
      }
      return store.folderCollection.create(input)
    },

    /**
     * Update a folder
     */
    updateFolder: async (folderId: string, changes: { name?: string }) => {
      return store.folderCollection.update(folderId, changes)
    },

    /**
     * Delete a folder
     */
    deleteFolder: async (folderId: string) => {
      return store.folderCollection.delete(folderId)
    },

    // =========================================================================
    // Invitation Actions
    // =========================================================================

    /**
     * Accept an invitation and create membership.
     * Pass invitationData when the invitation was loaded outside the
     * collection (e.g. received invitations fetched by email) so the
     * action has the data needed for membership creation.
     */
    acceptInvitation: async (
      invitationId: string,
      userId: string,
      invitationData?: { workspaceId: string; role: string; projectId?: string },
    ) => {
      // Ensure the invitation is in the local collection
      let invitation = store.invitationCollection.get(invitationId)
      if (!invitation) {
        await store.invitationCollection.loadById(invitationId)
        invitation = store.invitationCollection.get(invitationId)
      }

      const data = invitation ?? invitationData
      if (!data) {
        throw new Error("Invitation not found")
      }

      await store.invitationCollection.update(invitationId, {
        status: "accepted",
      })

      await store.memberCollection.create({
        userId,
        workspaceId: data.workspaceId,
        role: data.role as any,
        isBillingAdmin: false,
        ...(data.projectId ? { projectId: data.projectId } : {}),
      })

      return data
    },

    /**
     * Decline an invitation.
     * Loads the invitation into the collection first if not already present.
     */
    declineInvitation: async (invitationId: string) => {
      if (!store.invitationCollection.get(invitationId)) {
        await store.invitationCollection.loadById(invitationId)
      }
      return store.invitationCollection.update(invitationId, {
        status: "declined",
      })
    },

    // =========================================================================
    // Notification Actions
    // =========================================================================

    /**
     * Mark a notification as read
     */
    markNotificationRead: async (notificationId: string) => {
      return store.notificationCollection.update(notificationId, {
        readAt: Date.now(),
      })
    },

    // =========================================================================
    // Starred Project Actions
    // =========================================================================

    /**
     * Toggle star status for a project
     */
    toggleStarProject: async (projectId: string, userId: string, workspaceId?: string) => {
      const existing = store.starredProjectCollection.all.find(
        (s: any) => s.projectId === projectId && s.userId === userId
      )

      if (existing) {
        await store.starredProjectCollection.delete(existing.id)
        return false // unstarred
      } else {
        const wsId = workspaceId
          ?? store.projectCollection.all.find((p: any) => p.id === projectId)?.workspaceId
          ?? ''
        await store.starredProjectCollection.create({
          projectId,
          userId,
          workspaceId: wsId,
        })
        return true // starred
      }
    },

    // =========================================================================
    // Chat Actions
    // =========================================================================

    /**
     * Create a chat session
     */
    createChatSession: async (data: {
      inferredName: string
      contextType: "feature" | "project" | "general"
      contextId?: string
      name?: string
      phase?: string
    }) => {
      return store.chatSessionCollection.create(data)
    },

    /**
     * Add a message to a chat session
     */
    addMessage: async (data: {
      sessionId: string
      role: "user" | "assistant"
      content: string
      imageData?: string
      parts?: string
    }) => {
      return store.chatMessageCollection.create(data)
    },

    /**
     * Record a tool call log
     */
    recordToolCall: async (data: {
      sessionId: string
      toolName: string
      status: "streaming" | "executing" | "complete" | "error"
      args?: unknown
      result?: unknown
      duration?: number
      messageId?: string
    }) => {
      return store.toolCallLogCollection.create({
        chatSessionId: data.sessionId,
        toolName: data.toolName,
        status: data.status,
        args: data.args ? JSON.stringify(data.args) : undefined,
        result: data.result !== undefined ? JSON.stringify(data.result) : undefined,
        duration: data.duration,
        messageId: data.messageId,
      })
    },

    // =========================================================================
    // Member Actions
    // =========================================================================

    /**
     * Update a member's role
     */
    updateMemberRole: async (
      memberId: string,
      newRole: "owner" | "admin" | "member" | "viewer",
      _currentUserId: string
    ) => {
      return store.memberCollection.update(memberId, { role: newRole })
    },

    /**
     * Remove a member from workspace/project
     */
    removeMember: async (memberId: string, _currentUserId: string) => {
      return store.memberCollection.delete(memberId)
    },

    /**
     * Send an invitation
     */
    sendInvitation: async (data: {
      email: string
      role: "owner" | "admin" | "member" | "viewer"
      workspaceId?: string
      projectId?: string
    }) => {
      return store.invitationCollection.create({
        ...data,
        status: "pending",
        emailStatus: "not_sent",
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
      })
    },

    /**
     * Cancel/revoke an invitation
     */
    cancelInvitation: async (invitationId: string) => {
      return store.invitationCollection.update(invitationId, {
        status: "cancelled",
      })
    },

    // =========================================================================
    // Workspace Management Actions
    // =========================================================================

    /**
     * Delete workspace — members, projects, etc. are cascade-deleted by the DB.
     * Do NOT delete members before the workspace: the API beforeDelete hook
     * verifies the caller is still an owner/member, so removing your own
     * membership first causes a 400 "Access denied".
     */
    deleteWorkspaceWithMembers: async (workspaceId: string) => {
      return store.workspaceCollection.delete(workspaceId)
    },

    // =========================================================================
    // Billing Actions
    // =========================================================================

    /**
     * Create a Stripe checkout session and return the redirect URL
     */
    createCheckoutSession: async (params: {
      workspaceId: string
      planId: string
      billingInterval: "monthly" | "annual"
      userEmail?: string
    }) => {
      const env = getEnv<ISDKEnvironment>(store)
      const res = await env.http.post<{ url?: string }>("/api/billing/checkout", params)
      return res.data
    },

    /**
     * Create a Stripe billing portal session and return the redirect URL
     */
    createPortalSession: async (workspaceId: string, returnUrl?: string) => {
      const env = getEnv<ISDKEnvironment>(store)
      const res = await env.http.post<{ url?: string }>(
        `/api/billing/portal?workspaceId=${encodeURIComponent(workspaceId)}`,
        returnUrl ? { returnUrl } : {},
      )
      return res.data
    },
  }
}

// Note: useDomainActions() React hook has been moved to @shogo/shared-app/domain
// to avoid circular dependency. Import it from there:
// import { useDomainActions } from '@shogo/shared-app/domain'
