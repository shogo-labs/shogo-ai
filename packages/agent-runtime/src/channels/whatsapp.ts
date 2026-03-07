// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WhatsApp Channel Adapter
 *
 * Connects to the WhatsApp Business Cloud API (Meta).
 * Uses webhook for receiving messages and REST API for sending.
 *
 * Requirements:
 * - Meta Business App with WhatsApp product enabled
 * - Phone number ID and access token from Meta Developer Console
 * - Webhook verification token (self-chosen secret)
 *
 * The adapter registers webhook routes on the agent runtime's Hono server
 * via the static `registerWebhookRoutes()` method, which should be called
 * once during server setup.
 */

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

const WHATSAPP_API = 'https://graph.facebook.com/v21.0'

export class WhatsAppAdapter implements ChannelAdapter {
  private accessToken: string = ''
  private phoneNumberId: string = ''
  private verifyToken: string = ''
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private displayPhoneNumber: string = ''

  /** Singleton map: phoneNumberId -> adapter instance (for webhook routing) */
  private static instances = new Map<string, WhatsAppAdapter>()

  constructor(config?: Record<string, string>) {
    if (config?.accessToken) this.accessToken = config.accessToken
    if (config?.phoneNumberId) this.phoneNumberId = config.phoneNumberId
    if (config?.verifyToken) this.verifyToken = config.verifyToken
  }

  async connect(config: Record<string, string>): Promise<void> {
    this.accessToken = config.accessToken
    this.phoneNumberId = config.phoneNumberId
    this.verifyToken = config.verifyToken || 'shogo-whatsapp-verify'

    if (!this.accessToken) throw new Error('WhatsApp access token is required')
    if (!this.phoneNumberId) throw new Error('WhatsApp phone number ID is required')

    const res = await fetch(`${WHATSAPP_API}/${this.phoneNumberId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`WhatsApp API validation failed: ${err}`)
    }

    const data = (await res.json()) as { display_phone_number?: string; verified_name?: string }
    this.displayPhoneNumber = data.display_phone_number || this.phoneNumberId
    console.log(`[WhatsApp] Connected as ${data.verified_name || this.displayPhoneNumber}`)

    WhatsAppAdapter.instances.set(this.phoneNumberId, this)
    this.connected = true
    this.error = undefined
  }

  async disconnect(): Promise<void> {
    WhatsAppAdapter.instances.delete(this.phoneNumberId)
    this.connected = false
    console.log('[WhatsApp] Disconnected')
  }

  async sendMessage(recipientPhone: string, content: string): Promise<void> {
    if (!this.accessToken) throw new Error('Not connected')

    const res = await fetch(`${WHATSAPP_API}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: content.substring(0, 4096) },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[WhatsApp] Failed to send message: ${err}`)
    }
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'whatsapp',
      connected: this.connected,
      error: this.error,
      metadata: {
        phoneNumberId: this.phoneNumberId,
        displayNumber: this.displayPhoneNumber,
      },
    }
  }

  /**
   * Process an incoming webhook payload from Meta.
   * Called by the webhook route handler.
   */
  handleWebhook(body: any): void {
    if (!body?.entry) return

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue

        const value = change.value
        if (!value?.messages) continue

        for (const msg of value.messages) {
          if (msg.type !== 'text') continue

          const contact = value.contacts?.find((c: any) => c.wa_id === msg.from)

          this.messageHandler?.({
            text: msg.text?.body || '',
            channelId: msg.from,
            channelType: 'whatsapp',
            senderId: msg.from,
            senderName: contact?.profile?.name || msg.from,
            timestamp: msg.timestamp ? parseInt(msg.timestamp, 10) * 1000 : Date.now(),
          })
        }
      }
    }
  }

  /**
   * Register WhatsApp webhook routes on the Hono app.
   * Call once during server setup. Routes handle both verification
   * (GET) and incoming messages (POST).
   */
  static registerWebhookRoutes(app: any): void {
    app.get('/webhooks/whatsapp', (c: any) => {
      const mode = c.req.query('hub.mode')
      const token = c.req.query('hub.verify_token')
      const challenge = c.req.query('hub.challenge')

      const adapter = [...WhatsAppAdapter.instances.values()][0]
      const expectedToken = adapter?.verifyToken || 'shogo-whatsapp-verify'

      if (mode === 'subscribe' && token === expectedToken) {
        console.log('[WhatsApp] Webhook verified')
        return c.text(challenge)
      }

      return c.text('Forbidden', 403)
    })

    app.post('/webhooks/whatsapp', async (c: any) => {
      const body = await c.req.json()

      const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id
      const adapter = phoneNumberId
        ? WhatsAppAdapter.instances.get(phoneNumberId)
        : [...WhatsAppAdapter.instances.values()][0]

      if (adapter) {
        adapter.handleWebhook(body)
      }

      return c.text('OK', 200)
    })
  }
}
