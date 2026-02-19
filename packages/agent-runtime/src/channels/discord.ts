/**
 * Discord Channel Adapter
 *
 * Connects to the Discord Gateway using WebSocket.
 * Requires a bot token and guild ID.
 * Uses the Discord Gateway API directly (no discord.js dependency).
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'

export class DiscordAdapter implements ChannelAdapter {
  private botToken: string = ''
  private guildId: string = ''
  private ws: WebSocket | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private botUserId: string = ''
  private sequenceNumber: number | null = null
  private sessionId: string | null = null

  constructor(config?: Record<string, string>) {
    if (config?.botToken) this.botToken = config.botToken
    if (config?.guildId) this.guildId = config.guildId
  }

  async connect(config: Record<string, string>): Promise<void> {
    this.botToken = config.botToken
    this.guildId = config.guildId || ''

    if (!this.botToken) {
      throw new Error('Discord bot token is required')
    }

    // Verify the token
    try {
      const response = await fetch(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bot ${this.botToken}` },
      })
      if (!response.ok) {
        throw new Error(`Invalid bot token: ${response.statusText}`)
      }
      const data = (await response.json()) as { id: string; username: string }
      this.botUserId = data.id
      console.log(`[Discord] Authenticated as ${data.username}`)
    } catch (error: any) {
      this.error = error.message
      throw error
    }

    // Connect to Gateway
    await this.connectWebSocket()
    this.connected = true
    this.error = undefined
    console.log('[Discord] Connected')
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.ws) {
      this.ws.close(1000, 'Disconnecting')
      this.ws = null
    }
    this.connected = false
    console.log('[Discord] Disconnected')
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.botToken) {
      throw new Error('Not connected')
    }

    // Truncate to Discord's 2000 char limit
    const truncated =
      content.length > 2000 ? content.substring(0, 1997) + '...' : content

    const response = await fetch(
      `${DISCORD_API}/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${this.botToken}`,
        },
        body: JSON.stringify({ content: truncated }),
      }
    )

    if (!response.ok) {
      const error = await response.text()
      console.error('[Discord] Failed to send message:', error)
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'discord',
      connected: this.connected,
      error: this.error,
      metadata: {
        guildId: this.guildId,
        botUserId: this.botUserId,
      },
    }
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(DISCORD_GATEWAY)

      this.ws.onopen = () => {
        console.log('[Discord] WebSocket connected')
      }

      this.ws.onmessage = (event) => {
        const data = JSON.parse(String(event.data))
        this.handleGatewayMessage(data, resolve)
      }

      this.ws.onerror = (event) => {
        console.error('[Discord] WebSocket error')
        this.error = 'WebSocket error'
        reject(new Error('WebSocket connection failed'))
      }

      this.ws.onclose = (event) => {
        console.log(`[Discord] WebSocket closed: ${event.code} ${event.reason}`)
        this.connected = false

        // Attempt reconnect after 5 seconds (unless intentional disconnect)
        if (event.code !== 1000) {
          setTimeout(() => {
            if (this.botToken) {
              console.log('[Discord] Attempting reconnect...')
              this.connectWebSocket().catch((err) =>
                console.error('[Discord] Reconnect failed:', err.message)
              )
            }
          }, 5000)
        }
      }
    })
  }

  private handleGatewayMessage(
    data: { op: number; t?: string; s?: number; d?: any },
    onReady?: (value: void) => void
  ): void {
    if (data.s) {
      this.sequenceNumber = data.s
    }

    switch (data.op) {
      case 10: {
        // Hello — start heartbeating and identify
        const interval = data.d.heartbeat_interval
        this.startHeartbeating(interval)
        this.identify()
        break
      }

      case 11: {
        // Heartbeat ACK
        break
      }

      case 0: {
        // Dispatch
        this.handleDispatch(data.t!, data.d, onReady)
        break
      }
    }
  }

  private identify(): void {
    this.ws?.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.botToken,
          intents: 1 << 9 | 1 << 15, // GUILD_MESSAGES | MESSAGE_CONTENT
          properties: {
            os: 'linux',
            browser: 'shogo-agent',
            device: 'shogo-agent',
          },
        },
      })
    )
  }

  private startHeartbeating(intervalMs: number): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    this.heartbeatInterval = setInterval(() => {
      this.ws?.send(
        JSON.stringify({ op: 1, d: this.sequenceNumber })
      )
    }, intervalMs)
  }

  private handleDispatch(
    eventType: string,
    data: any,
    onReady?: (value: void) => void
  ): void {
    switch (eventType) {
      case 'READY': {
        this.sessionId = data.session_id
        console.log(`[Discord] Ready (session: ${this.sessionId})`)
        onReady?.()
        break
      }

      case 'MESSAGE_CREATE': {
        // Ignore own messages
        if (data.author.id === this.botUserId) return
        // Ignore bot messages
        if (data.author.bot) return

        // If guildId is set, only process messages from that guild
        if (this.guildId && data.guild_id !== this.guildId) return

        if (this.messageHandler && data.content) {
          this.messageHandler({
            text: data.content,
            channelId: data.channel_id,
            channelType: 'discord',
            senderId: data.author.id,
            senderName: data.author.username,
            timestamp: new Date(data.timestamp).getTime(),
          })
        }
        break
      }
    }
  }
}
