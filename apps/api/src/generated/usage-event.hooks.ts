// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UsageEvent Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

/**
 * Result from a hook that can modify or reject the operation
 */
export interface HookResult<T = any> {
  ok: boolean
  error?: { code: string; message: string }
  data?: T
}

/**
 * Hook context with Prisma client
 */
export interface HookContext {
  body: any
  params: Record<string, string>
  query: Record<string, string>
  userId?: string
  prisma: any
}

/**
 * Hooks for UsageEvent routes
 */
export interface UsageEventHooks {
  /** Called before listing records. Can modify where/include. */
  beforeList?: (ctx: HookContext) => Promise<HookResult<{ where?: any; include?: any }> | void>
  /** Called before getting a single record. Can reject access. */
  beforeGet?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  /** Called before creating a record. Can modify input or reject. */
  beforeCreate?: (input: any, ctx: HookContext) => Promise<HookResult<any> | void>
  /** Called after creating a record. Can perform side effects. */
  afterCreate?: (record: any, ctx: HookContext) => Promise<void>
  /** Called before updating a record. Can modify input or reject. */
  beforeUpdate?: (id: string, input: any, ctx: HookContext) => Promise<HookResult<any> | void>
  /** Called after updating a record. Can perform side effects. */
  afterUpdate?: (record: any, ctx: HookContext) => Promise<void>
  /** Called before deleting a record. Can reject deletion. */
  beforeDelete?: (id: string, ctx: HookContext) => Promise<HookResult | void>
  /** Called after deleting a record. Can perform cleanup. */
  afterDelete?: (id: string, ctx: HookContext) => Promise<void>
}

/**
 * Default UsageEvent hooks (customize as needed)
 */
export const usageEventHooks: UsageEventHooks = {
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

  /**
   * Verify user has access to the usage event via workspace membership
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const event = await ctx.prisma.usageEvent.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!event) {
      return {
        ok: false,
        error: { code: "not_found", message: "Usage event not found" },
      }
    }

    const hasAccess = event.workspace?.members?.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to update the usage event (owner/admin only)
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const event = await ctx.prisma.usageEvent.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!event) {
      return {
        ok: false,
        error: { code: "not_found", message: "Usage event not found" },
      }
    }

    const member = event.workspace?.members?.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can modify usage events" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the usage event (owner only)
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const event = await ctx.prisma.usageEvent.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!event) {
      return {
        ok: false,
        error: { code: "not_found", message: "Usage event not found" },
      }
    }

    const member = event.workspace?.members?.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners can delete usage events" },
      }
    }

    return { ok: true }
  },
}
