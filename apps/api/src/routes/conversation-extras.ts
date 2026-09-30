// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Daily-driver channel endpoints: chat settings and status, the activity
 * inbox, pins, saved items, drafts, scheduled messages, reminders, custom
 * emoji, and user groups. Mounted onto the conversations router.
 */

import type { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { readConversationFile, verifyConversationFileToken } from '../lib/conversation-files'
import {
  MAX_EMOJI_BYTES,
  createEmoji,
  createGroup,
  deleteEmoji,
  deleteGroup,
  listEmoji,
  listGroups,
  updateGroup,
} from '../services/chat-customization'
import { getChatSettings, listStatuses, updateChatSettings } from '../services/chat-settings'
import { listInbox, markInboxRead } from '../services/chat-inbox'
import {
  cancelScheduled,
  createReminder,
  listDrafts,
  listPins,
  listReminders,
  listSaved,
  listScheduled,
  putDraft,
  scheduleMessage,
  setPinned,
  setSaved,
  updateReminder,
  updateScheduled,
} from '../services/chat-items'

export interface ExtrasHelpers {
  requireUser: (c: any) => Promise<string | Response>
  requireWorkspace: (c: any) => Promise<{ userId: string; workspaceId: string } | Response>
  errorResponse: (c: any, err: unknown) => Response
  readJson: (c: any) => Promise<Record<string, any>>
}

export function mountConversationExtras(router: Hono, h: ExtrasHelpers): void {
  // ─── Settings + status ──────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/chat-settings', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ settings: await getChatSettings(auth.workspaceId, auth.userId) })
  })

  router.patch('/workspaces/:workspaceId/chat-settings', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    try {
      return c.json({ settings: await updateChatSettings(auth.workspaceId, auth.userId, await h.readJson(c)) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/statuses', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    const ids = (c.req.query('userIds') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500)
    return c.json({ statuses: await listStatuses(auth.workspaceId, ids.length ? ids : undefined) })
  })

  // ─── Inbox ──────────────────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/inbox', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    const limit = Number(c.req.query('limit'))
    return c.json(await listInbox(auth.workspaceId, auth.userId, {
      unreadOnly: c.req.query('filter') === 'unread',
      before: c.req.query('before') ?? null,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    }))
  })

  router.post('/workspaces/:workspaceId/inbox/read', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    const body = await h.readJson(c)
    const updated = await markInboxRead(auth.workspaceId, auth.userId, {
      ids: Array.isArray(body.ids) ? body.ids : undefined,
      all: body.all === true,
      conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
      threadRootId: typeof body.threadRootId === 'string' ? body.threadRootId : undefined,
      unread: body.unread === true,
    })
    return c.json({ updated })
  })

  // ─── Pins + saved ───────────────────────────────────────────────────────

  router.post('/conversation-messages/:messageId/pin', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await h.readJson(c)
    try {
      return c.json({ message: await setPinned(c.req.param('messageId'), userId, body.on !== false) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.get('/conversations/:conversationId/pins', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ messages: await listPins(c.req.param('conversationId'), userId) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.post('/conversation-messages/:messageId/save', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await h.readJson(c)
    try {
      return c.json(await setSaved(c.req.param('messageId'), userId, body.on !== false))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/saved', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ items: await listSaved(auth.workspaceId, auth.userId) })
  })

  // ─── Drafts ─────────────────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/drafts', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ drafts: await listDrafts(auth.workspaceId, auth.userId) })
  })

  router.post('/conversations/:conversationId/draft', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await h.readJson(c)
    try {
      const draft = await putDraft(
        c.req.param('conversationId'),
        userId,
        typeof body.text === 'string' ? body.text : '',
        typeof body.threadRootId === 'string' ? body.threadRootId : null,
      )
      return c.json({ draft })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // ─── Scheduled messages ─────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/scheduled', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ scheduled: await listScheduled(auth.workspaceId, auth.userId) })
  })

  router.post('/conversations/:conversationId/scheduled', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await h.readJson(c)
    try {
      const scheduled = await scheduleMessage({
        conversationId: c.req.param('conversationId'),
        userId,
        text: typeof body.text === 'string' ? body.text : '',
        sendAt: body.sendAt,
        threadRootId: typeof body.threadRootId === 'string' ? body.threadRootId : null,
        alsoSentToChannel: body.alsoSentToChannel === true,
      })
      return c.json({ scheduled }, 201)
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.patch('/scheduled-messages/:id', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await h.readJson(c)
    try {
      return c.json({ scheduled: await updateScheduled(c.req.param('id'), userId, { text: body.text, sendAt: body.sendAt }) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.delete('/scheduled-messages/:id', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json(await cancelScheduled(c.req.param('id'), userId))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // ─── Reminders ──────────────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/reminders', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ reminders: await listReminders(auth.workspaceId, auth.userId, { includeDone: c.req.query('all') === '1' }) })
  })

  router.post('/workspaces/:workspaceId/reminders', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    const body = await h.readJson(c)
    try {
      const reminder = await createReminder({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        text: typeof body.text === 'string' ? body.text : undefined,
        remindAt: body.remindAt,
        command: typeof body.command === 'string' ? body.command : undefined,
        messageId: typeof body.messageId === 'string' ? body.messageId : null,
      })
      return c.json({ reminder }, 201)
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.patch('/reminders/:id', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    const body = await h.readJson(c)
    try {
      return c.json({ reminder: await updateReminder(c.req.param('id'), userId, { status: body.status, remindAt: body.remindAt }) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // ─── User groups ────────────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/user-groups', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ groups: await listGroups(auth.workspaceId) })
  })

  router.post('/workspaces/:workspaceId/user-groups', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    try {
      return c.json({ group: await createGroup(auth.workspaceId, auth.userId, await h.readJson(c)) }, 201)
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.patch('/user-groups/:groupId', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json({ group: await updateGroup(c.req.param('groupId'), userId, await h.readJson(c)) })
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.delete('/user-groups/:groupId', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json(await deleteGroup(c.req.param('groupId'), userId))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  // ─── Custom emoji ───────────────────────────────────────────────────────

  router.get('/workspaces/:workspaceId/emoji', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    return c.json({ emoji: await listEmoji(auth.workspaceId) })
  })

  router.post('/workspaces/:workspaceId/emoji', async (c) => {
    const auth = await h.requireWorkspace(c)
    if (auth instanceof Response) return auth
    try {
      const form = await c.req.formData().catch(() => null)
      const file = form?.get('file')
      if (!file || typeof file === 'string') {
        return c.json({ error: { code: 'invalid_file', message: 'Attach an image in the "file" field' } }, 400)
      }
      if (file.size > MAX_EMOJI_BYTES) {
        return c.json({ error: { code: 'too_large', message: 'Emoji images must be 256 KB or smaller' } }, 413)
      }
      const emoji = await createEmoji(auth.workspaceId, auth.userId, {
        name: form?.get('name'),
        bytes: new Uint8Array(await file.arrayBuffer()),
        mimeType: file.type,
      })
      return c.json({ emoji }, 201)
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.delete('/custom-emoji/:emojiId', async (c) => {
    const userId = await h.requireUser(c)
    if (userId instanceof Response) return userId
    try {
      return c.json(await deleteEmoji(c.req.param('emojiId'), userId))
    } catch (err) {
      return h.errorResponse(c, err)
    }
  })

  router.get('/custom-emoji/:emojiId', async (c) => {
    const id = c.req.param('emojiId')
    if (!verifyConversationFileToken(`emoji:${id}`, c.req.query('t'))) {
      return c.json({ error: { code: 'forbidden', message: 'Invalid emoji link' } }, 403)
    }
    const row = await (prisma as any).customEmoji.findUnique({ where: { id } })
    if (!row) return c.json({ error: { code: 'not_found', message: 'Emoji not found' } }, 404)
    try {
      const file = await readConversationFile(row.storageKey)
      if (file.kind === 'redirect') return c.redirect(file.url, 302)
      return new Response(file.bytes as any, {
        headers: {
          'Content-Type': row.mimeType,
          'Content-Length': String(file.bytes.byteLength),
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return c.json({ error: { code: 'not_found', message: 'Emoji not found' } }, 404)
    }
  })
}
