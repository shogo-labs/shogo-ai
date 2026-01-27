/**
 * ChatMessage Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import type { RouteHookContext, HookResult } from "@shogo/sdk"

/**
 * Hook context with Prisma client
 */
export interface HookContext extends RouteHookContext {
  prisma: any
}

/**
 * Hooks for ChatMessage routes
 */
export interface ChatMessageHooks {
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
 * Default ChatMessage hooks (customize as needed)
 */
export const chatMessageHooks: ChatMessageHooks = {
  // beforeList: async (ctx) => {
  //   // Filter by user membership
  //   return { ok: true, data: { where: { userId: ctx.userId } } }
  // },
  // beforeCreate: async (input, ctx) => {
  //   // Set userId on create
  //   return { ok: true, data: { ...input, userId: ctx.userId } }
  // },
}
