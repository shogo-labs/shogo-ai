// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatMessage Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import { externalizeMessageAttachments } from "../lib/chat-attachments"
import type { Principal } from "../lib/authz"
import { authorizeChatSession, CHAT_SESSION_SCOPE_SELECT } from "./chat-session.hooks"

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
 * Hooks for ChatMessage routes
 */
export interface ChatMessageHooks {
  /** Called before listing records. Can modify where/include/orderBy. */
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
 * Default ChatMessage hooks (customize as needed)
 */
export const chatMessageHooks: ChatMessageHooks = {
  /**
   * Filter chat messages by sessionId and verify user has access.
   *
   * Honored query params (beyond sessionId):
   *   - `agent` — either "technical" or "voice". When present, the where
   *              clause is narrowed to rows authored by that agent, so
   *              the technical ChatPanel and Shogo Mode overlay never
   *              read each other's rows even though they share a
   *              ChatSession.
   *
   * IMPORTANT: We explicitly set include: undefined to prevent Prisma
   * from returning the session relation as a nested object. The
   * frontend MST model expects session to be a reference (just an ID),
   * not a full object.
   */
  beforeList: async (ctx) => {
    const sessionId = ctx.query.sessionId
    const userId = ctx.userId
    const agent = ctx.query.agent

    if (!sessionId) {
      return {
        ok: false,
        error: {
          code: "bad_request",
          message: "sessionId query param required",
        },
      }
    }

    if (agent !== undefined && agent !== "technical" && agent !== "voice") {
      return {
        ok: false,
        error: {
          code: "bad_request",
          message: "agent must be 'technical' or 'voice' when present",
        },
      }
    }

    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const session = await ctx.prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: CHAT_SESSION_SCOPE_SELECT,
    })

    if (!session) {
      return {
        ok: false,
        error: { code: "not_found", message: "Chat session not found" },
      }
    }

    // Tunnel-authenticated requests skip local membership checks
    if (!ctx.tunnelAuthenticated) {
      const access = await authorizeChatSession(ctx, session, "Access denied to this chat session")
      if (!access.ok) return access
    }

    const where: Record<string, unknown> = { sessionId }
    if (agent) where.agent = agent

    return {
      ok: true,
      data: {
        where,
        // Explicitly no include - MST expects session as ID reference, not nested object
        include: undefined,
        orderBy: { createdAt: 'desc' },
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

    if (ctx.tunnelAuthenticated) return { ok: true }

    const message = await ctx.prisma.chatMessage.findUnique({
      where: { id },
      select: { session: { select: CHAT_SESSION_SCOPE_SELECT } },
    })

    if (!message) {
      return {
        ok: false,
        error: { code: "not_found", message: "Message not found" },
      }
    }

    return authorizeChatSession(ctx, message.session ?? {}, "Access denied")
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

    if (!ctx.tunnelAuthenticated) {
      const session = await ctx.prisma.chatSession.findUnique({
        where: { id: sessionId },
        select: CHAT_SESSION_SCOPE_SELECT,
      })

      if (!session) {
        return {
          ok: false,
          error: { code: "not_found", message: "Chat session not found" },
        }
      }

      const access = await authorizeChatSession(
        ctx,
        session,
        "Cannot create messages in this session",
        "POST /api/chat-messages",
      )
      if (!access.ok) return access
    }

    const externalized = await externalizeMessageAttachments(
      sessionId,
      input.parts,
      input.imageData,
    )
    if (!externalized.changed) return { ok: true }
    return {
      ok: true,
      data: {
        ...input,
        parts: externalized.parts,
        imageData: externalized.imageData,
      },
    }
  },

  /**
   * Require write access to the message's session (project:update for
   * project sessions)
   */
  beforeUpdate: async (id, input, ctx) => {
    const existing = await ctx.prisma.chatMessage.findUnique({
      where: { id },
      select: { sessionId: true, session: { select: CHAT_SESSION_SCOPE_SELECT } },
    })
    if (!existing) {
      return {
        ok: false,
        error: { code: "not_found", message: "Message not found" },
      }
    }

    if (!ctx.tunnelAuthenticated) {
      const op = `PATCH /api/chat-messages/${id}`
      const access = await authorizeChatSession(ctx, existing.session ?? {}, "Access denied", op)
      if (!access.ok) return access
      if (input.sessionId && input.sessionId !== existing.sessionId) {
        const target = await ctx.prisma.chatSession.findUnique({
          where: { id: input.sessionId },
          select: CHAT_SESSION_SCOPE_SELECT,
        })
        if (!target) {
          return {
            ok: false,
            error: { code: "not_found", message: "Chat session not found" },
          }
        }
        const targetAccess = await authorizeChatSession(ctx, target, "Access denied", op)
        if (!targetAccess.ok) return targetAccess
      }
    }

    const externalized = await externalizeMessageAttachments(
      input.sessionId || existing.sessionId,
      input.parts,
      input.imageData,
    )
    if (!externalized.changed) return { ok: true }
    return {
      ok: true,
      data: {
        ...input,
        parts: externalized.parts,
        imageData: externalized.imageData,
      },
    }
  },

  /**
   * Update session lastActiveAt/updatedAt and project lastMessageAt when
   * message is created. `lastActiveAt` is what the chat history sidebar
   * uses to bucket sessions into Today / Yesterday / Last 7 days / etc.,
   * so bumping it here keeps those dividers reflecting the most recent
   * message rather than the session's creation time.
   */
  afterCreate: async (message, ctx) => {
    const now = new Date()
    await ctx.prisma.chatSession.update({
      where: { id: message.sessionId },
      data: { lastActiveAt: now, updatedAt: now },
    })

    const session = await ctx.prisma.chatSession.findUnique({
      where: { id: message.sessionId },
      select: { contextId: true, contextType: true },
    })
    if (session?.contextId && session.contextType === 'project') {
      await ctx.prisma.project.update({
        where: { id: session.contextId },
        data: { lastMessageAt: now },
      }).catch(() => {})
    }
  },
}
