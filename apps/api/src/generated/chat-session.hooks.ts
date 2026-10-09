// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatSession Hooks
 *
 * Customize business logic for CRUD operations.
 * This file is safe to edit - it will not be overwritten.
 */

import { deleteChatAttachmentPrefix } from "../lib/chat-attachments"
import { accessibleProjectsWhere, type Principal } from "../lib/authz"
import { hookAuthorize, hookPrincipal, hookRequire, type HookDenial } from "../lib/authz/hooks"

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
 * Hooks for ChatSession routes
 */
export interface ChatSessionHooks {
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

/** The fields that decide which scope a chat session belongs to. */
export const CHAT_SESSION_SCOPE_SELECT = { contextId: true, workspaceId: true } as const

export type ChatSessionScope = { contextId?: string | null; workspaceId?: string | null }

function withForbiddenMessage(denied: HookDenial | null, message: string): HookResult | null {
  if (!denied) return null
  return denied.error.code === "forbidden" ? { ok: false, error: { code: "forbidden", message } } : denied
}

/**
 * Authorize access to a chat session. Project sessions (contextId) need
 * project:read, or project:update when `writeOp` is given; workspace-level
 * sessions need workspace:read.
 */
export async function authorizeChatSession(
  ctx: HookContext,
  session: ChatSessionScope,
  forbiddenMessage: string,
  writeOp?: string,
): Promise<HookResult> {
  if (session.contextId) {
    const scope = { projectId: session.contextId }
    const denied = writeOp
      ? await hookAuthorize(ctx, "project:update", scope, writeOp)
      : await hookRequire(ctx, "project:read", scope)
    return withForbiddenMessage(denied, forbiddenMessage) ?? { ok: true }
  }
  if (session.workspaceId) {
    const denied = await hookRequire(ctx, "workspace:read", { workspaceId: session.workspaceId })
    return withForbiddenMessage(denied, forbiddenMessage) ?? { ok: true }
  }
  return { ok: false, error: { code: "forbidden", message: forbiddenMessage } }
}

/**
 * Prisma `where` on ChatSession selecting the sessions the caller can read:
 * sessions of readable projects, plus workspace-level sessions (e.g. the
 * personal companion home chat) in workspaces the caller is a member of.
 */
export async function accessibleChatSessionsWhere(ctx: HookContext): Promise<Record<string, unknown>> {
  const principal = hookPrincipal(ctx)
  const pinned = principal.via === "apiKey" || principal.via === "runtimeToken"
  return {
    OR: [
      { project: await accessibleProjectsWhere(principal) },
      {
        workspace: {
          ...(pinned ? { id: principal.workspaceId ?? "" } : {}),
          members: { some: { userId: ctx.userId, projectId: null } },
        },
      },
    ],
  }
}

async function authorizeExistingSession(
  id: string,
  ctx: HookContext,
  writeOp?: string,
): Promise<HookResult> {
  const session = await ctx.prisma.chatSession.findUnique({
    where: { id },
    select: CHAT_SESSION_SCOPE_SELECT,
  })

  if (!session) {
    return {
      ok: false,
      error: { code: "not_found", message: "Chat session not found" },
    }
  }

  return authorizeChatSession(ctx, session, "Access denied", writeOp)
}

/**
 * Default ChatSession hooks (customize as needed)
 */
export const chatSessionHooks: ChatSessionHooks = {
  /**
   * Filter chat sessions by contextType and contextId (projectId), verify project access
   */
  beforeList: async (ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    const { contextType, contextId, projectId } = ctx.query
    let where: Record<string, any> = {}

    if (contextType) where.contextType = contextType
    if (contextId) where.contextId = contextId
    if (projectId) where.contextId = projectId

    // If projectId is specified, verify user has access to that project
    if (projectId || contextId) {
      if (!ctx.tunnelAuthenticated) {
        const denied = await hookRequire(ctx, "project:read", { projectId: projectId || contextId })
        const rejected = withForbiddenMessage(denied, "Access denied to this project")
        if (rejected) return rejected
      }
    } else if (!ctx.tunnelAuthenticated) {
      where = { AND: [where, await accessibleChatSessionsWhere(ctx)] }
    }

    return {
      ok: true,
      data: {
        where,
        include: {
          project: true,
        },
        orderBy: { updatedAt: 'desc' },
      },
    }
  },

  /**
   * Require project:read (project sessions) or workspace:read (workspace sessions)
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

    return authorizeExistingSession(id, ctx)
  },

  /**
   * Require project:update on the target project (or workspace:read for
   * workspace-level sessions)
   */
  beforeCreate: async (input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    // Set default inferred name if not provided
    if (!input.inferredName) {
      input.inferredName = input.name || 'New Chat'
    }

    // Set default context type
    if (!input.contextType) {
      input.contextType = 'general'
    }

    if ((input.contextId || input.workspaceId) && !ctx.tunnelAuthenticated) {
      const access = await authorizeChatSession(
        ctx,
        input,
        "Cannot create sessions in this project",
        "POST /api/chat-sessions",
      )
      if (!access.ok) return access
    }

    return { ok: true, data: input }
  },

  /**
   * Require project:update (or workspace:read for workspace-level sessions)
   */
  beforeUpdate: async (id, input, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    if (ctx.tunnelAuthenticated) return { ok: true }

    const op = `PATCH /api/chat-sessions/${id}`
    const access = await authorizeExistingSession(id, ctx, op)
    if (!access.ok) return access

    // Moving a session also needs write access to where it lands.
    if (input?.contextId || input?.workspaceId) {
      const target = await authorizeChatSession(ctx, input, "Access denied", op)
      if (!target.ok) return target
    }

    return { ok: true }
  },

  /**
   * Require project:update (or workspace:read for workspace-level sessions)
   */
  beforeDelete: async (id, ctx) => {
    const userId = ctx.userId
    if (!userId) {
      return {
        ok: false,
        error: { code: "unauthorized", message: "Authentication required" },
      }
    }

    if (ctx.tunnelAuthenticated) return { ok: true }

    return authorizeExistingSession(id, ctx, `DELETE /api/chat-sessions/${id}`)
  },

  afterDelete: async (id) => {
    try {
      await deleteChatAttachmentPrefix(id)
    } catch (error: any) {
      // Database deletion has already succeeded; cleanup is best-effort and
      // can be retried by the storage maintenance job.
      console.warn(`[chatSession.afterDelete] attachment cleanup failed for ${id}:`, error?.message || error)
    }
  },
}
