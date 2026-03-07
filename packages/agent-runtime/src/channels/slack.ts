// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Slack Channel Adapter
 *
 * Connects to Slack using the Web API + Socket Mode (no public URL needed).
 * Requires a bot token (xoxb-...) and app-level token (xapp-...).
 *
 * Socket Mode establishes a WebSocket connection to receive events,
 * so no inbound webhook/public URL is required — works behind firewalls.
 *
 * Required OAuth scopes: chat:write, channels:history, groups:history,
 * im:history, mpim:history, app_mentions:read
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

const SLACK_API = 'https://slack.com/api'

export class SlackAdapter implements ChannelAdapter {
  private botToken: string = ''
  private appToken: string = ''
  private ws: WebSocket | null = null
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private botUserId: string = ''
  private teamName: string = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config?: Record<string, string>) {
    if (config?.botToken) this.botToken = config.botToken
    if (config?.appToken) this.appToken = config.appToken
  }

  async connect(config: Record<string, string>): Promise<void> {
    this.botToken = config.botToken
    this.appToken = config.appToken

    if (!this.botToken) throw new Error('Slack bot token (xoxb-...) is required')
    if (!this.appToken) throw new Error('Slack app-level token (xapp-...) is required')

    const authRes = await this.slackApi('auth.test', {})
    if (!authRes.ok) throw new Error(`Slack auth failed: ${authRes.error}`)
    this.botUserId = authRes.user_id
    this.teamName = authRes.team || 'unknown'
    console.log(`[Slack] Authenticated as ${authRes.user} in ${this.teamName}`)

    await this.connectSocketMode()
    this.connected = true
    this.error = undefined
    console.log('[Slack] Connected via Socket Mode')
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close(1000, 'Disconnecting')
      this.ws = null
    }
    this.connected = false
    console.log('[Slack] Disconnected')
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.botToken) throw new Error('Not connected')

    const res = await this.slackApi('chat.postMessage', {
      channel: channelId,
      text: content,
    })

    if (!res.ok) {
      console.error(`[Slack] Failed to send message: ${res.error}`)
    }
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<boolean> {
    if (!this.botToken) return false

    const res = await this.slackApi('chat.update', {
      channel: channelId,
      ts: messageId,
      text: content,
    })

    return res.ok === true
  }

  async sendTyping(channelId: string): Promise<void> {
    // Slack doesn't have a typing indicator API for bots
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'slack',
      connected: this.connected,
      error: this.error,
      metadata: { botUserId: this.botUserId, team: this.teamName },
    }
  }

  // ---------------------------------------------------------------------------
  // Socket Mode
  // ---------------------------------------------------------------------------

  private async connectSocketMode(): Promise<void> {
    const res = await fetch(`${SLACK_API}/apps.connections.open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.appToken}` },
    })
    const data = (await res.json()) as { ok: boolean; url?: string; error?: string }
    if (!data.ok || !data.url) {
      throw new Error(`Socket Mode connection failed: ${data.error || 'no URL returned'}`)
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(data.url!)

      this.ws.onopen = () => {
        console.log('[Slack] WebSocket connected')
        resolve()
      }

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          this.handleSocketMessage(msg)
        } catch (err: any) {
          console.error('[Slack] Failed to parse message:', err.message)
        }
      }

      this.ws.onerror = () => {
        this.error = 'WebSocket error'
        reject(new Error('Socket Mode connection failed'))
      }

      this.ws.onclose = (event) => {
        console.log(`[Slack] WebSocket closed: ${event.code}`)
        this.connected = false
        if (event.code !== 1000 && this.botToken) {
          this.scheduleReconnect()
        }
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    console.log('[Slack] Reconnecting in 5s...')
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connectSocketMode()
        this.connected = true
        this.error = undefined
        console.log('[Slack] Reconnected')
      } catch (err: any) {
        console.error('[Slack] Reconnect failed:', err.message)
        this.error = err.message
        this.scheduleReconnect()
      }
    }, 5000)
  }

  private handleSocketMessage(msg: any): void {
    if (msg.type === 'disconnect') {
      console.log('[Slack] Server requested disconnect, reconnecting...')
      this.ws?.close()
      return
    }

    if (msg.envelope_id) {
      this.ws?.send(JSON.stringify({ envelope_id: msg.envelope_id }))
    }

    if (msg.type === 'events_api') {
      const event = msg.payload?.event
      if (!event) return

      if (event.type === 'message' && !event.subtype && event.user !== this.botUserId) {
        this.messageHandler?.({
          text: event.text || '',
          channelId: event.channel,
          channelType: 'slack',
          senderId: event.user,
          senderName: event.user,
          timestamp: event.ts ? parseFloat(event.ts) * 1000 : Date.now(),
          metadata: { threadTs: event.thread_ts },
        })
      }

      if (event.type === 'app_mention' && event.user !== this.botUserId) {
        const text = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim()
        if (text) {
          this.messageHandler?.({
            text,
            channelId: event.channel,
            channelType: 'slack',
            senderId: event.user,
            senderName: event.user,
            timestamp: event.ts ? parseFloat(event.ts) * 1000 : Date.now(),
            metadata: { threadTs: event.thread_ts, isMention: true },
          })
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Slack Web API helper
  // ---------------------------------------------------------------------------

  private async slackApi(method: string, body: Record<string, any>): Promise<any> {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.botToken}`,
      },
      body: JSON.stringify(body),
    })
    return res.json()
  }
}
