/**
 * Route Hooks - Custom business logic for generated routes
 *
 * This file contains hook implementations that add business logic
 * to the auto-generated CRUD routes.
 */

import type { RouteHooksConfig } from "./routes"
import type { ModelHooks, RouteHookContext, HookResult } from "@shogo/state-api/generators"

// ============================================================================
// Workspace Hooks
// ============================================================================

const workspaceHooks: ModelHooks = {
  /**
   * Filter workspaces by user membership when userId is provided
   */
  beforeList: async (ctx) => {
    const userId = ctx.query.userId
    if (!userId) {
      return { ok: true }
    }

    // Filter workspaces where user has a membership
    return {
      ok: true,
      data: {
        where: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    }
  },

  /**
   * After creating a workspace, create the owner membership
   */
  afterCreate: async (workspace, ctx) => {
    const ownerId = ctx.body.ownerId || ctx.userId
    if (!ownerId) {
      console.warn("[Workspace] No ownerId provided, skipping owner membership creation")
      return
    }

    await ctx.prisma.member.create({
      data: {
        userId: ownerId,
        workspaceId: workspace.id,
        role: "owner",
      },
    })
  },
}

// ============================================================================
// Project Hooks
// ============================================================================

const projectHooks: ModelHooks = {
  /**
   * Filter projects to only those the user has access to via workspace membership.
   * Include workspace and folder in list responses.
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Filter by workspaceId if provided, otherwise show all accessible projects
    const workspaceId = ctx.query.workspaceId

    if (workspaceId) {
      // Verify user has access to this workspace
      const membership = await ctx.prisma.member.findFirst({
        where: { userId, workspaceId },
      })

      if (!membership) {
        return {
          ok: false,
          error: { code: "forbidden", message: "Access denied to this workspace" },
        }
      }

      return {
        ok: true,
        data: {
          where: { workspaceId },
          include: { workspace: true, folder: true },
        },
      }
    }

    // No workspaceId provided - return projects from all workspaces user is a member of
    return {
      ok: true,
      data: {
        where: {
          workspace: {
            members: {
              some: { userId },
            },
          },
        },
        include: { workspace: true, folder: true },
      },
    }
  },

  /**
   * Verify user has access to the project's workspace before returning
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Get project and check workspace membership
    const project = await ctx.prisma.project.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })

    if (!project) {
      return {
        ok: false,
        error: { code: "not_found", message: "Project not found" },
      }
    }

    const hasAccess = project.workspace.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this project" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user can create projects in the target workspace
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const workspaceId = input.workspaceId
    if (!workspaceId) {
      return {
        ok: false,
        error: { code: "bad_request", message: "workspaceId is required" },
      }
    }

    // Verify user has access to create in this workspace (member or higher)
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, workspaceId },
    })

    if (!membership) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    return { ok: true }
  },
}

// ============================================================================
// Folder Hooks
// ============================================================================

const folderHooks: ModelHooks = {
  /**
   * Filter folders to only those in workspaces the user has access to.
   * Include parent and workspace in list responses.
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const workspaceId = ctx.query.workspaceId

    if (workspaceId) {
      // Verify user has access to this workspace
      const membership = await ctx.prisma.member.findFirst({
        where: { userId, workspaceId },
      })

      if (!membership) {
        return {
          ok: false,
          error: { code: "forbidden", message: "Access denied to this workspace" },
        }
      }

      return {
        ok: true,
        data: {
          where: { workspaceId },
          include: { parent: true, workspace: true },
        },
      }
    }

    // No workspaceId - return folders from all accessible workspaces
    return {
      ok: true,
      data: {
        where: {
          workspace: {
            members: {
              some: { userId },
            },
          },
        },
        include: { parent: true, workspace: true },
      },
    }
  },
}

// ============================================================================
// StarredProject Hooks
// ============================================================================

const starredProjectHooks: ModelHooks = {
  /**
   * Before creating a star, check if it already exists
   */
  beforeCreate: async (input, ctx) => {
    const existing = await ctx.prisma.starredProject.findFirst({
      where: {
        userId: input.userId,
        projectId: input.projectId,
      },
    })

    if (existing) {
      // Return the existing record instead of creating a new one
      // This is handled specially - we return ok: false but with a specific code
      return {
        ok: false,
        error: {
          code: "already_starred",
          message: "Project is already starred",
        },
      }
    }

    return { ok: true }
  },

  /**
   * Filter starred projects by userId
   */
  beforeList: async (ctx) => {
    const userId = ctx.query.userId
    if (!userId) {
      return {
        ok: false,
        error: {
          code: "missing_user_id",
          message: "userId query param required",
        },
      }
    }

    return {
      ok: true,
      data: {
        where: { userId },
      },
    }
  },
}

// ============================================================================
// Member Hooks
// ============================================================================

const memberHooks: ModelHooks = {
  /**
   * Include user info in list responses
   */
  beforeList: async (ctx) => {
    return {
      ok: true,
      data: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
      },
    }
  },

  /**
   * Before deleting a member, check if they're the last owner
   */
  beforeDelete: async (id, ctx) => {
    const member = await ctx.prisma.member.findUnique({
      where: { id },
    })

    if (!member) {
      return {
        ok: false,
        error: { code: "not_found", message: "Member not found" },
      }
    }

    // If deleting an owner, ensure there's at least one other owner
    if (member.role === "owner" && member.workspaceId) {
      const otherOwners = await ctx.prisma.member.count({
        where: {
          workspaceId: member.workspaceId,
          role: "owner",
          id: { not: id },
        },
      })

      if (otherOwners === 0) {
        return {
          ok: false,
          error: {
            code: "last_owner",
            message: "Cannot remove the last owner of a workspace",
          },
        }
      }
    }

    return { ok: true }
  },
}

// ============================================================================
// Invitation Hooks
// ============================================================================

const invitationHooks: ModelHooks = {
  /**
   * Set default expiration and status for new invitations
   */
  beforeCreate: async (input, ctx) => {
    // Set default expiration (7 days)
    if (!input.expiresAt) {
      input.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    }

    // Set default status
    if (!input.status) {
      input.status = "pending"
    }

    // Set invitedBy if not provided
    if (!input.invitedBy && ctx.userId) {
      input.invitedBy = ctx.userId
    }

    // Check for existing pending invitation
    const existing = await ctx.prisma.invitation.findFirst({
      where: {
        email: input.email?.toLowerCase(),
        workspaceId: input.workspaceId,
        status: "pending",
      },
    })

    if (existing) {
      return {
        ok: false,
        error: {
          code: "invitation_exists",
          message: "An invitation for this email is already pending",
        },
      }
    }

    // Normalize email
    if (input.email) {
      input.email = input.email.toLowerCase()
    }

    return { ok: true, data: input }
  },

  /**
   * Include workspace info in list responses
   */
  beforeList: async (ctx) => {
    return {
      ok: true,
      data: {
        include: {
          workspace: true,
        },
      },
    }
  },
}

// ============================================================================
// Notification Hooks
// ============================================================================

const notificationHooks: ModelHooks = {
  /**
   * Filter notifications by userId
   */
  beforeList: async (ctx) => {
    const userId = ctx.query.userId || ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: {
          code: "missing_user_id",
          message: "userId required",
        },
      }
    }

    return {
      ok: true,
      data: {
        where: { userId },
      },
    }
  },
}

// ============================================================================
// Subscription Hooks
// ============================================================================

const subscriptionHooks: ModelHooks = {
  /**
   * Filter subscriptions by workspaceId - user must have access
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const workspaceId = ctx.query.workspaceId
    if (!workspaceId) {
      // Without workspaceId, return subscriptions for all accessible workspaces
      return {
        ok: true,
        data: {
          where: {
            workspace: {
              members: { some: { userId } },
            },
          },
          include: { workspace: true },
        },
      }
    }

    // Verify user has access to this workspace
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, workspaceId },
    })

    if (!membership) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    return {
      ok: true,
      data: {
        where: { workspaceId },
        include: { workspace: true },
      },
    }
  },

  /**
   * Include workspace in get response - verify access
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Get subscription and verify workspace access
    const subscription = await ctx.prisma.subscription.findUnique({
      where: { id },
      include: { workspace: { include: { members: true } } },
    })

    if (!subscription) {
      return {
        ok: false,
        error: { code: "not_found", message: "Subscription not found" },
      }
    }

    const hasAccess = subscription.workspace.members.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return {
      ok: true,
      data: { include: { workspace: true } },
    }
  },
}

// ============================================================================
// CreditLedger Hooks
// ============================================================================

const creditLedgerHooks: ModelHooks = {
  /**
   * Filter credit ledgers by workspaceId - user must have access
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const workspaceId = ctx.query.workspaceId
    if (!workspaceId) {
      // Return credit ledgers for all accessible workspaces
      return {
        ok: true,
        data: {
          where: {
            workspace: {
              members: { some: { userId } },
            },
          },
          include: { workspace: true },
        },
      }
    }

    // Verify user has access to this workspace
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, workspaceId },
    })

    if (!membership) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    return {
      ok: true,
      data: {
        where: { workspaceId },
        include: { workspace: true },
      },
    }
  },
}

// ============================================================================
// UsageEvent Hooks
// ============================================================================

const usageEventHooks: ModelHooks = {
  /**
   * Filter usage events by workspaceId - user must have access
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const { workspaceId, projectId, memberId } = ctx.query
    const where: Record<string, any> = {}

    if (workspaceId) {
      // Verify user has access to this workspace
      const membership = await ctx.prisma.member.findFirst({
        where: { userId, workspaceId },
      })

      if (!membership) {
        return {
          ok: false,
          error: { code: "forbidden", message: "Access denied to this workspace" },
        }
      }
      where.workspaceId = workspaceId
    } else {
      // Filter to accessible workspaces only
      where.workspace = {
        members: { some: { userId } },
      }
    }

    if (projectId) where.projectId = projectId
    if (memberId) where.memberId = memberId

    return {
      ok: true,
      data: {
        where,
        include: { workspace: true, project: true },
        orderBy: { createdAt: 'desc' },
      },
    }
  },
}

// ============================================================================
// ChatSession Hooks
// ============================================================================

const chatSessionHooks: ModelHooks = {
  /**
   * Filter chat sessions by contextType and contextId (projectId)
   */
  beforeList: async (ctx) => {
    const { contextType, contextId, projectId } = ctx.query
    const where: Record<string, any> = {}

    if (contextType) where.contextType = contextType
    if (contextId) where.contextId = contextId
    if (projectId) where.contextId = projectId

    return {
      ok: true,
      data: {
        where,
        include: {
          project: true,
        },
        orderBy: { lastActiveAt: 'desc' },
      },
    }
  },

  /**
   * Set default values for new chat sessions
   */
  beforeCreate: async (input, ctx) => {
    // Set default inferred name if not provided
    if (!input.inferredName) {
      input.inferredName = input.name || 'New Chat'
    }

    // Set default context type
    if (!input.contextType) {
      input.contextType = 'general'
    }

    return { ok: true, data: input }
  },
}

// ============================================================================
// ChatMessage Hooks
// ============================================================================

const chatMessageHooks: ModelHooks = {
  /**
   * Filter messages by sessionId
   */
  beforeList: async (ctx) => {
    const sessionId = ctx.query.sessionId
    if (!sessionId) {
      return {
        ok: false,
        error: {
          code: "missing_session_id",
          message: "sessionId query param required",
        },
      }
    }

    return {
      ok: true,
      data: {
        where: { sessionId },
        include: { session: true },
        orderBy: { createdAt: 'asc' },
      },
    }
  },

  /**
   * Update session lastActiveAt when message is created
   */
  afterCreate: async (message, ctx) => {
    await ctx.prisma.chatSession.update({
      where: { id: message.sessionId },
      data: { lastActiveAt: new Date() },
    })
  },
}

// ============================================================================
// ToolCallLog Hooks
// ============================================================================

const toolCallLogHooks: ModelHooks = {
  /**
   * Filter tool calls by chatSessionId or messageId
   */
  beforeList: async (ctx) => {
    const { chatSessionId, messageId } = ctx.query
    const where: Record<string, any> = {}

    if (chatSessionId) where.chatSessionId = chatSessionId
    if (messageId) where.messageId = messageId

    if (!chatSessionId && !messageId) {
      return {
        ok: false,
        error: {
          code: "missing_filter",
          message: "chatSessionId or messageId query param required",
        },
      }
    }

    return {
      ok: true,
      data: {
        where,
        include: { chatSession: true },
        orderBy: { createdAt: 'asc' },
      },
    }
  },
}

// ============================================================================
// Export Combined Hooks Config
// ============================================================================

export const routeHooks: RouteHooksConfig = {
  // Studio-Core
  Workspace: workspaceHooks,
  Project: projectHooks,
  Folder: folderHooks,
  StarredProject: starredProjectHooks,
  Member: memberHooks,
  Invitation: invitationHooks,
  Notification: notificationHooks,
  // Billing
  Subscription: subscriptionHooks,
  CreditLedger: creditLedgerHooks,
  UsageEvent: usageEventHooks,
  // Studio-Chat
  ChatSession: chatSessionHooks,
  ChatMessage: chatMessageHooks,
  ToolCallLog: toolCallLogHooks,
}

export default routeHooks
