// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import {
  CHAT_ATTACHMENT_PREFIX,
  getChatAttachmentReadUrl,
  verifyAttachmentToken,
} from '../lib/chat-attachments'
import { readConversationFileStream, wantsInlineBytes } from '../lib/conversation-files'

/**
 * Attachment URLs are capability URLs. Image/video elements and native image
 * loaders cannot reliably attach the normal session credential, so the HMAC
 * query token is the credential for this read-only redirect.
 *
 * A script fetch cannot follow that redirect across origins — the bucket's
 * wildcard ACAO is refused for a credentialed request — so for those the bytes
 * are streamed back through the API instead.
 */
export function chatAttachmentRoutes(): Hono {
  const router = new Hono()

  router.get('/chat-attachments/:key{.+}', async (c) => {
    const rawKey = c.req.param('key')
    const key = rawKey.startsWith(CHAT_ATTACHMENT_PREFIX)
      ? rawKey
      : decodeURIComponent(rawKey)
    const token = c.req.query('t')

    if (!key.startsWith(CHAT_ATTACHMENT_PREFIX) || !verifyAttachmentToken(key, token)) {
      return c.json({ error: { code: 'forbidden', message: 'Invalid attachment token' } }, 403)
    }

    try {
      if (wantsInlineBytes(c)) {
        const stream = await readConversationFileStream(key)
        return new Response(stream.body as any, {
          headers: {
            'Content-Type': stream.contentType ?? 'application/octet-stream',
            ...(stream.contentLength !== null ? { 'Content-Length': String(stream.contentLength) } : {}),
            'Cache-Control': 'private, max-age=300',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
      const url = await getChatAttachmentReadUrl(key)
      return c.redirect(url, 302)
    } catch (error: any) {
      console.error('[ChatAttachments] Failed to create read URL:', error?.message || error)
      return c.json({ error: { code: 'not_found', message: 'Attachment not found' } }, 404)
    }
  })

  return router
}
