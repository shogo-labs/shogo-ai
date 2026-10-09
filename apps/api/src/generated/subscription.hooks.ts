// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Subscription Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import type { Permission } from "@shogo/authz"
import type { Principal } from "../lib/authz"
import { hookAccess, hookAuthorize, hookRequire } from "../lib/authz/hooks"

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
  tunnelAuthenticated?: boolean
  auth?: Principal
  prisma: any
}

/**
 * Require `permission` on the workspace while keeping this resource's error
 * messages. Admins lost billing management under RBAC, so their denials go
 * through the enforcement mode instead of failing outright.
 */
async function requireWorkspacePermission(
  ctx: HookContext,
  workspaceId: string,
  permission: Permission,
  roleMessage: string,
  where: string,
  nonMemberMessage = "Access denied",
): Promise<HookResult | null> {
  const access = await hookAccess(ctx, { workspaceId })
  if (access.permissions.has(permission)) return null
  if (!access.workspaceRole) {
    return { ok: false, error: { code: "forbidden", message: nonMemberMessage } }
  }
  if (permission === "workspace.billing:manage" && access.workspaceRole === "admin") {
    if (!(await hookAuthorize(ctx, permission, { workspaceId }, where))) return null
  }
  return { ok: false, error: { code: "forbidden", message: roleMessage } }
}

/**
 * Hooks for Subscription routes
 */
export interface SubscriptionHooks {
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
              members: { some: { userId, projectId: null } },
            },
          },
          include: { workspace: true },
          orderBy: { createdAt: 'desc' },
        },
      }
    }

    const denied = await hookRequire(ctx, "workspace:read", { workspaceId })
    if (denied) {
      return {
        ok: false,
        error: { code: denied.error.code, message: "Access denied to this workspace" },
      }
    }

    return {
      ok: true,
      data: {
        where: { workspaceId },
        include: { workspace: true },
        orderBy: { createdAt: 'desc' },
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

    const subscription = await ctx.prisma.subscription.findUnique({
      where: { id },
      select: { workspaceId: true },
    })

    if (!subscription) {
      return {
        ok: false,
        error: { code: "not_found", message: "Subscription not found" },
      }
    }

    const denied = await hookRequire(ctx, "workspace:read", { workspaceId: subscription.workspaceId })
    if (denied) {
      return {
        ok: false,
        error: { code: denied.error.code, message: "Access denied" },
      }
    }

    return {
      ok: true,
      data: { include: { workspace: true } },
    }
  },

  /**
   * Verify user has access to update the subscription (workspace.billing:manage)
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
      select: { workspaceId: true },
    })

    if (!subscription) {
      return {
        ok: false,
        error: { code: "not_found", message: "Subscription not found" },
      }
    }

    const denied = await requireWorkspacePermission(
      ctx,
      subscription.workspaceId,
      "workspace.billing:manage",
      "Only workspace owners and billing admins can manage subscriptions",
      `PATCH /api/subscriptions/${id}`,
    )
    if (denied) return denied

    return { ok: true }
  },

  /**
   * Verify user has access to delete the subscription (workspace:delete)
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
      select: { workspaceId: true },
    })

    if (!subscription) {
      return {
        ok: false,
        error: { code: "not_found", message: "Subscription not found" },
      }
    }

    const denied = await requireWorkspacePermission(
      ctx,
      subscription.workspaceId,
      "workspace:delete",
      "Only workspace owners can delete subscriptions",
      `DELETE /api/subscriptions/${id}`,
    )
    if (denied) return denied

    return { ok: true }
  },
}
