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
import { purgeChatSessionHistory, type DeletedChatScope } from "../services/chat-session-history-purge.service"

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
export const CHAT_SESSION_SCOPE_SELECT = {
  contextType: true,
  contextId: true,
  workspaceId: true,
  createdByUserId: true,
} as const

export type ChatSessionScope = {
  contextType?: string | null
  contextId?: string | null
  workspaceId?: string | null
  createdByUserId?: string | null
}

/** A chat with an owner is personal. Ownerless chats stay shared. */
export function isForeignOwnedChat(
  session: { createdByUserId?: string | null } | null | undefined,
  userId: string | undefined,
): boolean {
  return Boolean(session?.createdByUserId && session.createdByUserId !== userId)
}

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
  if (isForeignOwnedChat(session, ctx.userId)) {
    return { ok: false, error: { code: "not_found", message: "Chat session not found" } }
  }
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
        AND: [
          {
            workspace: {
              ...(pinned ? { id: principal.workspaceId ?? "" } : {}),
              members: { some: { userId: ctx.userId, projectId: null } },
            },
          },
          { OR: [{ createdByUserId: ctx.userId }, { createdByUserId: null }] },
        ],
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

  const access = await authorizeChatSession(ctx, session, "Access denied", writeOp)
  // The row is gone by `afterDelete`, which is where the runtime's copy is
  // wiped; hand the scope back so the delete can remember where to look.
  return access.ok ? { ...access, data: session } : access
}

/**
 * Scope captured in `beforeDelete`, read in `afterDelete`: by then the row is
 * gone, so the runtime that holds the transcript could no longer be found.
 * Keyed by the delete request's hook context, so nothing outlives the request.
 */
const pendingHistoryPurge = new WeakMap<object, Omit<DeletedChatScope, "id">>()

function rememberScopeForPurge(ctx: HookContext, scope: ChatSessionScope | null | undefined): void {
  if (!scope) return
  pendingHistoryPurge.set(ctx, {
    contextType: scope.contextType ?? null,
    contextId: scope.contextId ?? null,
    workspaceId: scope.workspaceId ?? null,
  })
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

    // The client never chooses the owner. Personal workspace-agent chats
    // belong to the caller. Project-anchored sessions stay shared.
    delete input.createdByUserId
    if (input.contextType === "workspace" && !input.contextId) {
      input.createdByUserId = userId
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

    // Ownership is assigned at creation. A client cannot move a chat to
    // someone else or clear it and make a personal chat shared.
    if (input && typeof input === "object") delete input.createdByUserId

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

    if (ctx.tunnelAuthenticated) {
      const session = (await ctx.prisma.chatSession.findUnique({
        where: { id },
        select: CHAT_SESSION_SCOPE_SELECT,
      })) as ChatSessionScope | null
      rememberScopeForPurge(ctx, session)
      return { ok: true }
    }

    const access = await authorizeExistingSession(id, ctx, `DELETE /api/chat-sessions/${id}`)
    if (access.ok) rememberScopeForPurge(ctx, access.data as ChatSessionScope | undefined)
    return access
  },

  afterDelete: cleanupDeletedSession,
}

/**
 * The purge resolves a runtime URL, which can create or wake one. The DELETE
 * must not wait on that: past this deadline the purge is left to finish on its
 * own and the request returns.
 */
const PURGE_WAIT_MS = 6_000

async function purgeWithinDeadline(id: string, scope: Omit<DeletedChatScope, "id">): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[chatSession.afterDelete] history purge for ${id} is still resolving; leaving it to finish on its own`)
      resolve()
    }, PURGE_WAIT_MS)
    ;(timer as any).unref?.()
  })
  try {
    await Promise.race([purgeChatSessionHistory({ id, ...scope }).then(() => undefined), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Everything a delete has to do after the row is gone, shared by the cloud and
 * local hook sets so the desktop track cannot quietly lose the transcript wipe
 * (it did once: `local-routes.ts` never installed any ChatSession hooks).
 */
async function cleanupDeletedSession(id: string, ctx: HookContext): Promise<void> {
  try {
    await deleteChatAttachmentPrefix(id)
  } catch (error: any) {
    // Database deletion has already succeeded; cleanup is best-effort and
    // can be retried by the storage maintenance job.
    console.warn(`[chatSession.afterDelete] attachment cleanup failed for ${id}:`, error?.message || error)
  }

  // The runtime's sessions.db is the durable copy (S3-synced), so deleting the
  // row is not enough — idle eviction no longer wipes it, by design (SHO-137).
  // Best-effort: never fails the delete.
  const scope = pendingHistoryPurge.get(ctx)
  pendingHistoryPurge.delete(ctx)
  await purgeWithinDeadline(id, scope ?? {})
}

/**
 * Local/desktop hook set (SHO-137).
 *
 * `createLocalGeneratedRoutes()` builds the CRUD surface without the cloud hook
 * aggregator, so it has to install this explicitly — otherwise a deleted chat
 * keeps its transcript in the local `sessions.db`. Local mode has no cloud
 * authz to apply here, so `beforeDelete` only records the scope the purge
 * needs; authorization stays exactly what it was before this hook existed.
 */
export const localChatSessionHooks: ChatSessionHooks = {
  beforeDelete: async (id, ctx) => {
    const session = (await ctx.prisma.chatSession.findUnique({
      where: { id },
      select: CHAT_SESSION_SCOPE_SELECT,
    })) as ChatSessionScope | null
    rememberScopeForPurge(ctx, session)
  },
  afterDelete: cleanupDeletedSession,
}
