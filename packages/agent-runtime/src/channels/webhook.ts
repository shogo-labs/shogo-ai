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
 *           "callbackUrl?": "https://...", "metadata?": {...},
 *           "dedupeKey?": "..." }
 *   → Sync mode (no callbackUrl):  returns { "reply": "..." }
 *   → Async mode (with callbackUrl): returns 202, POSTs reply to callbackUrl
 *
 * Dedupe (optional):
 *   Send a key to make the hop idempotent. A repeat of the same key inside
 *   `dedupeTtlMs` (default 60s) is dropped with
 *   202 { status: "duplicate-ignored" } instead of starting another agent turn.
 *   Send no key and every request is dispatched, exactly as before, so callers
 *   that don't need this are unaffected.
 *
 *   Key precedence, first match wins:
 *     1. `metadata.dedupeKey` — the alert relay publishes this next to
 *        `metadata.groupKey` and it is the status-aware one (status is hashed
 *        into it), so a `resolved` is never suppressed by its firing twin.
 *     2. `metadata.groupKey` — status-blind fallback, for senders that only
 *        carry an Alertmanager group key.
 *     3. `dedupeKey`         — top-level, for callers with a key of their own.
 *
 *   This is the receiver half of the alert-relay fix: SigNoz/Alertmanager
 *   re-POSTs the same notification group several times within a second, and
 *   each POST used to become its own turn.
 *
 * Auth:
 *   If a `secret` is configured, requests must include:
 *     Authorization: Bearer <secret>   OR   X-Webhook-Secret: <secret>
 *
 * Outbound (sendMessage):
 *   If the channelId is a URL (starts with http), POSTs the reply there.
 *   Otherwise, queues it for the next poll from that channelId.
 *
 * Config keys:
 *   secret          — shared secret for authenticating inbound requests (optional)
 *   callbackUrl     — default callback URL for async replies (optional)
 *   callbackHeaders — JSON-encoded headers to send with callbacks (optional)
 *   dedupeTtlMs     — inbound dedupe window in ms (default 60000) (optional)
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

/** Pending outbound messages keyed by channelId for poll-based consumers */
const outboxes = new Map<string, string[]>()

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

/**
 * Cap on the inbound-dedupe map. A TTL already bounds it by traffic rate; this
 * bounds it by the number of *distinct* keys seen inside one TTL, so a
 * misbehaving caller cannot grow the map without limit.
 */
const MAX_DEDUPE_KEYS = 5_000

/** Default inbound-dedupe window: long enough to swallow a burst re-send. */
const DEFAULT_DEDUPE_TTL_MS = 60_000

export class WebhookAdapter implements ChannelAdapter {
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
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

  /** Reply timeout in ms (default: 120s — agent tool loops can take a while) */
  private replyTimeoutMs = 120_000

  /** Inbound dedupe: key -> `Date.now()` at which the key stops counting. */
  private dedupeTtlMs = DEFAULT_DEDUPE_TTL_MS
  private dedupeSeen = new Map<string, number>()

  async connect(config: Record<string, string>): Promise<void> {
    this.secret = config.secret || ''
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

    if (config.dedupeTtlMs) {
      this.dedupeTtlMs = parseInt(config.dedupeTtlMs, 10) || DEFAULT_DEDUPE_TTL_MS
    }

    this.connected = true
    this.error = undefined
    console.log(
      `[Webhook] Channel ready (secret: ${this.secret ? 'configured' : 'none'}, ` +
      `defaultCallback: ${this.defaultCallbackUrl || 'none'})`
    )
  }

  async disconnect(): Promise<void> {
    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timer)
      pending.resolve('[Webhook disconnected]')
    }
    this.pendingReplies.clear()
    outboxes.clear()
    this.dedupeSeen.clear()
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

    if (!outboxes.has(channelId)) {
      outboxes.set(channelId, [])
    }
    outboxes.get(channelId)!.push(content)
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
        authenticated: !!this.secret,
        hasSecret: !!this.secret,
        recentActivity: this.activityLog.slice(-20),
      },
    }
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
   * Inbound idempotency guard. True when `key` was already seen inside the
   * dedupe TTL; records it and returns false otherwise.
   *
   * A falsy key is never a duplicate, so callers that send none are completely
   * unaffected — the guard only engages for senders that opt in by including a
   * key. Callers must run this *after* auth and message validation: a dropped
   * duplicate should never skip a check that a real request would have to pass.
   */
  isDuplicate(key?: string | null): boolean {
    if (!key) return false

    const now = Date.now()
    for (const [seen, expiresAt] of this.dedupeSeen) {
      if (expiresAt <= now) this.dedupeSeen.delete(seen)
    }

    if (this.dedupeSeen.has(key)) return true

    // Map iteration is insertion-ordered, so the first key is the oldest.
    if (this.dedupeSeen.size >= MAX_DEDUPE_KEYS) {
      const oldest = this.dedupeSeen.keys().next().value
      if (oldest !== undefined) this.dedupeSeen.delete(oldest)
    }
    this.dedupeSeen.set(key, now + this.dedupeTtlMs)
    return false
  }

  verifyAuth(authHeader?: string, secretHeader?: string): boolean {
    if (!this.secret) return true
    return (
      authHeader === `Bearer ${this.secret}` ||
      secretHeader === this.secret
    )
  }

  async processIncoming(body: {
    message: string
    senderId?: string
    senderName?: string
    callbackUrl?: string
    metadata?: Record<string, unknown>
  }): Promise<{ reply: string; async: boolean }> {
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
      return { reply: '', async: true }
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

    return new Promise<{ reply: string; async: false }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(correlationId)
        activityEntry.status = 'timeout'
        activityEntry.durationMs = Date.now() - startTime
        resolve({
          reply: 'Request timed out — the agent took too long to respond.',
          async: false,
        })
      }, this.replyTimeoutMs)

      this.pendingReplies.set(correlationId, {
        resolve: (reply: string) => {
          activityEntry.status = 'success'
          activityEntry.replyPreview = reply.length > 120 ? reply.slice(0, 120) + '…' : reply
          activityEntry.durationMs = Date.now() - startTime
          resolve({ reply, async: false })
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
    const msgs = outboxes.get(channelId) || []
    outboxes.delete(channelId)
    return msgs
  }

  // ---------------------------------------------------------------------------
  // Static: register Hono routes for webhook ingress
  // ---------------------------------------------------------------------------

  static registerRoutes(app: any, getAdapter: () => WebhookAdapter | null): void {
    app.post('/agent/channels/webhook/incoming', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'Webhook channel not connected' }, 503)
      }

      const auth = c.req.header('authorization') || ''
      const secret = c.req.header('x-webhook-secret') || ''
      if (!adapter.verifyAuth(auth, secret)) {
        return c.json({ error: 'Unauthorized' }, 401)
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

      // Idempotency guard, after auth and validation so a dropped duplicate
      // cannot skip a check a real request would have to pass.
      //
      // `metadata.dedupeKey` wins: the alert relay publishes it alongside
      // `metadata.groupKey`, and only that one is status-aware (it hashes the
      // status in), so it is what keeps a `resolved` from being swallowed by its
      // firing twin. `metadata.groupKey` is the status-blind fallback for
      // senders that only have an Alertmanager group key; `dedupeKey` is for
      // callers with a key of their own. Absent all three this is a no-op.
      const dedupeKey =
        typeof body.metadata?.dedupeKey === 'string' ? body.metadata.dedupeKey
          : typeof body.metadata?.groupKey === 'string' ? body.metadata.groupKey
            : typeof body.dedupeKey === 'string' ? body.dedupeKey
              : ''
      if (dedupeKey && adapter.isDuplicate(dedupeKey)) {
        return c.json({
          status: 'duplicate-ignored',
          message: 'Duplicate suppressed: same dedupeKey inside the dedupe window.',
        }, 202)
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
          return c.json({
            status: 'accepted',
            message: 'Message received. Reply will be sent to the callback URL.',
          }, 202)
        }

        return c.json({ reply: result.reply })
      } catch (err: any) {
        console.error('[Webhook] Processing error:', err.message)
        return c.json({ error: `Processing failed: ${err.message}` }, 500)
      }
    })

    app.get('/agent/channels/webhook/outbox/:channelId', (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'Webhook channel not connected' }, 503)
      }

      const auth = c.req.header('authorization') || ''
      const secret = c.req.header('x-webhook-secret') || ''
      if (!adapter.verifyAuth(auth, secret)) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const channelId = c.req.param('channelId')
      const messages = adapter.drainOutbox(channelId)
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
          async: result.async,
        })
      } catch (err: any) {
        return c.json({ error: `Test failed: ${err.message}` }, 500)
      }
    })
  }
}
