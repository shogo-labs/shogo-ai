// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddle endpoints (live audio in channels and DMs). Mounted onto the
 * conversations router, so per-conversation writes reach the workspace's home
 * region through the normal session routing.
 */

import type { Hono } from 'hono'
import { CHAT_RATE_LIMITS, takeRateLimit } from '../lib/chat-limits'
import { huddlesEnabled } from '../lib/livekit'
import {
  cancelHuddleInvite,
  createHuddleNotesTicket,
  declineHuddle,
  deleteHuddleNotes,
  getHuddle,
  getHuddleJoinRequest,
  getHuddleLink,
  getHuddleLinkInfo,
  getHuddleNotes,
  guestHuddleNotesChunk,
  guestHuddleNotesTicket,
  guestLeaveHuddle,
  getHuddleChat,
  inviteToHuddle,
  joinHuddle,
  knockOnHuddle,
  leaveHuddle,
  listActiveHuddles,
  muteHuddleParticipant,
  postHuddleNotesChunk,
  removeHuddleParticipant,
  resolveHuddleRequest,
  setHuddleNotes,
} from '../services/huddle.service'
import { closePoll, postHuddlePoll, postHuddleQuestion, setQuestionAnswered, voteOnMessage } from '../services/conversation-polls.service'

export interface HuddleRouteHelpers {
  /** The signed-in user, or null: the join link works for people without an account. */
  optionalUser?: (c: any) => Promise<string | null>
  requireUser: (c: any) => Promise<string | Response>
  requireWorkspace: (c: any) => Promise<{ userId: string; workspaceId: string } | Response>
  errorResponse: (c: any, err: unknown) => Response
}

export function mountHuddleRoutes(router: Hono, h: HuddleRouteHelpers): void {
  router.get('/workspaces/:workspaceId/huddles', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    if (!huddlesEnabled()) return c.json({ enabled: false, huddles: [] })
    return c.json({ enabled: true, huddles: await listActiveHuddles(auth.workspaceId, auth.userId) })
  })

  router.get('/conversations/:conversationId/huddle', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    if (!huddlesEnabled()) return c.json({ enabled: false, huddle: null })
    try {
      return c.json({ enabled: true, huddle: await getHuddle(c.req.param('conversationId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/join', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const limit = CHAT_RATE_LIMITS.huddleJoin
    const result = await takeRateLimit(`huddle-join:${userId}`, limit.max, limit.windowMs)
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds))
      return c.json({ error: { code: 'rate_limited', message: 'Slow down a little and try again in a moment.' } }, 429)
    }
    try {
      return c.json(await joinHuddle(c.req.param('conversationId'), userId))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/leave', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ huddle: await leaveHuddle(c.req.param('conversationId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/invite', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const limit = CHAT_RATE_LIMITS.huddleInvite
    const result = await takeRateLimit(`huddle-invite:${userId}`, limit.max, limit.windowMs)
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds))
      return c.json({ error: { code: 'rate_limited', message: 'Slow down a little and try again in a moment.' } }, 429)
    }
    const body = (await c.req.json().catch(() => null)) as { userIds?: unknown } | null
    const userIds = Array.isArray(body?.userIds) ? body.userIds.filter((id): id is string => typeof id === 'string') : []
    try {
      return c.json({ huddle: await inviteToHuddle(c.req.param('conversationId'), userId, userIds) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.get('/conversations/:conversationId/huddle/chat', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ chat: await getHuddleChat(c.req.param('conversationId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/invite/:userId/cancel', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ huddle: await cancelHuddleInvite(c.req.param('conversationId'), userId, c.req.param('userId')) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/decline', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ huddle: await declineHuddle(c.req.param('conversationId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })
  const tooFast = (c: any, retryAfterSeconds: number) => {
    c.header('Retry-After', String(retryAfterSeconds))
    return c.json({ error: { code: 'rate_limited', message: 'Slow down a little and try again in a moment.' } }, 429)
  }
  const bodyOf = async (c: any): Promise<Record<string, unknown>> => ((await c.req.json().catch(() => null)) as Record<string, unknown> | null) ?? {}
  const clientIp = (c: any): string => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown'
  /**
   * One live-audio chunk, in any of the shapes the recorders use: a raw WAV with
   * `x-live-seq`, multipart `audio` + `seq`, or JSON with base64 `audio`.
   */
  const readChunk = async (c: any): Promise<{ audio: Buffer; seq: number } | null> => {
    const contentType = c.req.header('content-type') || ''
    const headerSeq = Number(c.req.header('x-live-seq'))
    let audio: Buffer
    let seq: number
    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData()
      const file = form.get('audio')
      if (!file || typeof file === 'string') return null
      audio = Buffer.from(await (file as File).arrayBuffer())
      seq = Number(form.get('seq'))
    } else if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
      audio = Buffer.from(await c.req.arrayBuffer())
      seq = headerSeq
    } else {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
      seq = Number(body?.seq ?? headerSeq)
      audio = typeof body?.audio === 'string' ? Buffer.from(body.audio, 'base64') : Buffer.alloc(0)
    }
    if (!audio.length || !Number.isInteger(seq) || seq < 0) return null
    return { audio, seq }
  }

  // ─── Moderation ──────────────────────────────────────────────────────────

  router.post('/conversations/:conversationId/huddle/mute', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await bodyOf(c)
    if (typeof body.userId !== 'string' || !body.userId) return c.json({ error: { code: 'invalid_request', message: 'Pick someone to mute' } }, 400)
    try {
      return c.json(await muteHuddleParticipant(c.req.param('conversationId'), userId, body.userId))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/remove', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await bodyOf(c)
    if (typeof body.userId !== 'string' || !body.userId) return c.json({ error: { code: 'invalid_request', message: 'Pick someone to remove' } }, 400)
    try {
      return c.json({ huddle: await removeHuddleParticipant(c.req.param('conversationId'), userId, body.userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // ─── Link and knock to join ──────────────────────────────────────────────

  router.post('/conversations/:conversationId/huddle/link', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await bodyOf(c)
    try {
      return c.json(await getHuddleLink(c.req.param('conversationId'), userId, { rotate: body.rotate === true }))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  for (const decision of ['admit', 'deny'] as const) {
    router.post(`/conversations/:conversationId/huddle/requests/:requestId/${decision}`, async (c) => {
      const userId = await h.requireUser(c)
      if (userId instanceof Response) return userId
      try {
        return c.json({ huddle: await resolveHuddleRequest(c.req.param('conversationId'), userId, c.req.param('requestId'), decision) })
      } catch (err) {
        return h.errorResponse(c, err)
      }
    })
  }

  // Public: guests have no account, so these answer to the link or request id alone.
  router.get('/huddle-links/:token', async (c) => {
    if (!huddlesEnabled()) return c.json({ enabled: false, live: false })
    const limit = CHAT_RATE_LIMITS.huddleKnock
    const limited = await takeRateLimit(`huddle-link-info:${clientIp(c)}`, limit.max * 3, limit.windowMs)
    if (!limited.allowed) return tooFast(c, limited.retryAfterSeconds)
    try {
      const userId = (await h.optionalUser?.(c)) ?? null
      return c.json({ enabled: true, ...(await getHuddleLinkInfo(c.req.param('token'), userId)) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/huddle-links/:token/knock', async (c) => {
    if (!huddlesEnabled()) return c.json({ error: { code: 'huddles_disabled', message: 'Huddles are not set up on this server' } }, 400)
    const token = c.req.param('token')
    const userId = (await h.optionalUser?.(c)) ?? null
    const caller = userId ?? clientIp(c)
    const perCaller = CHAT_RATE_LIMITS.huddleKnock
    const byCaller = await takeRateLimit(`huddle-knock:${caller}`, perCaller.max, perCaller.windowMs)
    if (!byCaller.allowed) return tooFast(c, byCaller.retryAfterSeconds)
    const perLink = CHAT_RATE_LIMITS.huddleKnockPerLink
    const byLink = await takeRateLimit(`huddle-knock-link:${token.slice(0, 64)}`, perLink.max, perLink.windowMs)
    if (!byLink.allowed) return tooFast(c, byLink.retryAfterSeconds)
    const body = await bodyOf(c)
    try {
      return c.json(await knockOnHuddle(token, { userId, guestName: typeof body.name === 'string' ? body.name : null }))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.get('/huddle-links/requests/:requestId', async (c) => {
    const limit = CHAT_RATE_LIMITS.huddleKnock
    const limited = await takeRateLimit(`huddle-request-poll:${clientIp(c)}`, limit.max * 12, limit.windowMs)
    if (!limited.allowed) return tooFast(c, limited.retryAfterSeconds)
    try {
      const userId = (await h.optionalUser?.(c)) ?? null
      return c.json(await getHuddleJoinRequest(c.req.param('requestId'), userId))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/huddle-links/requests/:requestId/leave', async (c) => {
    try {
      await guestLeaveHuddle(c.req.param('requestId'))
      return c.json({ ok: true })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // ─── Notes (transcript + auto summary) ───────────────────────────────────

  router.post('/conversations/:conversationId/huddle/notes/ticket', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const limited = await takeRateLimit(`huddle-notes-ticket:${userId}`, 60, 60_000)
    if (!limited.allowed) return tooFast(c, limited.retryAfterSeconds)
    const body = await bodyOf(c)
    try {
      return c.json(
        await createHuddleNotesTicket(c.req.param('conversationId'), userId, {
          forUserId: typeof body.forUserId === 'string' ? body.forUserId : null,
          client: typeof body.client === 'string' ? body.client : null,
        }),
      )
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/notes', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await bodyOf(c)
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: { code: 'invalid_request', message: 'Say whether notes should be on or off' } }, 400)
    }
    try {
      return c.json({ huddle: await setHuddleNotes(c.req.param('conversationId'), userId, body.enabled) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // Fallback when the audio socket can't run: one short WAV per chunk.
  router.post('/conversations/:conversationId/huddle/notes/chunk', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const limited = await takeRateLimit(`huddle-notes-chunk:${userId}`, 240, 60_000)
    if (!limited.allowed) return tooFast(c, limited.retryAfterSeconds)
    let chunk: { audio: Buffer; seq: number } | null
    try {
      chunk = await readChunk(c)
    } catch {
      chunk = null
    }
    if (!chunk) return c.json({ error: { code: 'invalid_chunk', message: 'Could not read the live audio chunk' } }, 400)
    const forUserId = c.req.header('x-notes-for') || c.req.query('forUserId') || null
    const client = c.req.header('x-client-platform') || null
    try {
      return c.json(await postHuddleNotesChunk(c.req.param('conversationId'), userId, { ...chunk, forUserId, client }))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // Public twins for a guest: their admitted request id is their credential.
  router.post('/huddle-links/requests/:requestId/notes/ticket', async (c) => {
    const limited = await takeRateLimit(`huddle-guest-notes-ticket:${clientIp(c)}`, 60, 60_000)
    if (!limited.allowed) return tooFast(c, limited.retryAfterSeconds)
    try {
      return c.json(await guestHuddleNotesTicket(c.req.param('requestId')))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/huddle-links/requests/:requestId/notes/chunk', async (c) => {
    const limited = await takeRateLimit(`huddle-guest-notes-chunk:${clientIp(c)}`, 240, 60_000)
    if (!limited.allowed) return tooFast(c, limited.retryAfterSeconds)
    let chunk: { audio: Buffer; seq: number } | null
    try {
      chunk = await readChunk(c)
    } catch {
      chunk = null
    }
    if (!chunk) return c.json({ error: { code: 'invalid_chunk', message: 'Could not read the live audio chunk' } }, 400)
    try {
      return c.json(await guestHuddleNotesChunk(c.req.param('requestId'), chunk))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.get('/huddles/:huddleId/notes', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json(await getHuddleNotes(c.req.param('huddleId'), userId))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.delete('/huddles/:huddleId/notes', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      await deleteHuddleNotes(c.req.param('huddleId'), userId)
      return c.json({ ok: true })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // ─── Polls and Q&A (in the huddle thread) ────────────────────────────────

  router.post('/conversations/:conversationId/huddle/polls', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ message: await postHuddlePoll(c.req.param('conversationId'), userId, await bodyOf(c)) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversations/:conversationId/huddle/questions', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ message: await postHuddleQuestion(c.req.param('conversationId'), userId, await bodyOf(c)) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversation-messages/:messageId/vote', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const limit = CHAT_RATE_LIMITS.vote
    const limited = await takeRateLimit(`vote:${userId}`, limit.max, limit.windowMs)
    if (!limited.allowed) return tooFast(c, limited.retryAfterSeconds)
    const body = await bodyOf(c)
    try {
      return c.json({ message: await voteOnMessage(c.req.param('messageId'), userId, body.optionId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversation-messages/:messageId/poll/close', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ message: await closePoll(c.req.param('messageId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversation-messages/:messageId/question/answered', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await bodyOf(c)
    try {
      return c.json({ message: await setQuestionAnswered(c.req.param('messageId'), userId, body.answered !== false) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })
}
