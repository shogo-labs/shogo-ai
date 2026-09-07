// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat Message Feedback Routes
 *
 * Powers the thumbs up/down footer buttons under each completed
 * assistant turn in the mobile/web chat UI. Extends the auto-generated
 * `/api/chat-messages` and `/api/chat-sessions` CRUD with a small,
 * per-message reaction model (`MessageFeedback`) that isn't part of
 * either generated resource's own CRUD contract.
 *
 * The generated routes live in
 * `apps/api/src/generated/chat-message.routes.ts` and
 * `apps/api/src/generated/chat-session.routes.ts` and carry a
 * "DO NOT EDIT" banner, so extension endpoints live here instead —
 * same pattern as `chat-message-edits.ts` (truncate-from /
 * preceding-checkpoint).
 *
 * This file mounts at TWO different prefixes (see `server.ts`):
 *   - `createChatMessageFeedbackRoutes()` at `/api/chat-messages`,
 *     BEFORE the generated router, so Hono matches `/:id/feedback`
 *     here instead of falling through to the generated `/:id`
 *     PATCH/DELETE handlers.
 *   - `createChatSessionFeedbackRoutes()` at `/api/chat-sessions`,
 *     BEFORE the generated router, for the same reason.
 *
 * Endpoints:
 *   - PUT /api/chat-messages/:id/feedback { thumbs: 'up' | 'down' }
 *       Upsert the caller's reaction to the message (one row per
 *       (messageId, userId) — re-tapping the same thumb is a no-op,
 *       tapping the other thumb flips it via the same upsert).
 *
 *   - DELETE /api/chat-messages/:id/feedback
 *       Clear the caller's reaction (re-tapping an already-set thumb
 *       in the UI calls this instead of PUT with the same value).
 *       No-op (still 200) if no feedback row exists.
 *
 *   - GET /api/chat-sessions/:id/feedback
 *       Return the caller's own feedback for every message in the
 *       session, as `{ [messageId]: 'up' | 'down' }`. Powers the
 *       footer's initial thumb state on chat load/reload.
 *
 * Authorization mirrors `chat-message-edits.ts`: workspace membership
 * via the message/session's project, with tunnel-authenticated
 * (desktop bridge) callers skipping the membership check since the
 * tunnel already authoritatively identifies the user.
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

const VALID_THUMBS = new Set(['up', 'down'])

/**
 * PUT/DELETE /:id/feedback — mount at `/api/chat-messages`.
 */
export function createChatMessageFeedbackRoutes(): Hono {
  const router = new Hono()

  router.put('/:id/feedback', async (c) => {
    const auth = getAuth(c)
    if (!auth?.isAuthenticated || !auth.userId) return unauthorized(c)

    const id = c.req.param('id')
    if (!id) {
      return c.json({ error: { code: 'bad_request', message: 'Message id is required' } }, 400)
    }

    let body: any
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const thumbs = body?.thumbs
    if (!VALID_THUMBS.has(thumbs)) {
      return c.json(
        { error: { code: 'bad_request', message: "thumbs must be 'up' or 'down'" } },
        400,
      )
    }

    const message = await prisma.chatMessage.findUnique({
      where: { id },
      include: {
        session: {
          include: {
            project: {
              include: {
                workspace: { include: { members: true } },
              },
            },
          },
        },
      },
    })

    if (!message) {
      return c.json({ error: { code: 'not_found', message: 'Message not found' } }, 404)
    }

    if (!auth.tunnelAuthenticated) {
      const hasAccess = message.session?.project?.workspace?.members?.some(
        (m: any) => m.userId === auth.userId,
      )
      if (!hasAccess) return forbidden(c)
    }

    const feedback = await prisma.messageFeedback.upsert({
      where: { messageId_userId: { messageId: id, userId: auth.userId } },
      create: { messageId: id, userId: auth.userId, thumbs },
      update: { thumbs },
    })

    return c.json({
      ok: true,
      data: {
        messageId: feedback.messageId,
        thumbs: feedback.thumbs,
        createdAt: feedback.createdAt,
        updatedAt: feedback.updatedAt,
      },
    })
  })

  router.delete('/:id/feedback', async (c) => {
    const auth = getAuth(c)
    if (!auth?.isAuthenticated || !auth.userId) return unauthorized(c)

    const id = c.req.param('id')
    if (!id) {
      return c.json({ error: { code: 'bad_request', message: 'Message id is required' } }, 400)
    }

    const message = await prisma.chatMessage.findUnique({
      where: { id },
      include: {
        session: {
          include: {
            project: {
              include: {
                workspace: { include: { members: true } },
              },
            },
          },
        },
      },
    })

    if (!message) {
      return c.json({ error: { code: 'not_found', message: 'Message not found' } }, 404)
    }

    if (!auth.tunnelAuthenticated) {
      const hasAccess = message.session?.project?.workspace?.members?.some(
        (m: any) => m.userId === auth.userId,
      )
      if (!hasAccess) return forbidden(c)
    }

    // deleteMany (not delete) so a missing row is a clean no-op
    // instead of Prisma's P2025 "record not found" throw — the UI
    // calls this to clear a reaction it may or may not have actually
    // persisted yet (e.g. a rapid double-tap).
    await prisma.messageFeedback.deleteMany({
      where: { messageId: id, userId: auth.userId },
    })

    return c.json({ ok: true })
  })

  return router
}

/**
 * GET /:id/feedback — mount at `/api/chat-sessions`.
 */
export function createChatSessionFeedbackRoutes(): Hono {
  const router = new Hono()

  router.get('/:id/feedback', async (c) => {
    const auth = getAuth(c)
    if (!auth?.isAuthenticated || !auth.userId) return unauthorized(c)

    const id = c.req.param('id')
    if (!id) {
      return c.json({ error: { code: 'bad_request', message: 'Session id is required' } }, 400)
    }

    const session = await prisma.chatSession.findUnique({
      where: { id },
      include: {
        project: {
          include: {
            workspace: { include: { members: true } },
          },
        },
      },
    })

    if (!session) {
      return c.json({ error: { code: 'not_found', message: 'Chat session not found' } }, 404)
    }

    if (!auth.tunnelAuthenticated) {
      const hasAccess = (session as any).project?.workspace?.members?.some(
        (m: any) => m.userId === auth.userId,
      )
      if (!hasAccess) return forbidden(c)
    }

    const rows = await prisma.messageFeedback.findMany({
      where: {
        userId: auth.userId,
        message: { sessionId: id },
      },
      select: { messageId: true, thumbs: true },
    })

    const feedback: Record<string, string> = {}
    for (const row of rows) {
      feedback[row.messageId] = row.thumbs
    }

    return c.json({ ok: true, feedback })
  })

  return router
}
