/**
 * ChatSession Hooks
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
 * Hooks for ChatSession routes
 */
export interface ChatSessionHooks {
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
 * Default ChatSession hooks (customize as needed)
 */
export const chatSessionHooks: ChatSessionHooks = {
  /**
   * Filter chat sessions by contextId or id query parameters.
   * The frontend calls /api/v2/chat-sessions?contextId=xxx to load sessions for a project.
   */
  beforeList: async (ctx) => {
    const where: any = {}
    
    // Support filtering by contextId (project ID)
    if (ctx.query.contextId) {
      where.contextId = ctx.query.contextId
    }
    
    // Support filtering by contextType
    if (ctx.query.contextType) {
      where.contextType = ctx.query.contextType
    }
    
    // Support filtering by id
    if (ctx.query.id) {
      where.id = ctx.query.id
    }
    
    return { ok: true, data: { where } }
  },
}
