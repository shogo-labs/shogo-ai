/**
 * Microsoft Teams Channel Adapter
 *
 * Connects to Microsoft Teams via the Bot Framework REST API.
 * Teams POSTs "Activity" objects to a messaging endpoint; the adapter
 * authenticates outbound replies using an Azure AD app token.
 *
 * **No public URL is needed during local development** — you can use ngrok
 * to tunnel the agent runtime and set the tunnel URL as the bot's messaging
 * endpoint in the Azure Bot resource.
 *
 * Config:
 *   appId       — Microsoft App ID (from Azure Bot registration)
 *   appPassword — Microsoft App Password (client secret)
 *
 * The messaging endpoint is automatically registered at:
 *   POST /agent/channels/teams/messages
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

const OAUTH_URL = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token'
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default'

interface TeamsConversationRef {
  serviceUrl: string
  conversationId: string
  activityId?: string
}

export class TeamsAdapter implements ChannelAdapter {
  private appId: string = ''
  private appPassword: string = ''
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private botName: string = ''

  private accessToken: string = ''
  private tokenExpiry: number = 0

  private conversations = new Map<string, TeamsConversationRef>()

  constructor(config?: Record<string, string>) {
    if (config?.appId) this.appId = config.appId
    if (config?.appPassword) this.appPassword = config.appPassword
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter interface
  // ---------------------------------------------------------------------------

  async connect(config: Record<string, string>): Promise<void> {
    this.appId = config.appId
    this.appPassword = config.appPassword

    if (!this.appId) throw new Error('Microsoft App ID is required')
    if (!this.appPassword) throw new Error('Microsoft App Password is required')

    await this.getAccessToken()

    this.connected = true
    this.error = undefined
    this.botName = config.botName || 'Shogo Agent'
    console.log(`[Teams] Connected as ${this.botName} (appId: ${this.appId.substring(0, 8)}...)`)
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
      console.error(`[Teams] No conversation reference for channel: ${channelId}`)
      return
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
      console.error(`[Teams] Failed to send message (${res.status}): ${body}`)
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

    return res.ok
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

    this.conversations.set(conversationId, {
      serviceUrl: serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`,
      conversationId,
      activityId,
    })

    switch (activity.type) {
      case 'message': {
        const text = activity.text || ''
        const cleanText = this.stripMentions(text, activity)

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
          try {
            await this.sendMessage(conversationId, `👋 Hi! I'm **${this.botName}**. How can I help you?`)
          } catch (err: any) {
            console.error('[Teams] Failed to send welcome message:', err.message)
          }
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

    const res = await fetch(OAUTH_URL, {
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

      const activity = await c.req.json()
      const result = await adapter.handleActivity(activity)
      return c.json(result.body || {}, result.status)
    })
  }
}
