/**
 * ChatMessage Hooks
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
  /**
   * Filter chat messages by sessionId query parameter.
   * The frontend calls /api/v2/chat-messages?sessionId=xxx to load messages for a chat session.
   * 
   * IMPORTANT: We explicitly set include: undefined to prevent Prisma from returning
   * the session relation as a nested object. The frontend MST model expects session
   * to be a reference (just an ID), not a full object.
   */
  beforeList: async (ctx) => {
    const where: any = {}
    
    // Support filtering by sessionId (required for chat history loading)
    if (ctx.query.sessionId) {
      where.sessionId = ctx.query.sessionId
    }
    
    // Support filtering by id (for loading specific messages)
    if (ctx.query.id) {
      where.id = ctx.query.id
    }
    
    // Explicitly exclude relations - MST expects references (IDs), not nested objects
    return { ok: true, data: { where, include: undefined } }
  },
}
