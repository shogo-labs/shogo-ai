// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatQueuedMessage Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import { dispatchNext } from "../services/chat-queue-dispatcher.service"
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
  tunnelAuthenticated: boolean
  auth?: Principal
  prisma: any
}

/**
 * Hooks for ChatQueuedMessage routes
 */
export interface ChatQueuedMessageHooks {
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
 * Default ChatQueuedMessage hooks (customize as needed)
 */
export const chatQueuedMessageHooks: ChatQueuedMessageHooks = {
  beforeList: async (ctx) => {
    const sessionId = ctx.query.sessionId
    if (!sessionId) {
      return {
        ok: false,
        error: { code: "bad_request", message: "sessionId query param required" },
      }
    }
    const access = await verifySessionAccess(sessionId, ctx)
    if (!access.ok) return access
    return {
      ok: true,
      data: {
        where: { sessionId },
        include: undefined,
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      },
    }
  },
  beforeGet: async (id, ctx) => {
    const row = await ctx.prisma.chatQueuedMessage.findUnique({
      where: { id },
      select: { sessionId: true },
    })
    if (!row) {
      return { ok: false, error: { code: "not_found", message: "Queued message not found" } }
    }
    return verifySessionAccess(row.sessionId, ctx)
  },
  beforeCreate: async (input, ctx) => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : ""
    if (!sessionId) {
      return { ok: false, error: { code: "bad_request", message: "sessionId is required" } }
    }
    const access = await verifySessionAccess(sessionId, ctx, "POST /api/chat-queued-messages")
    if (!access.ok) return access
    if (!ctx.userId) {
      return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
    }
    if (typeof input.content !== "string" || typeof input.body !== "string") {
      return {
        ok: false,
        error: { code: "bad_request", message: "content and body are required" },
      }
    }
    const latest = await ctx.prisma.chatQueuedMessage.findFirst({
      where: { sessionId },
      orderBy: [{ position: "desc" }, { createdAt: "desc" }],
      select: { position: true },
    })
    const externalized = await externalizeMessageAttachments(
      sessionId,
      input.parts,
      undefined,
    )
    return {
      ok: true,
      data: {
        sessionId,
        userId: ctx.userId,
        position: (latest?.position ?? -1) + 1,
        status: "pending",
        content: input.content,
        parts: externalized.changed
          ? externalized.parts
          : typeof input.parts === "string"
            ? input.parts
            : null,
        body: input.body,
        error: null,
      },
    }
  },
  afterCreate: async (record) => {
    void dispatchNext(record.sessionId).catch((error) => {
      console.warn(`[ChatQueue] Failed to dispatch after enqueue ${record.id}:`, error)
    })
  },
  beforeUpdate: async (id, input, ctx) => {
    const row = await ctx.prisma.chatQueuedMessage.findUnique({
      where: { id },
      select: { sessionId: true, status: true },
    })
    if (!row) {
      return { ok: false, error: { code: "not_found", message: "Queued message not found" } }
    }
    const access = await verifySessionAccess(row.sessionId, ctx, `PATCH /api/chat-queued-messages/${id}`)
    if (!access.ok) return access
    if (row.status === "dispatching") {
      return {
        ok: false,
        error: { code: "busy", message: "Queued message is already being dispatched" },
      }
    }
    const data: Record<string, unknown> = {}
    for (const key of ["content", "parts", "body", "error"] as const) {
      if (input[key] !== undefined) data[key] = input[key]
    }
    if (input.status !== undefined) {
      if (input.status !== "pending" && input.status !== "failed") {
        return {
          ok: false,
          error: { code: "bad_request", message: "Only pending and failed are valid queue states" },
        }
      }
      data.status = input.status
      if (input.status === "pending") data.error = null
    }
    if (Object.keys(data).length === 0) {
      return { ok: false, error: { code: "bad_request", message: "No editable fields supplied" } }
    }
    return { ok: true, data }
  },
  afterUpdate: async (record) => {
    if (record.status === "pending") {
      void dispatchNext(record.sessionId).catch((error) => {
        console.warn(`[ChatQueue] Failed to dispatch updated row ${record.id}:`, error)
      })
    }
  },
  beforeDelete: async (id, ctx) => {
    const row = await ctx.prisma.chatQueuedMessage.findUnique({
      where: { id },
      select: { sessionId: true, status: true },
    })
    if (!row) {
      return { ok: false, error: { code: "not_found", message: "Queued message not found" } }
    }
    const access = await verifySessionAccess(row.sessionId, ctx, `DELETE /api/chat-queued-messages/${id}`)
    if (!access.ok) return access
    if (row.status === "dispatching") {
      return {
        ok: false,
        error: { code: "busy", message: "Queued message is already being dispatched" },
      }
    }
    return { ok: true }
  },
  // beforeList: async (ctx) => {
  //   // Query params are automatically added to where clause
  //   // Example: GET /api/projects?workspaceId=123 => where: { workspaceId: "123" }
  //   
  //   // You can override or extend the where clause:
  //   // return { ok: true, data: { where: { ...ctx.query, userId: ctx.userId } } }
  // },
  // beforeCreate: async (input, ctx) => {
  //   // Set userId on create
  //   return { ok: true, data: { ...input, userId: ctx.userId } }
  // },
}

/** Reads need project:read on the session's project; `writeOp` requires project:update. */
export async function verifySessionAccess(
  sessionId: string,
  ctx: HookContext,
  writeOp?: string,
): Promise<HookResult> {
  if (!ctx.userId) {
    return { ok: false, error: { code: "unauthorized", message: "Authentication required" } }
  }
  if (ctx.tunnelAuthenticated) return { ok: true }

  const session = await ctx.prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: CHAT_SESSION_SCOPE_SELECT,
  })
  if (!session) {
    return { ok: false, error: { code: "not_found", message: "Chat session not found" } }
  }
  return authorizeChatSession(ctx, session, "Access denied to this chat session", writeOp)
}
