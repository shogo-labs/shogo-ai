// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared types for the agent runtime system.
 */

export interface IncomingMessage {
  text: string
  channelId: string
  channelType?: string
  senderId?: string
  senderName?: string
  timestamp?: number
  metadata?: Record<string, unknown>
}

export interface ChannelConfig {
  type: string
  config: Record<string, string>
}

export interface ChannelStatus {
  type: string
  connected: boolean
  error?: string
  metadata?: Record<string, unknown>
}

export interface ChannelAdapter {
  connect(config: Record<string, string>): Promise<void>
  disconnect(): Promise<void>
  sendMessage(channelId: string, content: string): Promise<void>
  /** Edit a previously sent message (for streaming updates). Returns false if unsupported. */
  editMessage?(channelId: string, messageId: string, content: string): Promise<boolean>
  /** Send a typing indicator. Called periodically during agent turns. */
  sendTyping?(channelId: string): Promise<void>
  onMessage(handler: (msg: IncomingMessage) => void): void
  getStatus(): ChannelStatus
}

export interface StreamChunkConfig {
  /** Min characters before flushing a chunk (default: 80) */
  minChars: number
  /** Max characters before force-flushing (default: 2000) */
  maxChars: number
  /** Idle time in ms before flushing whatever is buffered (default: 500) */
  idleMs: number
}

export interface SandboxConfig {
  enabled: boolean
  /** 'all' sandboxes every session, 'non-main' only sandboxes non-owner sessions */
  mode: 'all' | 'non-main'
  /** Docker image to use (default: 'ubuntu:22.04') */
  image: string
  /** Allow network access inside sandbox (default: false) */
  networkEnabled: boolean
  /** Memory limit (default: '256m') */
  memoryLimit: string
  /** CPU quota (default: '0.5') */
  cpuLimit: string
}

export interface AgentStatus {
  running: boolean
  heartbeat: {
    enabled: boolean
    intervalSeconds: number
    lastTick: string | null
    quietHours: { start: string; end: string; timezone: string }
  }
  channels: ChannelStatus[]
  skills: Array<{ name: string; trigger: string; description: string }>
  model: { provider: string; name: string }
  sessions?: Array<{
    id: string
    messageCount: number
    estimatedTokens: number
    compactedSummary: boolean
    compactionCount: number
    idleSeconds: number
  }>
}

export interface SkillDefinition {
  name: string
  version: string
  description: string
  trigger: string
  tools: string[]
  content: string
}

// =============================================================================
// Security & Permissions (Local Mode)
// =============================================================================

export type SecurityMode = 'strict' | 'balanced' | 'full_autonomy'

export type PermissionCategory =
  | 'shell'
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'network'
  | 'mcp'
  | 'system'

export interface SecurityPreference {
  mode: SecurityMode
  overrides?: {
    shellCommands?: { allow?: string[]; deny?: string[] }
    fileAccess?: { allow?: string[]; deny?: string[] }
    network?: { allowedDomains?: string[] }
    mcpTools?: { autoApprove?: string[] }
  }
  approvalTimeoutSeconds?: number
}

export interface PermissionCheckResult {
  action: 'allow' | 'deny' | 'ask'
  reason: string
  guidance?: string
  category: PermissionCategory
}

export interface PermissionRequest {
  id: string
  toolName: string
  category: PermissionCategory
  params: Record<string, any>
  reason: string
  timeout: number
}

export interface PermissionResponse {
  id: string
  decision: 'allow_once' | 'always_allow' | 'deny'
  pattern?: string
}
