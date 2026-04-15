// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ToolCallLog Hooks
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
  tunnelAuthenticated?: boolean
  prisma: any
}

/**
 * Hooks for ToolCallLog routes
 */
export interface ToolCallLogHooks {
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
 * Default ToolCallLog hooks (customize as needed)
 */
export const toolCallLogHooks: ToolCallLogHooks = {
  /**
   * Filter tool call logs by chatSessionId or messageId and verify access
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const { chatSessionId, messageId } = ctx.query
    const where: Record<string, any> = {}

    if (chatSessionId) where.chatSessionId = chatSessionId
    if (messageId) where.messageId = messageId

    if (!chatSessionId && !messageId) {
      return {
        ok: false,
        error: {
          code: "bad_request",
          message: "chatSessionId or messageId query param required",
        },
      }
    }

    // Verify user has access to the chat session
    if (chatSessionId && !ctx.tunnelAuthenticated) {
      const session = await ctx.prisma.chatSession.findUnique({
        where: { id: chatSessionId },
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
          error: { code: "forbidden", message: "Access denied to this chat session" },
        }
      }
    }

    return {
      ok: true,
      data: {
        where,
        include: { chatSession: true },
        orderBy: { createdAt: 'asc' },
      },
    }
  },

  /**
   * Verify user has access to the tool call log via chat session
   */
  beforeGet: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    if (ctx.tunnelAuthenticated) return { ok: true }

    const toolCall = await ctx.prisma.toolCallLog.findUnique({
      where: { id },
      include: {
        chatSession: {
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

    if (!toolCall) {
      return {
        ok: false,
        error: { code: "not_found", message: "Tool call log not found" },
      }
    }

    const hasAccess = toolCall.chatSession?.project?.workspace?.members?.some(
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
}
