// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkspaceGrant Hooks
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
  tunnelAuthenticated: boolean
  prisma: any
}

/**
 * Hooks for WorkspaceGrant routes
 */
export interface WorkspaceGrantHooks {
  /**
   * Called before listing records. Can modify where/include/orderBy.
   * Note: Query parameters (except limit, offset, userId, include, orderBy) are automatically
   * added to the where clause. This hook receives them and can override/extend them.
   */
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
 * Default WorkspaceGrant hooks (customize as needed)
 */
/**
 * Grants hand out free seats and included spend, so only super admins may
 * touch them; everyone else manages billing through the admin console.
 */
async function requireSuperAdmin(ctx: HookContext): Promise<HookResult | void> {
  if (!ctx.userId) {
    return { ok: false, error: { code: 'unauthorized', message: 'Authentication required' } }
  }
  const user = await ctx.prisma.user.findUnique({ where: { id: ctx.userId }, select: { role: true } })
  if (user?.role !== 'super_admin') {
    return { ok: false, error: { code: 'forbidden', message: 'Workspace grants are managed by Shogo staff' } }
  }
}

export const workspaceGrantHooks: WorkspaceGrantHooks = {
  beforeList: (ctx) => requireSuperAdmin(ctx),
  beforeGet: (_id, ctx) => requireSuperAdmin(ctx),
  beforeCreate: (_input, ctx) => requireSuperAdmin(ctx),
  beforeUpdate: (_id, _input, ctx) => requireSuperAdmin(ctx),
  beforeDelete: (_id, ctx) => requireSuperAdmin(ctx),
}
