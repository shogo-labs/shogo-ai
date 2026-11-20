// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Webhook / HTTP Channel Adapter
 *
 * A generic inbound+outbound webhook channel that lets external services
 * (Zapier, Make, n8n, custom apps) send messages to the agent and receive
 * responses — either synchronously or via async callback URL.
 *
 * Inbound:
 *   POST /agent/channels/webhook/incoming
 *   Body: { "message": "...", "senderId?": "...", "senderName?": "...",
 *           "callbackUrl?": "https://...", "metadata?": {...} }
 *   → Sync mode (no callbackUrl):         200 { reply, correlationId }
 *   → Sync mode (timeout):                202 { status: "pending", correlationId, outboxUrl }
 *   → Async mode (with callbackUrl):      202 { status: "accepted" }
 *
 * Auth:
 *   Every request must include the channel secret in X-Webhook-Secret.
 *   A personal shogo_sk_* API key is NOT needed — the cloud agent-proxy
 *   lets this endpoint through without one (SHO-462).
 *
 * Outbound (sendMessage):
 *   If the channelId is a URL (starts with http), POSTs the reply there.
 *   Otherwise, queues it for the next poll from that channelId.
 *
 * Config keys:
 *   secret          — shared secret for authenticating inbound requests (auto-generated if absent)
 *   callbackUrl     — default callback URL for async replies (optional)
 *   callbackHeaders — JSON-encoded headers to send with callbacks (optional)
 */

import { timingSafeEqual, createHash, randomBytes } from 'crypto'
import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

// ---------------------------------------------------------------------------
// Outbox — bounded in-memory store for poll-based consumers
// ---------------------------------------------------------------------------

/** Outbox entry with a TTL timestamp */
interface OutboxEntry {
  message: string
  expiresAt: number
}

const MAX_OUTBOX_IDS = 1_000
const MAX_OUTBOX_MESSAGES_PER_ID = 100
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1_000 // 24 h

/** Pending outbound messages keyed by channelId for poll-based consumers */
const outboxes = new Map<string, OutboxEntry[]>()

function outboxPut(channelId: string, message: string): void {
  // Prune expired entries from this id first
  const now = Date.now()
  const existing = outboxes.get(channelId) ?? []
  const fresh = existing.filter((e) => e.expiresAt > now)

  fresh.push({ message, expiresAt: now + OUTBOX_TTL_MS })

  // Per-id cap: drop oldest first
  const capped = fresh.length > MAX_OUTBOX_MESSAGES_PER_ID
    ? fresh.slice(fresh.length - MAX_OUTBOX_MESSAGES_PER_ID)
    : fresh

  if (capped.length < fresh.length) {
    console.warn(`[Webhook] Outbox for ${channelId.slice(0, 40)} hit ${MAX_OUTBOX_MESSAGES_PER_ID}-message cap; oldest entries dropped`)
  }

  outboxes.set(channelId, capped)

  // Global id cap: evict the least-recently-written id
  if (outboxes.size > MAX_OUTBOX_IDS) {
    const first = outboxes.keys().next()
    if (!first.done) {
      outboxes.delete(first.value)
      console.warn('[Webhook] Outbox id cap (1000) reached; oldest id evicted')
    }
  }
}

function outboxDrain(channelId: string): string[] {
  const now = Date.now()
  const entries = outboxes.get(channelId) ?? []
  const live = entries.filter((e) => e.expiresAt > now)
  outboxes.delete(channelId)
  return live.map((e) => e.message)
}

// ---------------------------------------------------------------------------
// Constant-time secret comparison
// ---------------------------------------------------------------------------

/** Hash both values with SHA-256, then compare with timingSafeEqual so length
 *  differences don't leak via timing. */
function secretEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the webhook activity log */
export interface WebhookActivityEntry {
  id: string
  timestamp: string
  direction: 'inbound' | 'outbound'
  senderId: string
  senderName: string
  messagePreview: string
  replyPreview?: string
  status: 'success' | 'pending' | 'error' | 'timeout'
  durationMs?: number
}

const MAX_ACTIVITY_LOG = 50

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WebhookAdapter implements ChannelAdapter {
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  connected = false
  private error: string | undefined
  private secret: string = ''
  private defaultCallbackUrl: string = ''
  private callbackHeaders: Record<string, string> = {}
  private messageCount = 0

  /** Recent activity log for UI visibility */
  private activityLog: WebhookActivityEntry[] = []

  /** Pending sync responses: correlationId -> resolve function */
  private pendingReplies = new Map<string, {
    resolve: (reply: string) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  /** Reply timeout in ms (default: 120 s — agent tool loops can take a while) */
  private replyTimeoutMs = 120_000

  async connect(config: Record<string, string>): Promise<void> {
    if (!config.secret) {
      throw new Error('Webhook channel requires a secret. Pass secret: "..." to channel_connect or POST /agent/channels/connect.')
    }
    this.secret = config.secret
    this.defaultCallbackUrl = config.callbackUrl || ''

    if (config.callbackHeaders) {
      try {
        this.callbackHeaders = JSON.parse(config.callbackHeaders)
      } catch {
        console.warn('[Webhook] Invalid callbackHeaders JSON, ignoring')
      }
    }

    if (config.replyTimeoutMs) {
      this.replyTimeoutMs = parseInt(config.replyTimeoutMs, 10) || 120_000
    }

    this.connected = true
    this.error = undefined
    console.log('[Webhook] Channel ready (secret: configured)')
  }

  async disconnect(): Promise<void> {
    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timer)
      pending.resolve('[Webhook disconnected]')
    }
    this.pendingReplies.clear()
    this.connected = false
    console.log('[Webhook] Disconnected')
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const pending = this.pendingReplies.get(channelId)
    if (pending) {
      clearTimeout(pending.timer)
      pending.resolve(content)
      this.pendingReplies.delete(channelId)
      return
    }

    if (channelId.startsWith('http://') || channelId.startsWith('https://')) {
      try {
        await fetch(channelId, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.callbackHeaders,
          },
          body: JSON.stringify({
            reply: content,
            timestamp: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(15_000),
        })
        console.log(`[Webhook] Delivered reply to callback: ${channelId}`)
      } catch (err: any) {
        console.error(`[Webhook] Callback delivery failed: ${err.message}`)
      }
      return
    }

    outboxPut(channelId, content)
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'webhook',
      connected: this.connected,
      error: this.error,
      metadata: {
        messageCount: this.messageCount,
        pendingReplies: this.pendingReplies.size,
        hasSecret: !!this.secret,
        recentActivity: this.activityLog.slice(-20),
      },
    }
  }

  /**
   * Expose the secret value for the owner-only `/agent/status` endpoint.
   * Never surfaced on public endpoints.
   */
  getSecret(): string {
    return this.secret
  }

  /** Get the full activity log (for the dedicated activity endpoint) */
  getActivityLog(): WebhookActivityEntry[] {
    return [...this.activityLog]
  }

  /** Add an entry to the activity log */
  private logActivity(entry: WebhookActivityEntry): void {
    this.activityLog.push(entry)
    if (this.activityLog.length > MAX_ACTIVITY_LOG) {
      this.activityLog = this.activityLog.slice(-MAX_ACTIVITY_LOG)
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound message handling (called by the server route)
  // ---------------------------------------------------------------------------

  /**
   * Verify the channel secret from the X-Webhook-Secret header.
   *
   * - No secret configured → always false (defence in depth; the backfill at
   *   gateway start means this shouldn't happen in practice).
   * - Comparison uses SHA-256 + timingSafeEqual so length differences don't
   *   leak via timing.
   */
  verifyAuth(secretHeader?: string): boolean {
    if (!this.secret) return false
    if (!secretHeader) return false
    return secretEqual(secretHeader, this.secret)
  }

  async processIncoming(body: {
    message: string
    senderId?: string
    senderName?: string
    callbackUrl?: string
    metadata?: Record<string, unknown>
  }): Promise<{ reply: string; async: boolean; correlationId: string; timedOut?: boolean }> {
    if (!this.messageHandler) {
      throw new Error('Webhook channel not initialized — no message handler')
    }

    this.messageCount++
    const correlationId = `webhook-${Date.now()}-${this.messageCount}`
    const callbackUrl = body.callbackUrl || this.defaultCallbackUrl
    const startTime = Date.now()
    const senderId = body.senderId || 'webhook'
    const senderName = body.senderName || 'Webhook'
    const msgPreview = body.message.length > 120 ? body.message.slice(0, 120) + '…' : body.message

    // Async mode: callback URL provided, dispatch and return immediately
    if (callbackUrl) {
      const msg: IncomingMessage = {
        text: body.message,
        channelId: callbackUrl,
        channelType: 'webhook',
        senderId,
        senderName,
        timestamp: Date.now(),
        metadata: { ...body.metadata, correlationId, callbackUrl },
      }
      this.logActivity({
        id: correlationId,
        timestamp: new Date().toISOString(),
        direction: 'inbound',
        senderId,
        senderName,
        messagePreview: msgPreview,
        status: 'success',
      })
      this.messageHandler(msg)
      return { reply: '', async: true, correlationId }
    }

    // Sync mode: wait for the agent's reply
    const handler = this.messageHandler
    const activityEntry: WebhookActivityEntry = {
      id: correlationId,
      timestamp: new Date().toISOString(),
      direction: 'inbound',
      senderId,
      senderName,
      messagePreview: msgPreview,
      status: 'pending',
    }
    this.logActivity(activityEntry)

    return new Promise<{ reply: string; async: false; correlationId: string; timedOut?: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(correlationId)
        activityEntry.status = 'timeout'
        activityEntry.durationMs = Date.now() - startTime
        resolve({ reply: '', async: false, correlationId, timedOut: true })
      }, this.replyTimeoutMs)

      this.pendingReplies.set(correlationId, {
        resolve: (reply: string) => {
          activityEntry.status = 'success'
          activityEntry.replyPreview = reply.length > 120 ? reply.slice(0, 120) + '…' : reply
          activityEntry.durationMs = Date.now() - startTime
          resolve({ reply, async: false, correlationId })
        },
        timer,
      })

      const msg: IncomingMessage = {
        text: body.message,
        channelId: correlationId,
        channelType: 'webhook',
        senderId,
        senderName,
        timestamp: Date.now(),
        metadata: { ...body.metadata, correlationId },
      }
      handler(msg)
    })
  }

  drainOutbox(channelId: string): string[] {
    return outboxDrain(channelId)
  }

  // ---------------------------------------------------------------------------
  // Static: register Hono routes for webhook ingress
  // ---------------------------------------------------------------------------

  /**
   * Register the webhook Hono routes.
   *
   * @param app         Hono app instance
   * @param getAdapter  Returns the connected WebhookAdapter (or null)
   * @param getPublicOutboxUrl  Given a correlationId, returns the public
   *   outbox URL (e.g. `https://api.shogo.ai/api/projects/.../outbox/<id>`),
   *   or null when no public URL is available (desktop not signed in to cloud).
   */
  static registerRoutes(
    app: any,
    getAdapter: () => WebhookAdapter | null,
    getPublicOutboxUrl?: (correlationId: string) => string | null,
  ): void {
    app.post('/agent/channels/webhook/incoming', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'Webhook channel not connected' }, 503)
      }

      const secretHeader = c.req.header('x-webhook-secret') || ''
      if (!adapter.verifyAuth(secretHeader)) {
        return c.json({ error: 'Unauthorized — send the channel secret in X-Webhook-Secret' }, 401)
      }

      let body: any
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const message = body.message || body.text || body.content
      if (!message || typeof message !== 'string') {
        return c.json({
          error: 'Missing required field: "message" (string)',
          example: {
            message: 'Hello agent!',
            senderId: 'my-app',
            senderName: 'My App',
            callbackUrl: 'https://example.com/webhook/reply',
            metadata: { orderId: '12345' },
          },
        }, 400)
      }

      try {
        const result = await adapter.processIncoming({
          message,
          senderId: body.senderId || body.sender_id,
          senderName: body.senderName || body.sender_name,
          callbackUrl: body.callbackUrl || body.callback_url,
          metadata: body.metadata,
        })

        if (result.async) {
          return c.json({ status: 'accepted', correlationId: result.correlationId }, 202)
        }

        if (result.timedOut) {
          const outboxUrl = getPublicOutboxUrl ? getPublicOutboxUrl(result.correlationId) : null
          return c.json({
            status: 'pending',
            correlationId: result.correlationId,
            ...(outboxUrl ? { outboxUrl } : {}),
          }, 202)
        }

        return c.json({ reply: result.reply, correlationId: result.correlationId })
      } catch (err: any) {
        console.error('[Webhook] Processing error:', err.message)
        return c.json({ error: `Processing failed: ${err.message}` }, 500)
      }
    })

    app.get('/agent/channels/webhook/outbox/:correlationId', (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'Webhook channel not connected' }, 503)
      }

      const secretHeader = c.req.header('x-webhook-secret') || ''
      if (!adapter.verifyAuth(secretHeader)) {
        return c.json({ error: 'Unauthorized — send the channel secret in X-Webhook-Secret' }, 401)
      }

      const correlationId = c.req.param('correlationId')
      const messages = adapter.drainOutbox(correlationId)
      return c.json({ messages })
    })

    app.get('/agent/channels/webhook/health', (c: any) => {
      const adapter = getAdapter()
      if (!adapter) {
        return c.json({ status: 'not_configured' })
      }
      return c.json({
        status: adapter.connected ? 'healthy' : 'disconnected',
        ...adapter.getStatus(),
      })
    })

    app.get('/agent/channels/webhook/activity', (c: any) => {
      const adapter = getAdapter()
      if (!adapter) {
        return c.json({ activity: [], connected: false })
      }
      return c.json({
        activity: adapter.getActivityLog(),
        connected: adapter.connected,
        messageCount: adapter.getStatus().metadata?.messageCount ?? 0,
      })
    })

    app.post('/agent/channels/webhook/test', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'Webhook channel not connected' }, 503)
      }

      let body: any = {}
      try {
        body = await c.req.json()
      } catch {
        // Use defaults
      }

      const testMessage = body.message || 'Hello! This is a test message from the Shogo webhook tester.'

      try {
        const result = await adapter.processIncoming({
          message: testMessage,
          senderId: 'shogo-test',
          senderName: 'Shogo Test',
          metadata: { isTest: true },
        })

        return c.json({
          ok: true,
          reply: result.reply,
          correlationId: result.correlationId,
          async: result.async,
        })
      } catch (err: any) {
        return c.json({ error: `Test failed: ${err.message}` }, 500)
      }
    })
  }
}

/** Generate a new webhook secret: 32 random bytes as hex. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}
