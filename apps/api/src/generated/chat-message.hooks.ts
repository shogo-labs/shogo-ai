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
   * Filter chat messages by sessionId and verify user has access
   * 
   * IMPORTANT: We explicitly set include: undefined to prevent Prisma from returning
   * the session relation as a nested object. The frontend MST model expects session
   * to be a reference (just an ID), not a full object.
   */
  beforeList: async (ctx) => {
    const sessionId = ctx.query.sessionId
    const userId = ctx.userId

    if (!sessionId) {
      return {
        ok: false,
        error: {
          code: "bad_request",
          message: "sessionId query param required",
        },
      }
    }

    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Verify user owns this session via project workspace membership
    const session = await ctx.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        project: {
          include: {
            workspace: {
              include: { members: true },
            },
          },
        },
      },
    })

    if (!session) {
      return {
        ok: false,
        error: { code: "not_found", message: "Chat session not found" },
      }
    }

    // Check if user is a member of the project's workspace
    const hasAccess = session.project?.workspace?.members?.some(
      (m: any) => m.userId === userId
    )

    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied to this chat session" },
      }
    }

    return {
      ok: true,
      data: {
        where: { sessionId },
        // Explicitly no include - MST expects session as ID reference, not nested object
        include: undefined,
        orderBy: { createdAt: 'asc' },
      },
    }
  },

  /**
   * Verify user has access to the chat message's session
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const message = await ctx.prisma.chatMessage.findUnique({
      where: { id },
      include: {
        session: {
          include: {
            project: {
              include: {
                workspace: {
                  include: { members: true },
                },
              },
            },
          },
        },
      },
    })

    if (!message) {
      return {
        ok: false,
        error: { code: "not_found", message: "Message not found" },
      }
    }

    const hasAccess = message.session?.project?.workspace?.members?.some(
      (m: any) => m.userId === userId
    )

    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Access denied" },
      }
    }

    return { ok: true }
  },

  /**
   * Verify user can create messages in this session
   */
  beforeCreate: async (input, ctx) => {
    const sessionId = input.sessionId
    const userId = ctx.userId

    if (!sessionId) {
      return {
        ok: false,
        error: { code: "bad_request", message: "sessionId is required" },
      }
    }

    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Check session access (same as beforeList)
    const session = await ctx.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        project: {
          include: {
            workspace: {
              include: { members: true },
            },
          },
        },
      },
    })

    if (!session) {
      return {
        ok: false,
        error: { code: "not_found", message: "Chat session not found" },
      }
    }

    const hasAccess = session.project?.workspace?.members?.some(
      (m: any) => m.userId === userId
    )

    if (!hasAccess) {
      return {
        ok: false,
        error: { code: "forbidden", message: "Cannot create messages in this session" },
      }
    }

    return { ok: true }
  },

  /**
   * Update session updatedAt when message is created
   * Note: updatedAt has @updatedAt so it auto-updates, but we call update to trigger it
   */
  afterCreate: async (message, ctx) => {
    await ctx.prisma.chatSession.update({
      where: { id: message.sessionId },
      data: { updatedAt: new Date() },
    })
  },
}
