// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat Session Fork Route
 *
 * Powers the "Fork conversation from here" footer button under a
 * completed assistant turn. Clones the source session's messages up
 * to and including a given `messageId` into a brand-new
 * `ChatSession`, so the user can branch the conversation without
 * mutating (or losing) the original thread.
 *
 * Extends `/api/chat-sessions` the same way `chat-message-edits.ts`
 * extends `/api/chat-messages` — mounted BEFORE the generated router
 * in `server.ts` so Hono matches `/:id/fork` here instead of falling
 * through to the generated `/:id` PATCH/DELETE handlers in
 * `chat-session.routes.ts`.
 *
 * Endpoint:
 *   POST /api/chat-sessions/:id/fork { messageId: string }
 *     - Verifies `messageId` belongs to session `:id`.
 *     - Creates a new ChatSession mirroring the source's
 *       contextType/contextId/workspaceId/phase (a fresh chat in the
 *       same project/workspace) and, for workspace-scoped sessions,
 *       the same attached-project set.
 *     - Clones every message with `createdAt <= target.createdAt`
 *       (inclusive — the fork point itself carries over) as brand-new
 *       rows (new ids, same content/role/parts/agent/model/createdAt)
 *       so the forked session's history reads identically up to the
 *       branch point.
 *     - Deliberately does NOT carry over `claudeCodeSessionId`,
 *       `worktreeBranch`/`worktreeStatus`/`worktreePath`, or the
 *       cached context/token counters — those are runtime state
 *       scoped to the ORIGINAL session's live agent process / worktree,
 *       not something a fresh forked session should inherit.
 *     - Returns `{ ok: true, sessionId, messageCount }` — the client
 *       switches to the new session via `chatSessionEvents` (see
 *       `fork-api.ts` in `packages/shared-app`).
 *
 * Authorization mirrors `chat-message-edits.ts` / `chat-message-feedback.ts`:
 * workspace membership via the session's project OR (for
 * workspace-scoped sessions) its workspace directly, with
 * tunnel-authenticated (desktop bridge) callers skipping the check.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'

type AuthContext = {
  userId?: string
  tunnelAuthenticated?: boolean
  isAuthenticated?: boolean
}

function getAuth(c: any): AuthContext | undefined {
  return c.get('auth') as AuthContext | undefined
}

function unauthorized(c: any) {
  return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
}

function forbidden(c: any) {
  return c.json({ error: { code: 'forbidden', message: 'Access denied to this chat session' } }, 403)
}

export function createChatSessionForkRoutes(): Hono {
  const router = new Hono()

  router.post('/:id/fork', async (c) => {
    const auth = getAuth(c)
    if (!auth?.isAuthenticated || !auth.userId) return unauthorized(c)

    const id = c.req.param('id')
    if (!id) {
      return c.json({ error: { code: 'bad_request', message: 'Session id is required' } }, 400)
    }

    let body: any
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const messageId = body?.messageId
    if (!messageId || typeof messageId !== 'string') {
      return c.json({ error: { code: 'bad_request', message: 'messageId is required' } }, 400)
    }

    const session = await prisma.chatSession.findUnique({
      where: { id },
      include: {
        project: { include: { workspace: { include: { members: true } } } },
        workspace: { include: { members: true } },
        attachedProjects: true,
      },
    })

    if (!session) {
      return c.json({ error: { code: 'not_found', message: 'Chat session not found' } }, 404)
    }

    if (!auth.tunnelAuthenticated) {
      const hasAccess =
        session.project?.workspace?.members?.some((m: any) => m.userId === auth.userId) ||
        session.workspace?.members?.some((m: any) => m.userId === auth.userId)
      if (!hasAccess) return forbidden(c)
    }

    const targetMessage = await prisma.chatMessage.findUnique({ where: { id: messageId } })
    if (!targetMessage || targetMessage.sessionId !== id) {
      return c.json(
        { error: { code: 'not_found', message: 'Message not found in this session' } },
        404,
      )
    }

    const messagesToClone = await prisma.chatMessage.findMany({
      where: { sessionId: id, createdAt: { lte: targetMessage.createdAt } },
      orderBy: { createdAt: 'asc' },
    })

    const result = await prisma.$transaction(async (tx) => {
      const newSession = await tx.chatSession.create({
        data: {
          name: session.name ? `${session.name} (fork)` : null,
          inferredName: `${session.inferredName} (fork)`,
          contextType: session.contextType,
          contextId: session.contextId,
          workspaceId: session.workspaceId,
          phase: session.phase,
        },
      })

      if (messagesToClone.length > 0) {
        await tx.chatMessage.createMany({
          data: messagesToClone.map((m) => ({
            sessionId: newSession.id,
            role: m.role,
            content: m.content,
            imageData: m.imageData,
            parts: m.parts,
            agent: m.agent,
            model: m.model,
            createdAt: m.createdAt,
          })),
        })
      }

      // Workspace-scoped sessions mount one or more attached projects
      // (see ChatSessionProject) — carry the same attach set over so
      // the forked session's runtime mounts the same project roots.
      if (session.attachedProjects.length > 0) {
        await tx.chatSessionProject.createMany({
          data: session.attachedProjects.map((ap: any) => ({
            sessionId: newSession.id,
            projectId: ap.projectId,
            attachMode: ap.attachMode,
          })),
        })
      }

      return newSession
    })

    return c.json(
      { ok: true, sessionId: result.id, messageCount: messagesToClone.length },
      201,
    )
  })

  return router
}
