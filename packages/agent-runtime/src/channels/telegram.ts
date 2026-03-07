// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Telegram Channel Adapter
 *
 * Connects to the Telegram Bot API using long polling.
 * Requires a bot token from @BotFather.
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

const TELEGRAM_API = 'https://api.telegram.org'

export class TelegramAdapter implements ChannelAdapter {
  private botToken: string = ''
  private polling = false
  private pollingTimeout: ReturnType<typeof setTimeout> | null = null
  private lastUpdateId = 0
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private botUsername: string = ''

  constructor(config?: Record<string, string>) {
    if (config?.botToken) {
      this.botToken = config.botToken
    }
  }

  async connect(config: Record<string, string>): Promise<void> {
    this.botToken = config.botToken
    if (!this.botToken) {
      throw new Error('Telegram bot token is required')
    }

    // Verify the token
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getMe`)
      if (!response.ok) {
        throw new Error(`Invalid bot token: ${response.statusText}`)
      }
      const data = (await response.json()) as { ok: boolean; result?: { username?: string } }
      if (!data.ok) {
        throw new Error('Invalid bot token')
      }
      this.botUsername = data.result?.username || 'unknown'
      console.log(`[Telegram] Connected as @${this.botUsername}`)
    } catch (error: any) {
      this.error = error.message
      throw error
    }

    this.connected = true
    this.error = undefined
    this.startPolling()
  }

  async disconnect(): Promise<void> {
    this.polling = false
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout)
      this.pollingTimeout = null
    }
    this.connected = false
    console.log('[Telegram] Disconnected')
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    if (!this.botToken) {
      throw new Error('Not connected')
    }

    const response = await fetch(
      `${TELEGRAM_API}/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: content,
          parse_mode: 'Markdown',
        }),
      }
    )

    if (!response.ok) {
      const error = await response.text()
      console.error('[Telegram] Failed to send message:', error)
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'telegram',
      connected: this.connected,
      error: this.error,
      metadata: {
        botUsername: this.botUsername,
        polling: this.polling,
      },
    }
  }

  private startPolling(): void {
    this.polling = true
    this.poll()
  }

  private async poll(): Promise<void> {
    if (!this.polling) return

    try {
      const response = await fetch(
        `${TELEGRAM_API}/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=30`,
        { signal: AbortSignal.timeout(35000) }
      )

      if (response.ok) {
        const data = (await response.json()) as {
          ok: boolean
          result: Array<{
            update_id: number
            message?: {
              message_id: number
              from?: { id: number; first_name?: string; username?: string }
              chat: { id: number; type: string }
              text?: string
              date: number
            }
          }>
        }

        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            this.lastUpdateId = update.update_id

            if (update.message?.text && this.messageHandler) {
              this.messageHandler({
                text: update.message.text,
                channelId: String(update.message.chat.id),
                channelType: 'telegram',
                senderId: String(update.message.from?.id || ''),
                senderName:
                  update.message.from?.first_name ||
                  update.message.from?.username ||
                  'Unknown',
                timestamp: update.message.date * 1000,
              })
            }
          }
        }
      }
    } catch (error: any) {
      if (!error.message?.includes('abort')) {
        console.error('[Telegram] Polling error:', error.message)
        this.error = error.message
      }
    }

    // Continue polling
    if (this.polling) {
      this.pollingTimeout = setTimeout(() => this.poll(), 100)
    }
  }
}
