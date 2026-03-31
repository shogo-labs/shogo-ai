// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BillingAccount Hooks
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
 * Hooks for BillingAccount routes
 */
export interface BillingAccountHooks {
  /** Called before listing records. Can modify where/include. */
  beforeList?: (ctx: HookContext) => Promise<HookResult<{ where?: any; include?: any; orderBy?: any }> | void>
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
 * Default BillingAccount hooks (customize as needed)
 */
export const billingAccountHooks: BillingAccountHooks = {
  /**
   * Filter billing accounts by workspaceId - user must have access
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
      // Return billing accounts for all accessible workspaces
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
   * Verify user has access to the billing account via workspace membership
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const billingAccount = await ctx.prisma.billingAccount.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!billingAccount) {
      return {
        ok: false,
        error: { code: "not_found", message: "Billing account not found" },
      }
    }

    const hasAccess = billingAccount.workspace?.members?.some((m: any) => m.userId === userId)
    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user can create billing accounts in the target workspace (owner/admin only)
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

    // Verify user has admin access to this workspace
    const membership = await ctx.prisma.member.findFirst({
      where: { userId, workspaceId },
    })

    if (!membership) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this workspace" },
      }
    }

    if (membership.role !== 'owner' && membership.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can manage billing" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to update the billing account (owner/admin only)
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const billingAccount = await ctx.prisma.billingAccount.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!billingAccount) {
      return {
        ok: false,
        error: { code: "not_found", message: "Billing account not found" },
      }
    }

    const member = billingAccount.workspace?.members?.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner' && member.role !== 'admin') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners and admins can manage billing" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user has access to delete the billing account (owner only)
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const billingAccount = await ctx.prisma.billingAccount.findUnique({
      where: { id },
      include: {
        workspace: {
          include: { members: true },
        },
      },
    })

    if (!billingAccount) {
      return {
        ok: false,
        error: { code: "not_found", message: "Billing account not found" },
      }
    }

    const member = billingAccount.workspace?.members?.find((m: any) => m.userId === userId)
    if (!member) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    if (member.role !== 'owner') {
      return {
        ok: false,
        error: { code: "forbidden", message: "Only workspace owners can delete billing accounts" },
      }
    }

    return { ok: true }
  },
}
