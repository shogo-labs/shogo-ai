/**
 * Subscription Hooks
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
 * Hooks for Subscription routes
 */
export interface SubscriptionHooks {
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
 * Default Subscription hooks (customize as needed)
 */
export const subscriptionHooks: SubscriptionHooks = {
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

  /**
   * Verify user has access to update the subscription (owner/admin only)
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

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

    const member = subscription.workspace.members.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can manage subscriptions" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the subscription (owner only)
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

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

    const member = subscription.workspace.members.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners can delete subscriptions" },
      }
    }

    return { ok: true }
  },
}
