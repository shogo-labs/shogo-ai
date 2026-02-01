/**
 * CreditLedger Hooks
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
 * Hooks for CreditLedger routes
 */
export interface CreditLedgerHooks {
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
 * Default CreditLedger hooks (customize as needed)
 */
export const creditLedgerHooks: CreditLedgerHooks = {
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

  /**
   * Verify user has access to the credit ledger via workspace membership
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const ledger = await ctx.prisma.creditLedger.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!ledger) {
      return {
        ok: false,
        error: { code: "not_found", message: "Credit ledger entry not found" },
      }
    }

    const hasAccess = ledger.workspace?.members?.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to update the credit ledger (owner/admin only)
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const ledger = await ctx.prisma.creditLedger.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!ledger) {
      return {
        ok: false,
        error: { code: "not_found", message: "Credit ledger entry not found" },
      }
    }

    const member = ledger.workspace?.members?.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can modify credit ledger" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the credit ledger (owner only)
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const ledger = await ctx.prisma.creditLedger.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!ledger) {
      return {
        ok: false,
        error: { code: "not_found", message: "Credit ledger entry not found" },
      }
    }

    const member = ledger.workspace?.members?.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners can delete credit ledger entries" },
      }
    }

    return { ok: true }
  },
}
