// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

const SLACK_API = 'https://slack.com/api'

/**
 * HTTP-delivered Slack Agent adapter.
 *
 * The distributable workspace-level app normally terminates Events API
 * requests in apps/api and forwards chat turns through the project-chat proxy.
 * This adapter remains available for runtimes that are directly exposed or
 * are fed normalized Slack events by another ingress.
 */
export class SlackAgentAdapter implements ChannelAdapter {
  private botToken = ''
  private teamId = ''
  private botUserId = ''
  private connected = false
  private error: string | undefined
  private messageHandler: ((msg: IncomingMessage) => void) | null = null

  constructor(config?: Record<string, string>) {
    this.botToken = config?.botToken || ''
    this.teamId = config?.teamId || ''
    this.botUserId = config?.botUserId || ''
  }

  async connect(config: Record<string, string>): Promise<void> {
    this.botToken = config.botToken || this.botToken
    this.teamId = config.teamId || this.teamId
    this.botUserId = config.botUserId || this.botUserId
    if (!this.botToken) throw new Error('Slack bot token is required')
    const auth = await this.slackApi('auth.test', {})
    if (!auth.ok) throw new Error(`Slack auth failed: ${auth.error || 'unknown error'}`)
    this.botUserId = this.botUserId || auth.user_id || ''
    this.teamId = this.teamId || auth.team_id || ''
    this.connected = true
    this.error = undefined
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    const response = await this.slackApi('chat.postMessage', { channel: channelId, text: content })
    if (!response.ok) throw new Error(`Slack message failed: ${response.error || 'unknown error'}`)
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<boolean> {
    const response = await this.slackApi('chat.update', { channel: channelId, ts: messageId, text: content })
    return response.ok === true
  }

  async sendTyping(_channelId: string): Promise<void> {
    // Slack has no bot typing-indicator API.
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'slack-agent',
      connected: this.connected,
      error: this.error,
      metadata: { teamId: this.teamId, botUserId: this.botUserId },
    }
  }

  async receiveIncoming(message: IncomingMessage): Promise<void> {
    if (!this.connected) throw new Error('Slack Agent is not connected')
    this.messageHandler?.(message)
  }

  async setSessionStatus(channelId: string, threadTs: string, status: 'processing' | 'active' | 'suspended' | 'closed'): Promise<void> {
    const response = await this.slackApi('agents.sessions.setStatus', {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    })
    if (!response.ok) throw new Error(`Slack session status failed: ${response.error || 'unknown error'}`)
  }

  async renameSession(channelId: string, threadTs: string, title: string): Promise<void> {
    const response = await this.slackApi('agents.sessions.rename', {
      channel_id: channelId,
      thread_ts: threadTs,
      title,
    })
    if (!response.ok) throw new Error(`Slack session rename failed: ${response.error || 'unknown error'}`)
  }

  static registerRoutes(app: any, getAdapter: () => SlackAgentAdapter | null): void {
    app.post('/agent/channels/slack-agent/incoming', async (c: any) => {
      const adapter = getAdapter()
      if (!adapter) return c.json({ error: 'Slack Agent channel not configured' }, 503)
      const body = await c.req.json().catch(() => ({}))
      const message = body.message || body
      if (!message || typeof message.text !== 'string' || typeof message.channelId !== 'string') {
        return c.json({ error: 'message.text and message.channelId are required' }, 400)
      }
      await adapter.receiveIncoming(message as IncomingMessage)
      return c.json({ ok: true })
    })
  }

  private async slackApi(method: string, body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.botToken}`,
      },
      body: JSON.stringify(body),
    })
    return response.json()
  }
}
