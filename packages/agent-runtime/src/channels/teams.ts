// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Microsoft Teams Channel Adapter
 *
 * Connects to Microsoft Teams via the Bot Framework REST API.
 * Teams POSTs "Activity" objects to a messaging endpoint; the adapter
 * authenticates outbound replies using an Azure AD app token and validates
 * inbound JWTs via botframework-auth.ts (WebCrypto RS256, no new dependency).
 *
 * Config:
 *   appId       — Microsoft App ID (from Azure Bot registration)
 *   appPassword — Microsoft App Password (client secret)
 *   tenantId    — (optional) Directory (tenant) ID; enables single-tenant mode
 *   botName     — (optional) Display name shown in welcome messages
 *
 * The messaging endpoint is automatically registered at:
 *   POST /agent/channels/teams/messages
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'
import { validateBotFrameworkJwt } from './botframework-auth'

const BF_OAUTH_URL = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token'
const AAD_OAUTH_URL_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token'
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default'

/** Max conversation refs kept in memory and on disk. */
const MAX_REFS = 5000

interface TeamsConversationRef {
  serviceUrl: string
  conversationId: string
  tenantId?: string
}

export class TeamsAdapter implements ChannelAdapter {
  private appId: string = ''
  private appPassword: string = ''
  private tenantId: string | undefined
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private botName: string = ''

  private accessToken: string = ''
  private tokenExpiry: number = 0

  /** In-memory conversation refs (conversationId → ref). */
  private conversations = new Map<string, TeamsConversationRef>()

  /** Directory where refs are persisted (.shogo/channels/). */
  private workspaceDir: string | undefined

  constructor(config?: Record<string, string>) {
    if (config?.appId) this.appId = config.appId
    if (config?.appPassword) this.appPassword = config.appPassword
    if (config?.tenantId) this.tenantId = config.tenantId
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter interface
  // ---------------------------------------------------------------------------

  async connect(config: Record<string, string>, workspaceDir?: string): Promise<void> {
    this.appId = config.appId
    this.appPassword = config.appPassword
    this.tenantId = config.tenantId || undefined
    this.workspaceDir = workspaceDir

    if (!this.appId) throw new Error('Microsoft App ID is required')
    if (!this.appPassword) throw new Error('Microsoft App Password is required')

    await this.getAccessToken()

    this.loadRefs()
    this.connected = true
    this.error = undefined
    this.botName = config.botName || 'Shogo Agent'
    console.log(
      `[Teams] Connected as ${this.botName} (appId: ${this.appId.substring(0, 8)}..., ` +
      `mode: ${this.tenantId ? `single-tenant ${this.tenantId.substring(0, 8)}...` : 'multi-tenant'})`
    )
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.accessToken = ''
    this.tokenExpiry = 0
    this.conversations.clear()
    console.log('[Teams] Disconnected')
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const ref = this.conversations.get(channelId)
    if (!ref) {
      throw new Error(`[Teams] no conversation with ${channelId} yet: the user has to message the bot first`)
    }

    const token = await this.getAccessToken()
    const url = `${ref.serviceUrl}v3/conversations/${ref.conversationId}/activities`

    const activity = {
      type: 'message',
      text: content,
      textFormat: 'markdown',
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(activity),
    })

    if (!res.ok) {
      const body = await res.text()
      let code: string | undefined
      try { code = (JSON.parse(body) as any)?.error?.code } catch { /* noop */ }
      throw new Error(
        `[Teams] send failed (${res.status}${code ? ` ${code}` : ''}): ${body.slice(0, 200)}`
      )
    }
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<boolean> {
    const ref = this.conversations.get(channelId)
    if (!ref) return false

    const token = await this.getAccessToken()
    const url = `${ref.serviceUrl}v3/conversations/${ref.conversationId}/activities/${messageId}`

    const activity = {
      type: 'message',
      text: content,
      textFormat: 'markdown',
    }

    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(activity),
    })

    if (!res.ok) {
      const body = await res.text()
      let code: string | undefined
      try { code = (JSON.parse(body) as any)?.error?.code } catch { /* noop */ }
      throw new Error(
        `[Teams] edit failed (${res.status}${code ? ` ${code}` : ''}): ${body.slice(0, 200)}`
      )
    }
    return true
  }

  async sendTyping(channelId: string): Promise<void> {
    const ref = this.conversations.get(channelId)
    if (!ref) return

    const token = await this.getAccessToken()
    const url = `${ref.serviceUrl}v3/conversations/${ref.conversationId}/activities`

    const activity = { type: 'typing' }

    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(activity),
    }).catch(() => {
      // Typing indicator failures are non-critical
    })
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'teams',
      connected: this.connected,
      error: this.error,
      metadata: {
        appId: this.appId ? `${this.appId.substring(0, 8)}...` : undefined,
        botName: this.botName,
        conversations: this.conversations.size,
        tenantMode: this.tenantId ? 'single-tenant' : 'multi-tenant',
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Incoming Activity Processing (called by the server route)
  // ---------------------------------------------------------------------------

  async handleActivity(activity: any): Promise<{ status: number; body?: any }> {
    if (!this.connected) {
      return { status: 503, body: { error: 'Teams channel not connected' } }
    }

    const serviceUrl = activity.serviceUrl
    const conversationId = activity.conversation?.id
    const activityId = activity.id

    if (!serviceUrl || !conversationId) {
      return { status: 400, body: { error: 'Invalid activity: missing serviceUrl or conversation' } }
    }

    // Record conversation ref (from validated activity only — called after JWT check)
    const normalizedServiceUrl = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`
    const ref: TeamsConversationRef = {
      serviceUrl: normalizedServiceUrl,
      conversationId,
      tenantId: activity.channelData?.tenant?.id,
    }
    this.conversations.set(conversationId, ref)
    this.persistRefs()

    switch (activity.type) {
      case 'message': {
        const rawText = activity.text || ''
        const cleanText = this.stripMentions(rawText, activity)

        if (cleanText.trim() && this.messageHandler) {
          this.messageHandler({
            text: cleanText.trim(),
            channelId: conversationId,
            channelType: 'teams',
            senderId: activity.from?.id,
            senderName: activity.from?.name || activity.from?.id,
            timestamp: activity.timestamp
              ? new Date(activity.timestamp).getTime()
              : Date.now(),
            metadata: {
              activityId,
              serviceUrl,
              tenantId: activity.channelData?.tenant?.id,
              channelId: activity.channelData?.channel?.id,
              teamId: activity.channelData?.team?.id,
            },
          })
        }
        return { status: 200 }
      }

      case 'conversationUpdate': {
        const membersAdded = activity.membersAdded || []
        const botWasAdded = membersAdded.some(
          (m: any) => m.id === activity.recipient?.id
        )

        if (botWasAdded) {
          // Send welcome after returning 200 (detached)
          this.sendMessage(conversationId, `👋 Hi! I'm **${this.botName}**. How can I help you?`).catch(
            (err: any) => console.error('[Teams] Failed to send welcome message:', err.message)
          )
        }
        return { status: 200 }
      }

      case 'typing':
        return { status: 200 }

      default:
        return { status: 200 }
    }
  }

  // ---------------------------------------------------------------------------
  // Azure AD Token Management
  // ---------------------------------------------------------------------------

  private oauthUrl(): string {
    if (this.tenantId) {
      return AAD_OAUTH_URL_TEMPLATE.replace('{tenantId}', this.tenantId)
    }
    // Test authority override
    if (process.env.NODE_ENV === 'test' && process.env.SHOGO_TEAMS_TEST_AUTHORITY) {
      return `${process.env.SHOGO_TEAMS_TEST_AUTHORITY}/oauth2/v2.0/token`
    }
    return BF_OAUTH_URL
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 5 * 60 * 1000) {
      return this.accessToken
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.appId,
      client_secret: this.appPassword,
      scope: BOT_FRAMEWORK_SCOPE,
    })

    const res = await fetch(this.oauthUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!res.ok) {
      const errText = await res.text()
      this.error = `Azure AD auth failed (${res.status})`
      throw new Error(`Failed to get Azure AD token: ${res.status} ${errText}`)
    }

    const data = (await res.json()) as {
      access_token: string
      expires_in: number
    }

    this.accessToken = data.access_token
    this.tokenExpiry = Date.now() + data.expires_in * 1000
    return this.accessToken
  }

  // ---------------------------------------------------------------------------
  // Conversation ref persistence
  // ---------------------------------------------------------------------------

  private refsPath(): string | undefined {
    if (!this.workspaceDir) return undefined
    // Avoid importing path at module load time (stays portable)
    const sep = this.workspaceDir.includes('/') ? '/' : '\\'
    return `${this.workspaceDir}${sep}.shogo${sep}channels${sep}teams-conversations.json`
  }

  private loadRefs(): void {
    const p = this.refsPath()
    if (!p) return
    try {
      const { existsSync, readFileSync } = require('fs') as typeof import('fs')
      if (!existsSync(p)) return
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as TeamsConversationRef[]
      for (const ref of raw) {
        if (ref.conversationId) this.conversations.set(ref.conversationId, ref)
      }
    } catch (err: any) {
      console.warn('[Teams] Could not load conversation refs:', err.message)
    }
  }

  private persistRefs(): void {
    const p = this.refsPath()
    if (!p) return
    try {
      const { mkdirSync, writeFileSync } = require('fs') as typeof import('fs')
      const dir = p.substring(0, p.lastIndexOf(p.includes('/') ? '/' : '\\'))
      mkdirSync(dir, { recursive: true })

      // Newest-first, bounded at MAX_REFS
      const entries = Array.from(this.conversations.values()).slice(-MAX_REFS)
      writeFileSync(p, JSON.stringify(entries, null, 2), 'utf-8')
    } catch (err: any) {
      console.warn('[Teams] Could not persist conversation refs:', err.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private stripMentions(text: string, activity: any): string {
    let result = text
    const entities = activity.entities || []

    for (const entity of entities) {
      if (entity.type === 'mention' && entity.mentioned?.id === activity.recipient?.id) {
        if (entity.text) {
          result = result.replace(entity.text, '')
        }
      }
    }

    return result
  }

  static registerRoutes(
    app: any,
    getAdapter: () => TeamsAdapter | undefined
  ): void {
    app.post('/agent/channels/teams/messages', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter) {
        return c.json({ error: 'Teams channel not configured' }, 503)
      }

      // Read raw body text first (needed for JSON parse after JWT check)
      const rawBody = await c.req.text()

      // Validate Bot Framework JWT before parsing the body
      const authHeader = c.req.header('authorization') ?? c.req.header('Authorization')
      let activity: any
      try {
        activity = JSON.parse(rawBody)
      } catch {
        return c.json({ error: 'invalid JSON body' }, 400)
      }

      const authResult = await validateBotFrameworkJwt(authHeader, {
        appId: adapter.appId,
        tenantId: adapter.tenantId,
        channelId: activity.channelId ?? 'msteams',
        serviceUrl: activity.serviceUrl ?? '',
      })

      if (!authResult.ok) {
        console.warn(`[Teams] JWT rejected: ${authResult.reason}`)
        return c.json({ error: 'Unauthorized' }, 401)
      }

      // ACK immediately — handle async
      const ackResponse = c.json({}, 200)
      adapter.handleActivity(activity).catch((err: any) =>
        console.error('[Teams] handleActivity error:', err.message)
      )
      return ackResponse
    })
  }
}
