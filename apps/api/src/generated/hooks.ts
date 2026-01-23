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
   * Include workspace and folder in list responses
   */
  beforeList: async (ctx) => {
    return {
      ok: true,
      data: {
        include: {
          workspace: true,
          folder: true,
        },
      },
    }
  },
}

// ============================================================================
// Folder Hooks
// ============================================================================

const folderHooks: ModelHooks = {
  /**
   * Include parent and workspace in list responses
   */
  beforeList: async (ctx) => {
    return {
      ok: true,
      data: {
        include: {
          parent: true,
          workspace: true,
        },
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
// Export Combined Hooks Config
// ============================================================================

export const routeHooks: RouteHooksConfig = {
  Workspace: workspaceHooks,
  Project: projectHooks,
  Folder: folderHooks,
  StarredProject: starredProjectHooks,
  Member: memberHooks,
  Invitation: invitationHooks,
  Notification: notificationHooks,
}

export default routeHooks
