// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hook System Types
 *
 * Defines the event-driven hook system for the agent gateway.
 * Hooks respond to lifecycle events (messages, heartbeat, commands, startup).
 */

export interface HookEvent {
  type: 'message' | 'heartbeat' | 'gateway' | 'command' | 'tool' | 'agent' | 'compaction'
  action: string
  sessionKey: string
  timestamp: Date
  /** Push messages here to send back to the user */
  messages: string[]
  /** Event-specific data */
  context: Record<string, any>
}

export type HookHandler = (event: HookEvent) => Promise<void>

export interface Hook {
  name: string
  description: string
  events: string[]
  handler: HookHandler
}

export interface HookMetadata {
  name: string
  description: string
  events: string[]
  emoji?: string
}
