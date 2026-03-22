// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Notification Hooks
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
 * Hooks for Notification routes
 */
export interface NotificationHooks {
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
 * Default Notification hooks (customize as needed)
 */
export const notificationHooks: NotificationHooks = {
  /**
   * Filter notifications by current user only - don't allow viewing other users' notifications
   */
  beforeList: async (ctx) => {
    const requestedUserId = ctx.query.userId
    const currentUserId = ctx.userId

    if (!currentUserId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Force filter by current user only - security check
    if (requestedUserId && requestedUserId !== currentUserId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Can only view your own notifications" },
      }
    }

    return {
      ok: true,
      data: {
        where: { userId: currentUserId },
      },
    }
  },

  /**
   * Verify user owns the notification before returning it
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const notification = await ctx.prisma.notification.findUnique({
      where: { id },
    })

    if (!notification) {
      return {
        ok: false,
        error: { code: "not_found", message: "Notification not found" },
      }
    }

    if (notification.userId !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user owns the notification before updating it
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const notification = await ctx.prisma.notification.findUnique({
      where: { id },
    })

    if (!notification) {
      return {
        ok: false,
        error: { code: "not_found", message: "Notification not found" },
      }
    }

    if (notification.userId !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    // Don't allow changing the userId
    if (input.userId && input.userId !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Cannot change notification owner" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user owns the notification before deleting it
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const notification = await ctx.prisma.notification.findUnique({
      where: { id },
    })

    if (!notification) {
      return {
        ok: false,
        error: { code: "not_found", message: "Notification not found" },
      }
    }

    if (notification.userId !== userId) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },
}
