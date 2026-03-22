// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mock Channel Adapter
 *
 * In-memory implementation of ChannelAdapter for testing.
 */

import type { ChannelAdapter, ChannelStatus, IncomingMessage } from '../../types'

interface SentMessage {
  channelId: string
  content: string
  timestamp: number
}

export class MockChannel implements ChannelAdapter {
  public sentMessages: SentMessage[] = []
  public connected = false
  public channelType: string
  private messageHandler: ((msg: IncomingMessage) => void) | null = null

  constructor(type: string = 'mock') {
    this.channelType = type
  }

  async connect(_config: Record<string, string>): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    this.sentMessages.push({ channelId, content, timestamp: Date.now() })
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: this.channelType,
      connected: this.connected,
    }
  }

  /** Simulate receiving an incoming message */
  simulateMessage(text: string, channelId: string = 'test-chat'): void {
    if (this.messageHandler) {
      this.messageHandler({
        text,
        channelId,
        channelType: this.channelType,
        senderId: 'test-user',
        senderName: 'Test User',
        timestamp: Date.now(),
      })
    }
  }

  /** Get the last sent message content */
  lastSent(): string | undefined {
    return this.sentMessages[this.sentMessages.length - 1]?.content
  }

  /** Clear sent message history */
  clearSent(): void {
    this.sentMessages = []
  }
}
