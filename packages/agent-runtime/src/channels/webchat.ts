// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WebChat Channel Adapter
 *
 * Provides an embeddable chat widget that can be placed on any website via a
 * simple <script> tag. The widget communicates with the agent through SSE
 * (Server-Sent Events) for streaming responses and REST for sending messages.
 *
 * How it works:
 *   1. Agent owner connects the "webchat" channel (optionally customising theme)
 *   2. The agent-runtime serves a small JS widget at /agent/channels/webchat/widget.js
 *   3. Website owner embeds: <script src="https://<agent-url>/agent/channels/webchat/widget.js"></script>
 *   4. Visitors open the chat bubble → messages are POSTed to the agent
 *   5. Responses stream back via SSE for a real-time feel
 *
 * Config keys:
 *   title         — chat window header (default: "Chat with us")
 *   subtitle      — optional subtitle text
 *   primaryColor  — hex colour for the chat bubble / header (default: "#6366f1")
 *   position      — "bottom-right" | "bottom-left" (default: "bottom-right")
 *   welcomeMessage — auto-sent greeting when the user first opens the widget
 *   avatarUrl     — URL for the bot avatar image (optional)
 *   allowedOrigins — comma-separated list of allowed origins, or "*" (default: "*")
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'

export interface WebChatSession {
  id: string
  visitorId?: string
  visitor?: {
    name?: string
    email?: string
    metadata?: Record<string, unknown>
  }
  createdAt: number
  lastMessageAt: number
  messageCount: number
  metadata?: Record<string, unknown>
  tokenHash?: string
  expiresAt?: number
}

export interface WebChatConfig {
  title: string
  subtitle: string
  primaryColor: string
  position: 'bottom-right' | 'bottom-left'
  welcomeMessage: string
  avatarUrl: string
  allowedOrigins: string
  widgetSecret: string
  theme: 'light' | 'dark' | 'auto'
  placeholder: string
  launcherIcon: string
  poweredBy: boolean
  suggestedPrompts: string[]
  maxMessageLength: number
  maxTurnsPerDay: number
  allowWorkspaceWrites: boolean
}

interface SessionAuthToken {
  sessionId: string
  expiresAt: number
}

const DEFAULT_CONFIG: WebChatConfig = {
  title: 'Chat with us',
  subtitle: '',
  primaryColor: '#6366f1',
  position: 'bottom-right',
  welcomeMessage: '',
  avatarUrl: '',
  allowedOrigins: '*',
  widgetSecret: '',
  theme: 'auto',
  placeholder: 'Type a message...',
  launcherIcon: 'chat',
  poweredBy: true,
  suggestedPrompts: [],
  maxMessageLength: 8_000,
  maxTurnsPerDay: 200,
  allowWorkspaceWrites: false,
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function parseStringList(value: string | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string').slice(0, 10)
    }
  } catch {
    // Accept a simple comma-separated config for hand-authored config files.
  }
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 10)
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback
}

function historyToUIMessages(history: unknown[]): Array<{
  id: string
  role: 'user' | 'assistant'
  parts: Array<{ type: 'text'; text: string }>
}> {
  return history.flatMap((message: any, index) => {
    if (message?.role !== 'user' && message?.role !== 'assistant') return []
    const text =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
              .map((part: any) => part.text)
              .join('')
          : ''
    if (!text) return []
    return [{
      id: `webchat-history-${index}-${message.timestamp || 0}`,
      role: message.role,
      parts: [{ type: 'text', text }],
    }]
  })
}

export class WebChatAdapter implements ChannelAdapter {
  private messageHandler: ((msg: IncomingMessage) => void | Promise<void>) | null = null
  private connected = false
  private error: string | undefined
  private config: WebChatConfig = { ...DEFAULT_CONFIG }
  private sessions = new Map<string, WebChatSession>()
  private messageCount = 0

  /** SSE clients waiting for streamed responses: sessionId -> SSE write callback */
  private sseClients = new Map<string, (event: string, data: string) => void>()

  private sessionAuthTokens = new Map<string, SessionAuthToken>()
  private sessionStorePath = join(
    process.env.WORKSPACE_DIR || process.cwd(),
    '.shogo',
    'webchat-sessions.json',
  )
  private turnTimestamps = new Map<string, number[]>()
  private activeTurns = new Set<string>()

  async connect(config: Record<string, string>): Promise<void> {
    this.config = {
      title: config.title || DEFAULT_CONFIG.title,
      subtitle: config.subtitle || DEFAULT_CONFIG.subtitle,
      primaryColor: config.primaryColor || DEFAULT_CONFIG.primaryColor,
      position: (config.position as WebChatConfig['position']) || DEFAULT_CONFIG.position,
      welcomeMessage: config.welcomeMessage || DEFAULT_CONFIG.welcomeMessage,
      avatarUrl: config.avatarUrl || DEFAULT_CONFIG.avatarUrl,
      allowedOrigins: config.allowedOrigins || DEFAULT_CONFIG.allowedOrigins,
      widgetSecret: config.widgetSecret || '',
      theme: config.theme === 'light' || config.theme === 'dark' ? config.theme : 'auto',
      placeholder: config.placeholder || DEFAULT_CONFIG.placeholder,
      launcherIcon: config.launcherIcon || DEFAULT_CONFIG.launcherIcon,
      poweredBy: config.poweredBy !== 'false',
      suggestedPrompts: parseStringList(config.suggestedPrompts),
      maxMessageLength: clampInteger(config.maxMessageLength, 8_000, 100, 32_000),
      maxTurnsPerDay: clampInteger(config.maxTurnsPerDay, 200, 1, 10_000),
      allowWorkspaceWrites: config.allowWorkspaceWrites === 'true',
    }
    this.loadSessions()

    this.connected = true
    this.error = undefined
    console.log(
      `[WebChat] Channel ready (title: "${this.config.title}", ` +
      `position: ${this.config.position}, origins: ${this.config.allowedOrigins})`
    )
  }

  async disconnect(): Promise<void> {
    this.sseClients.clear()
    this.sessionAuthTokens.clear()
    this.connected = false
    this.persistSessions()
    console.log('[WebChat] Disconnected')
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const sessionId = this.extractSessionId(channelId)
    const sseWriter = this.sseClients.get(sessionId)
    if (sseWriter) {
      sseWriter('message', JSON.stringify({
        type: 'agent_message',
        content,
        timestamp: Date.now(),
      }))
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    const writer = this.sseClients.get(this.extractSessionId(channelId))
    if (!writer) return
    writer('typing', JSON.stringify({ sessionId: this.extractSessionId(channelId), timestamp: Date.now() }))
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'webchat',
      connected: this.connected,
      error: this.error,
      metadata: {
        messageCount: this.messageCount,
        activeSessions: this.sessions.size,
        sseClients: this.sseClients.size,
        config: {
          title: this.config.title,
          position: this.config.position,
          primaryColor: this.config.primaryColor,
          theme: this.config.theme,
          placeholder: this.config.placeholder,
          suggestedPrompts: this.config.suggestedPrompts,
        },
      },
    }
  }

  getConfig(): WebChatConfig {
    return { ...this.config }
  }

  getWidgetSecret(): string {
    return this.config.widgetSecret
  }

  isPublishableRequestAuthorized(
    verifiedHeader: string | null | undefined,
    runtimeToken: string | null | undefined,
  ): boolean {
    // The cloud proxy adds the verified marker only after validating the
    // publishable key. Requiring the pod runtime token prevents a direct
    // internet caller from spoofing that marker.
    return verifiedHeader === '1' && !!runtimeToken
  }

  isRequestAuthorized(
    widgetKey: string | null | undefined,
    publishableVerified: string | null | undefined,
    runtimeToken: string | null | undefined,
  ): boolean {
    return (
      this.validateWidgetSecret(widgetKey) ||
      this.isPublishableRequestAuthorized(publishableVerified, runtimeToken)
    )
  }

  validateWidgetSecret(secret: string | null | undefined): boolean {
    if (!this.config.widgetSecret) return false
    return secret === this.config.widgetSecret
  }

  issueSessionAuthToken(sessionId: string): { token: string; expiresInSeconds: number } {
    this.pruneExpiredTokens()
    const token = randomUUID()
    const expiresInSeconds = 24 * 60 * 60
    const expiresAt = Date.now() + (expiresInSeconds * 1000)
    this.sessionAuthTokens.set(token, { sessionId, expiresAt })
    const session = this.getOrCreateSession(sessionId)
    session.tokenHash = hashSessionToken(token)
    session.expiresAt = expiresAt
    this.persistSessions()
    return { token, expiresInSeconds }
  }

  validateSessionAuthToken(token: string | null | undefined, sessionId: string): boolean {
    if (!token) return false
    const session = this.sessions.get(sessionId)
    const record = this.sessionAuthTokens.get(token)
    const expiresAt = record?.expiresAt ?? session?.expiresAt
    const matchesPersistedToken = session?.tokenHash === hashSessionToken(token)
    if (!session || (!record && !matchesPersistedToken) || (record && record.sessionId !== sessionId)) {
      return false
    }
    if (!expiresAt || expiresAt < Date.now()) {
      this.sessionAuthTokens.delete(token)
      return false
    }
    // Sliding 24-hour expiry: an active visitor stays authenticated without
    // needing to expose a refresh token to the browser.
    const refreshedExpiresAt = Date.now() + (24 * 60 * 60 * 1000)
    session.expiresAt = refreshedExpiresAt
    if (record) record.expiresAt = refreshedExpiresAt
    this.persistSessions()
    return true
  }

  private pruneExpiredTokens(): void {
    if (this.sessionAuthTokens.size < 500) return
    const now = Date.now()
    for (const [token, record] of this.sessionAuthTokens) {
      if (record.expiresAt < now) this.sessionAuthTokens.delete(token)
    }
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  getOrCreateSession(sessionId?: string): WebChatSession {
    if (sessionId && this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!
    }

    const id = sessionId || randomUUID()
    const session: WebChatSession = {
      id,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    }
    this.sessions.set(id, session)
    this.persistSessions()
    return session
  }

  updateSession(
    sessionId: string,
    patch: Pick<WebChatSession, 'visitorId' | 'visitor'>,
  ): WebChatSession {
    const session = this.getOrCreateSession(sessionId)
    if (patch.visitorId) session.visitorId = patch.visitorId
    if (patch.visitor) session.visitor = patch.visitor
    this.persistSessions()
    return session
  }

  canAcceptTurn(sessionId: string): { ok: true } | { ok: false; message: string } {
    const session = this.getOrCreateSession(sessionId)
    if (this.activeTurns.has(sessionId)) {
      return { ok: false, message: 'A response is already being generated for this chat session.' }
    }
    if (session.messageCount >= this.config.maxTurnsPerDay) {
      return { ok: false, message: 'This chat session has reached its daily message limit.' }
    }
    const timestamps = (this.turnTimestamps.get(sessionId) || []).filter(
      (timestamp) => timestamp > Date.now() - 60_000,
    )
    this.turnTimestamps.set(sessionId, timestamps)
    if (timestamps.length >= 10) {
      return { ok: false, message: 'Please wait a moment before sending another message.' }
    }
    timestamps.push(Date.now())
    return { ok: true }
  }

  beginTurn(sessionId: string): { ok: true } | { ok: false; message: string } {
    const result = this.canAcceptTurn(sessionId)
    if (!result.ok) return result
    this.activeTurns.add(sessionId)
    return result
  }

  endTurn(sessionId: string): void {
    this.activeTurns.delete(sessionId)
  }

  private loadSessions(): void {
    try {
      if (!existsSync(this.sessionStorePath)) return
      const parsed = JSON.parse(readFileSync(this.sessionStorePath, 'utf8'))
      if (!Array.isArray(parsed)) return
      for (const value of parsed) {
        if (!value || typeof value.id !== 'string') continue
        this.sessions.set(value.id, value as WebChatSession)
      }
    } catch (error: any) {
      console.warn('[WebChat] Failed to restore sessions:', error?.message || error)
    }
  }

  private persistSessions(): void {
    try {
      mkdirSync(dirname(this.sessionStorePath), { recursive: true })
      writeFileSync(
        this.sessionStorePath,
        JSON.stringify(Array.from(this.sessions.values()).slice(-10_000)),
      )
    } catch (error: any) {
      console.warn('[WebChat] Failed to persist sessions:', error?.message || error)
    }
  }

  // ---------------------------------------------------------------------------
  // SSE registration
  // ---------------------------------------------------------------------------

  registerSSEClient(sessionId: string, writer: (event: string, data: string) => void): void {
    this.sseClients.set(sessionId, writer)
  }

  removeSSEClient(sessionId: string): void {
    this.sseClients.delete(sessionId)
  }

  // ---------------------------------------------------------------------------
  // Inbound message processing
  // ---------------------------------------------------------------------------

  async processIncoming(body: {
    message: string
    sessionId: string
    visitorId?: string
    visitor?: WebChatSession['visitor']
    metadata?: Record<string, unknown>
    uiWriter?: { write(chunk: Record<string, unknown>): void }
  }): Promise<void> {
    if (!this.messageHandler) {
      throw new Error('WebChat channel not initialized — no message handler')
    }

    this.messageCount++
    const session = this.getOrCreateSession(body.sessionId)
    this.updateSession(session.id, {
      visitorId: body.visitorId,
      visitor: body.visitor,
    })
    session.lastMessageAt = Date.now()
    session.messageCount++
    this.persistSessions()

    const msg: IncomingMessage = {
      text: body.message,
      // This id must remain stable across turns. The previous implementation
      // used a per-message correlation id here, which made the gateway create
      // a fresh conversation for every visitor message.
      channelId: `webchat:${session.id}`,
      channelType: 'webchat',
      senderId: session.visitorId || session.id,
      senderName: session.visitor?.name || 'Visitor',
      timestamp: Date.now(),
      uiWriter: body.uiWriter,
      metadata: {
        ...session.visitor?.metadata,
        ...body.metadata,
        sessionId: session.id,
        visitorId: session.visitorId,
        visitor: session.visitor,
        webchat: true,
      },
    }

    await this.messageHandler!(msg)
  }

  // ---------------------------------------------------------------------------
  // Origin validation
  // ---------------------------------------------------------------------------

  isOriginAllowed(origin: string | undefined): boolean {
    // Even with wildcard mode, require an Origin header to block basic non-browser scraping.
    if (this.config.allowedOrigins === '*') return !!origin
    if (!origin) return false
    const allowed = this.config.allowedOrigins.split(',').map(o => o.trim())
    return allowed.includes(origin)
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private extractSessionId(channelId: string): string {
    if (channelId.startsWith('webchat:')) return channelId.slice('webchat:'.length)
    return channelId
  }

  // ---------------------------------------------------------------------------
  // Static: register Hono routes for WebChat
  // ---------------------------------------------------------------------------

  static registerRoutes(
    app: any,
    getAdapter: () => WebChatAdapter | null,
    getHistoryProvider?: () => ((sessionId: string) => unknown[]) | undefined,
    stopProvider?: (sessionId: string) => boolean,
  ): void {
    const getRequestOrigin = (c: any): string | undefined => {
      const origin = c.req.header('origin')
      const forwarded = c.req.header('x-shogo-embed-origin')
      if (origin && forwarded) {
        try {
          if (origin === new URL(c.req.url).origin) {
            return new URL(forwarded).origin
          }
        } catch {
          return undefined
        }
      }
      return origin || undefined
    }

    app.use('/agent/channels/webchat/*', async (c: any, next: any) => {
      const origin = c.req.header('origin') || '*'
      if (c.req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Shogo-Embed-Origin, X-WebChat-Widget-Key, X-WebChat-Session-Token, X-WebChat-Session',
            'Access-Control-Max-Age': '86400',
          },
        })
      }
      await next()
      c.res.headers.set('Access-Control-Allow-Origin', origin)
    })

    // Get widget configuration (used by the embedded widget to initialize)
    app.get('/agent/channels/webchat/config', (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }

      const widgetKey = c.req.header('x-webchat-widget-key')
      if (!adapter.isRequestAuthorized(
        widgetKey,
        c.req.header('x-webchat-pk-verified'),
        c.req.header('x-runtime-token'),
      )) {
        return c.json({ error: 'Invalid or missing widget key' }, 403)
      }

      const origin = getRequestOrigin(c)
      if (!adapter.isOriginAllowed(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }

      const config = adapter.getConfig()
      return c.json({
        title: config.title,
        subtitle: config.subtitle,
        primaryColor: config.primaryColor,
        position: config.position,
        welcomeMessage: config.welcomeMessage,
        avatarUrl: config.avatarUrl,
        theme: config.theme,
        placeholder: config.placeholder,
        launcherIcon: config.launcherIcon,
        poweredBy: config.poweredBy,
        suggestedPrompts: config.suggestedPrompts,
      })
    })

    // Create or resume a chat session
    app.post('/agent/channels/webchat/session', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }

      const widgetKey = c.req.header('x-webchat-widget-key')
      if (!adapter.isRequestAuthorized(
        widgetKey,
        c.req.header('x-webchat-pk-verified'),
        c.req.header('x-runtime-token'),
      )) {
        return c.json({ error: 'Invalid or missing widget key' }, 403)
      }

      const origin = getRequestOrigin(c)
      if (!adapter.isOriginAllowed(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }

      const body = await c.req.json().catch(() => ({}))
      const sessionId = c.req.header('x-webchat-session')
      const session = adapter.getOrCreateSession(sessionId || undefined)
      adapter.updateSession(session.id, {
        visitorId: typeof body.visitorId === 'string' ? body.visitorId.slice(0, 200) : undefined,
        visitor: body.visitor && typeof body.visitor === 'object'
          ? {
              name: typeof body.visitor.name === 'string' ? body.visitor.name.slice(0, 200) : undefined,
              email: typeof body.visitor.email === 'string' ? body.visitor.email.slice(0, 320) : undefined,
              metadata: body.visitor.metadata && typeof body.visitor.metadata === 'object'
                ? body.visitor.metadata
                : undefined,
            }
          : undefined,
      })
      const auth = adapter.issueSessionAuthToken(session.id)
      return c.json({
        sessionId: session.id,
        created: !sessionId,
        sessionToken: auth.token,
        sessionTokenExpiresIn: auth.expiresInSeconds,
        visitorId: session.visitorId,
      })
    })

    // Return the persisted gateway history for a visitor.
    app.get('/agent/channels/webchat/history', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }
      const sessionId = c.req.query('sessionId')
      const sessionToken = c.req.header('x-webchat-session-token')
      if (!sessionId || !adapter.validateSessionAuthToken(sessionToken, sessionId)) {
        return c.json({ error: 'Invalid or expired session token' }, 403)
      }
      const historyProvider = getHistoryProvider?.()
      const history = historyProvider?.(sessionId) || []
      return c.json({ messages: historyToUIMessages(history) })
    })

    // Stop a visitor's active turn.
    app.post('/agent/channels/webchat/stop', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }
      const sessionId = c.req.header('x-webchat-session')
      const sessionToken = c.req.header('x-webchat-session-token')
      if (!sessionId || !adapter.validateSessionAuthToken(sessionToken, sessionId)) {
        return c.json({ error: 'Invalid or expired session token' }, 403)
      }
      const stopped = stopProvider?.(`webchat:${sessionId}`) ?? false
      return c.json({ ok: true, stopped })
    })

    // Send a message. The response is the same AI SDK UI stream emitted by
    // /agent/chat, so the React and script embeds share one renderer.
    app.post('/agent/channels/webchat/message', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }

      const origin = getRequestOrigin(c)
      if (!adapter.isOriginAllowed(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }

      let body: any
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const message = body.message
      const sessionId = body.sessionId
      const sessionToken = c.req.header('x-webchat-session-token')
      if (!message || typeof message !== 'string') {
        return c.json({ error: 'Missing required field: "message"' }, 400)
      }
      if (!sessionId) {
        return c.json({ error: 'Missing required field: "sessionId"' }, 400)
      }
      if (!adapter.validateSessionAuthToken(sessionToken, sessionId)) {
        return c.json({ error: 'Invalid or expired session token' }, 403)
      }
      if (message.length > adapter.getConfig().maxMessageLength) {
        return c.json({ error: 'Message is too long' }, 413)
      }
      const turn = adapter.beginTurn(sessionId)
      if (!turn.ok) return c.json({ error: turn.message }, 429)

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          writer.write({ type: 'start' } as any)
          try {
            await adapter.processIncoming({
              message,
              sessionId,
              visitorId: typeof body.visitorId === 'string' ? body.visitorId : undefined,
              visitor: body.visitor,
              metadata: body.metadata,
              uiWriter: writer,
            })
            writer.write({ type: 'finish', finishReason: 'stop' } as any)
          } catch (err: any) {
            console.error('[WebChat] Processing error:', err?.message || err)
            writer.write({ type: 'error', errorText: 'Chat processing failed' } as any)
          } finally {
            adapter.endTurn(sessionId)
          }
        },
      })
      return createUIMessageStreamResponse({ stream })
    })

    // SSE endpoint for streaming responses
    app.get('/agent/channels/webchat/events/:sessionId', (c: any) => {
      const adapter = getAdapter()
      if (!adapter || !adapter.connected) {
        return c.json({ error: 'WebChat channel not connected' }, 503)
      }

      const origin = getRequestOrigin(c)
      if (!adapter.isOriginAllowed(origin)) {
        return c.json({ error: 'Origin not allowed' }, 403)
      }

      const sessionId = c.req.param('sessionId')
      const sessionToken = new URL(c.req.url).searchParams.get('sessionToken')
      if (!adapter.validateSessionAuthToken(sessionToken, sessionId)) {
        return c.json({ error: 'Invalid or expired session token' }, 403)
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()

            const write = (event: string, data: string) => {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))
            }

            // Send initial connection event
            write('connected', JSON.stringify({ sessionId, timestamp: Date.now() }))

            // Send welcome message if configured
            const config = adapter.getConfig()
            if (config.welcomeMessage) {
              write('message', JSON.stringify({
                type: 'agent_message',
                content: config.welcomeMessage,
                timestamp: Date.now(),
                isWelcome: true,
              }))
            }

            adapter.registerSSEClient(sessionId, write)

            // Heartbeat every 30s to keep connection alive
            const heartbeat = setInterval(() => {
              try {
                write('ping', JSON.stringify({ timestamp: Date.now() }))
              } catch {
                clearInterval(heartbeat)
                adapter.removeSSEClient(sessionId)
              }
            }, 30_000)

            // Cleanup on close
            c.req.raw.signal?.addEventListener('abort', () => {
              clearInterval(heartbeat)
              adapter.removeSSEClient(sessionId)
            })
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
          },
        }
      )
    })

    // Serve the embeddable widget JavaScript (fully public — no secret needed)
    app.get('/agent/channels/webchat/embed/index.html', (c: any) => {
      const baseUrl = new URL(c.req.url)
      const agentBaseUrl = `${baseUrl.protocol}//${baseUrl.host}`
      return new Response(generateRuntimeEmbedHtml(agentBaseUrl), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      })
    })

    app.get('/agent/channels/webchat/widget.js', (c: any) => {
      const adapter = getAdapter()
      const baseUrl = new URL(c.req.url)
      const agentBaseUrl = `${baseUrl.protocol}//${baseUrl.host}`

      return new Response(generateWidgetScript(agentBaseUrl), {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      })
    })

    // Health check
    app.get('/agent/channels/webchat/health', (c: any) => {
      const adapter = getAdapter()
      if (!adapter) {
        return c.json({ status: 'not_configured' })
      }
      return c.json({
        status: adapter.connected ? 'healthy' : 'disconnected',
        ...adapter.getStatus(),
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Embeddable Widget JavaScript (self-contained, no dependencies)
// ---------------------------------------------------------------------------

function generateRuntimeEmbedHtml(agentBaseUrl: string): string {
  const safeBase = agentBaseUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shogo Chat</title>
<style>
html,body{height:100%;margin:0}body{font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;color:#171717}
.shogo-chat{height:100%;display:flex;flex-direction:column;background:#fff}.header{display:flex;gap:10px;align-items:center;padding:14px 16px;border-bottom:1px solid #e5e5e5}.avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#6366f1;color:#fff;font-weight:700}.title{flex:1}.title span{display:block;color:#737373;font-size:12px}.thread{display:flex;flex:1;flex-direction:column;gap:14px;overflow:auto;padding:18px}.msg{max-width:88%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}.user{align-self:flex-end;background:#6366f1;color:#fff}.agent{align-self:flex-start;background:#f5f5f5}.composer{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e5e5}.composer textarea{flex:1;resize:none;border:1px solid #e5e5e5;border-radius:10px;padding:9px}.composer button{min-width:72px;border:0;border-radius:10px;background:#6366f1;color:#fff}.powered{text-align:center;padding:6px;color:#737373;font-size:10px;border-top:1px solid #e5e5e5}
</style></head><body><main class="shogo-chat"><header class="header"><div class="avatar">S</div><div class="title"><strong id="title">Chat with us</strong><span id="subtitle"></span></div></header><div class="thread" id="thread"></div><div class="composer"><textarea id="input" rows="1" placeholder="Type a message..."></textarea><button id="send">Send</button></div><div class="powered">Powered by Shogo</div></main>
<script>
(function(){
var q=new URL(location.href).searchParams, api='${safeBase}', key=q.get('widgetKey')||'', parent=q.get('parentOrigin')||document.referrer, sessionId=null, token=null, busy=false;
var thread=document.getElementById('thread'), input=document.getElementById('input'), send=document.getElementById('send');
function headers(extra){var h=Object.assign({'Content-Type':'application/json'},extra||{});if(key)h['X-WebChat-Widget-Key']=key;if(parent)h['X-Shogo-Embed-Origin']=parent;return h}
function add(role,text){var el=document.createElement('div');el.className='msg '+(role==='user'?'user':'agent');el.textContent=text;thread.appendChild(el);thread.scrollTop=thread.scrollHeight;return el}
function init(){fetch(api+'/agent/channels/webchat/config',{headers:headers()}).then(function(r){return r.json()}).then(function(c){document.getElementById('title').textContent=c.title||'Chat with us';document.getElementById('subtitle').textContent=c.subtitle||'';input.placeholder=c.placeholder||'Type a message...';if(c.primaryColor){document.documentElement.style.setProperty('--primary',c.primaryColor)}return fetch(api+'/agent/channels/webchat/session',{method:'POST',headers:headers(),body:JSON.stringify({})})}).then(function(r){return r.json()}).then(function(d){sessionId=d.sessionId;token=d.sessionToken;return fetch(api+'/agent/channels/webchat/history?sessionId='+encodeURIComponent(sessionId),{headers:headers({'X-WebChat-Session-Token':token})})}).then(function(r){return r.json()}).then(function(d){(d.messages||[]).forEach(function(m){var text=(m.parts||[]).filter(function(p){return p.type==='text'}).map(function(p){return p.text}).join('');if(text)add(m.role,text)})}).catch(function(e){console.warn('[Shogo WebChat]',e)})}
function sendMessage(){var text=input.value.trim();if(!text||busy||!sessionId)return;input.value='';add('user',text);busy=true;send.textContent='Stop';fetch(api+'/agent/channels/webchat/message',{method:'POST',headers:headers({'X-WebChat-Session-Token':token,'X-WebChat-Session':sessionId,'Accept':'text/event-stream'}),body:JSON.stringify({message:text,sessionId:sessionId})}).then(function(r){if(!r.ok)throw new Error('Chat request failed');var reader=r.body.getReader(),decoder=new TextDecoder(),buffer='',agent=null;function read(){return reader.read().then(function(x){if(x.done){busy=false;send.textContent='Send';return}buffer+=decoder.decode(x.value,{stream:true});var frames=buffer.split(/\\\\r?\\\\n\\\\r?\\\\n/);buffer=frames.pop()||'';frames.forEach(function(frame){var line=frame.split(/\\\\r?\\\\n/).find(function(v){return v.indexOf('data:')===0});if(!line)return;try{var event=JSON.parse(line.slice(5).trim());if(event.type==='text-delta'){if(!agent)agent=add('agent','');agent.textContent+=event.delta;thread.scrollTop=thread.scrollHeight}}catch(e){}});return read()})}return read()}).catch(function(e){busy=false;send.textContent='Send';add('agent','Sorry, something went wrong. Please try again.')})}
send.addEventListener('click',sendMessage);input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});init();
}());
</script></body></html>`
}

function generateEmbedLoader(agentBaseUrl: string): string {
  const fallbackUrl = agentBaseUrl.replace(/'/g, "\\'")
  return `(function(){
  "use strict";
  if (window.__shogoChatEmbed) return;
  window.__shogoChatEmbed = true;
  var script = document.currentScript;
  var source = script && script.src ? script.src : "";
  var marker = "/agent/channels/webchat/widget.js";
  var agentUrl = source.indexOf(marker) >= 0 ? source.split(marker)[0] : '${fallbackUrl}';
  var query = source.indexOf("?") >= 0 ? source.slice(source.indexOf("?")) : "";
  var frame = document.createElement("iframe");
  frame.title = "Chat";
  frame.allow = "clipboard-write";
  frame.style.cssText = "position:fixed;right:20px;bottom:84px;width:min(400px,calc(100vw - 40px));height:min(640px,calc(100vh - 110px));border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.2);z-index:2147482999;display:none;background:#fff";
  frame.src = agentUrl + "/agent/channels/webchat/embed/index.html" + query + (query ? "&" : "?") + "parentOrigin=" + encodeURIComponent(location.origin);
  var button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label","Open chat");
  button.textContent = "○";
  button.style.cssText = "position:fixed;right:20px;bottom:20px;width:56px;height:56px;border:0;border-radius:50%;background:#6366f1;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.2);font-size:24px;z-index:2147483000;cursor:pointer";
  var open = false;
  button.onclick = function(){ open = !open; frame.style.display = open ? "block" : "none"; button.textContent = open ? "×" : "○"; };
  document.body.appendChild(frame);
  document.body.appendChild(button);
})();`
}

function generateWidgetScript(agentBaseUrl: string): string {
  return generateEmbedLoader(agentBaseUrl)
  /*
  const fallbackUrl = agentBaseUrl.replace(/'/g, "\\'")
  return `(function() {
  "use strict";
  if (window.__shogoWebChat) return;
  window.__shogoWebChat = true;

  var AGENT_URL = (function() {
    try {
      var s = document.currentScript;
      var marker = "/agent/channels/webchat/widget.js";
      if (s && s.src && s.src.indexOf(marker) !== -1) {
        return s.src.split(marker)[0];
      }
    } catch(e) {}
    return '${fallbackUrl}';
  })();
  var SCRIPT_WIDGET_KEY = (function() {
    try {
      var s = document.currentScript;
      if (!s || !s.src) return "";
      var url = new URL(s.src);
      return url.searchParams.get("widgetKey") || "";
    } catch(e) {
      return "";
    }
  })();
  function wcUrl(path, query) {
    var url = AGENT_URL + path;
    if (query) {
      url += (path.indexOf("?") === -1 ? "?" : "&") + query;
    }
    return url;
  }
  var SESSION_KEY = "shogo_webchat_session";
  var SESSION_TOKEN_KEY = "shogo_webchat_session_token";
  var HISTORY_KEY = "shogo_webchat_history";

  var config = null;
  var sessionId = null;
  var isOpen = false;
  var isLoading = false;
  var container, bubble, chatWindow, messagesEl, inputEl;

  function getStoredSession() {
    try { return localStorage.getItem(SESSION_KEY); } catch(e) { return null; }
  }
  function storeSession(id) {
    try { localStorage.setItem(SESSION_KEY, id); } catch(e) {}
  }
  function getStoredSessionToken() {
    try { return localStorage.getItem(SESSION_TOKEN_KEY); } catch(e) { return null; }
  }
  function storeSessionToken(token) {
    try { localStorage.setItem(SESSION_TOKEN_KEY, token); } catch(e) {}
  }
  function getStoredHistory() {
    try {
      var h = localStorage.getItem(HISTORY_KEY);
      return h ? JSON.parse(h) : [];
    } catch(e) { return []; }
  }
  function storeHistory(messages) {
    try {
      var last50 = messages.slice(-50);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(last50));
    } catch(e) {}
  }

  function init() {
    if (!SCRIPT_WIDGET_KEY) {
      console.warn("[Shogo WebChat] Missing widgetKey in script URL.");
      return;
    }
    fetch(wcUrl("/agent/channels/webchat/config"), {
      headers: {
        "X-WebChat-Widget-Key": SCRIPT_WIDGET_KEY
      }
    })
      .then(function(r) { return r.json(); })
      .then(function(cfg) {
        config = cfg;
        createWidget();
        initSession();
      })
      .catch(function(err) {
        console.warn("[Shogo WebChat] Failed to load config:", err);
      });
  }

  function initSession() {
    var existing = getStoredSession();
    var headers = {
      "Content-Type": "application/json",
      "X-WebChat-Widget-Key": SCRIPT_WIDGET_KEY
    };
    if (existing) headers["X-WebChat-Session"] = existing;
    fetch(wcUrl("/agent/channels/webchat/session"), {
      method: "POST",
      headers: headers,
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.sessionId || !data.sessionToken) {
        throw new Error("Missing session credentials");
      }
      sessionId = data.sessionId;
      storeSession(sessionId);
      storeSessionToken(data.sessionToken);
      connectSSE();
    })
    .catch(function(err) {
      console.warn("[Shogo WebChat] Session init failed:", err);
    });
  }

  function connectSSE() {
    if (!sessionId) return;
    var token = getStoredSessionToken();
    if (!token) return;
    var es = new EventSource(wcUrl("/agent/channels/webchat/events/" + sessionId, "sessionToken=" + encodeURIComponent(token)));

    es.addEventListener("message", function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === "agent_message") {
          addMessage("agent", data.content);
          setLoading(false);
        }
      } catch(err) {}
    });

    es.addEventListener("connected", function() {});
    es.addEventListener("ping", function() {});

    es.onerror = function() {
      setTimeout(function() { connectSSE(); }, 5000);
    };
  }

  function sendMessage(text) {
    if (!text.trim() || !sessionId || isLoading) return;
    addMessage("user", text);
    setLoading(true);

    fetch(wcUrl("/agent/channels/webchat/message"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WebChat-Session-Token": getStoredSessionToken() || ""
      },
      body: JSON.stringify({ message: text, sessionId: sessionId })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.reply) {
        addMessage("agent", data.reply);
      }
      setLoading(false);
    })
    .catch(function(err) {
      addMessage("agent", "Sorry, something went wrong. Please try again.");
      setLoading(false);
    });
  }

  var chatMessages = [];

  function addMessage(role, content) {
    chatMessages.push({ role: role, content: content, time: Date.now() });
    storeHistory(chatMessages);
    renderMessages();
  }

  function setLoading(val) {
    isLoading = val;
    if (inputEl) inputEl.disabled = val;
    var dots = container && container.querySelector(".shogo-typing");
    if (dots) dots.style.display = val ? "flex" : "none";
  }

  function renderMessages() {
    if (!messagesEl) return;
    messagesEl.innerHTML = "";
    chatMessages.forEach(function(msg) {
      var div = document.createElement("div");
      div.className = "shogo-msg shogo-msg-" + msg.role;
      div.textContent = msg.content;
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function createWidget() {
    var color = config.primaryColor || "#6366f1";
    var pos = config.position || "bottom-right";
    var isLeft = pos === "bottom-left";

    var style = document.createElement("style");
    style.textContent = \`
      .shogo-container { position:fixed; bottom:20px; \${isLeft?"left":"right"}:20px; z-index:99999; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
      .shogo-bubble { width:56px; height:56px; border-radius:50%; background:\${color}; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(0,0,0,0.15); transition:transform 0.2s,box-shadow 0.2s; border:none; }
      .shogo-bubble:hover { transform:scale(1.08); box-shadow:0 6px 20px rgba(0,0,0,0.2); }
      .shogo-bubble svg { width:26px; height:26px; fill:white; }
      .shogo-window { display:none; position:absolute; bottom:70px; \${isLeft?"left":"right"}:0; width:380px; max-width:calc(100vw - 40px); height:520px; max-height:calc(100vh - 120px); background:#fff; border-radius:16px; box-shadow:0 8px 30px rgba(0,0,0,0.12); overflow:hidden; flex-direction:column; animation:shogo-slide-up 0.25s ease-out; }
      .shogo-window.open { display:flex; }
      @keyframes shogo-slide-up { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
      .shogo-header { background:\${color}; color:#fff; padding:16px 20px; display:flex; align-items:center; gap:12px; }
      .shogo-header-text h3 { margin:0; font-size:15px; font-weight:600; }
      .shogo-header-text p { margin:2px 0 0; font-size:12px; opacity:0.85; }
      .shogo-close { background:none; border:none; color:#fff; cursor:pointer; margin-left:auto; padding:4px; opacity:0.8; font-size:20px; line-height:1; }
      .shogo-close:hover { opacity:1; }
      .shogo-messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; }
      .shogo-msg { max-width:85%; padding:10px 14px; border-radius:16px; font-size:14px; line-height:1.45; word-wrap:break-word; white-space:pre-wrap; }
      .shogo-msg-user { align-self:flex-end; background:\${color}; color:#fff; border-bottom-right-radius:4px; }
      .shogo-msg-agent { align-self:flex-start; background:#f0f0f0; color:#1a1a1a; border-bottom-left-radius:4px; }
      .shogo-typing { display:none; align-self:flex-start; padding:10px 14px; background:#f0f0f0; border-radius:16px; border-bottom-left-radius:4px; gap:4px; align-items:center; }
      .shogo-typing span { width:6px; height:6px; border-radius:50%; background:#999; animation:shogo-dot 1.4s infinite; }
      .shogo-typing span:nth-child(2) { animation-delay:0.2s; }
      .shogo-typing span:nth-child(3) { animation-delay:0.4s; }
      @keyframes shogo-dot { 0%,60%,100%{opacity:0.3;transform:scale(0.8)} 30%{opacity:1;transform:scale(1)} }
      .shogo-input-bar { display:flex; padding:12px; border-top:1px solid #e5e5e5; gap:8px; background:#fff; }
      .shogo-input-bar input { flex:1; border:1px solid #ddd; border-radius:24px; padding:10px 16px; font-size:14px; outline:none; transition:border-color 0.2s; }
      .shogo-input-bar input:focus { border-color:\${color}; }
      .shogo-input-bar button { width:38px; height:38px; border-radius:50%; background:\${color}; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:opacity 0.2s; }
      .shogo-input-bar button:disabled { opacity:0.5; cursor:default; }
      .shogo-input-bar button svg { width:18px; height:18px; fill:#fff; }
      .shogo-avatar { width:32px; height:32px; border-radius:50%; background:rgba(255,255,255,0.2); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
      .shogo-avatar img { width:100%; height:100%; border-radius:50%; object-fit:cover; }
      .shogo-avatar svg { width:18px; height:18px; fill:#fff; }
      .shogo-powered { text-align:center; padding:6px; font-size:10px; color:#aaa; background:#fafafa; }
      .shogo-powered a { color:#888; text-decoration:none; }
      @media (max-width:480px) {
        .shogo-window { width:100vw; height:100vh; max-height:100vh; bottom:0; \${isLeft?"left":"right"}:-20px; border-radius:0; }
        .shogo-container { bottom:12px; \${isLeft?"left":"right"}:12px; }
      }
    \`;
    document.head.appendChild(style);

    container = document.createElement("div");
    container.className = "shogo-container";

    // Chat bubble
    bubble = document.createElement("button");
    bubble.className = "shogo-bubble";
    bubble.setAttribute("aria-label", "Open chat");
    bubble.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
    bubble.onclick = toggleChat;
    container.appendChild(bubble);

    // Chat window
    chatWindow = document.createElement("div");
    chatWindow.className = "shogo-window";
    chatWindow.innerHTML = [
      '<div class="shogo-header">',
        '<div class="shogo-avatar">' + (config.avatarUrl ? '<img src="' + config.avatarUrl + '" alt="avatar">' : '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>') + '</div>',
        '<div class="shogo-header-text"><h3>' + (config.title || "Chat with us") + '</h3>' + (config.subtitle ? '<p>' + config.subtitle + '</p>' : '') + '</div>',
        '<button class="shogo-close" aria-label="Close chat">&times;</button>',
      '</div>',
      '<div class="shogo-messages"></div>',
      '<div class="shogo-typing"><span></span><span></span><span></span></div>',
      '<div class="shogo-input-bar">',
        '<input type="text" placeholder="Type a message..." aria-label="Message">',
        '<button aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>',
      '</div>',
      '<div class="shogo-powered">Powered by <a href="https://shogo.ai" target="_blank" rel="noopener">Shogo</a></div>',
    ].join("");

    container.appendChild(chatWindow);
    document.body.appendChild(container);

    messagesEl = chatWindow.querySelector(".shogo-messages");
    inputEl = chatWindow.querySelector(".shogo-input-bar input");

    chatWindow.querySelector(".shogo-close").onclick = toggleChat;
    chatWindow.querySelector(".shogo-input-bar button").onclick = function() {
      sendMessage(inputEl.value);
      inputEl.value = "";
    };
    inputEl.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputEl.value);
        inputEl.value = "";
      }
    });

    // Restore history
    chatMessages = getStoredHistory();
    if (chatMessages.length > 0) {
      renderMessages();
    }
  }

  function toggleChat() {
    isOpen = !isOpen;
    if (chatWindow) chatWindow.classList.toggle("open", isOpen);
    if (bubble) bubble.style.display = isOpen ? "none" : "flex";
    if (isOpen && inputEl) inputEl.focus();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();`
  */
}
