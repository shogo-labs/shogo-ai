// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

export type VisualMode = 'canvas' | 'app' | 'none'

export interface AgentStatus {
  status: string
  uptime?: number
  model?: { provider: string; name: string }
  activeMode?: VisualMode
  heartbeat?: { enabled: boolean; interval: number; lastRun?: string }
  channels?: Array<{ type: string; connected: boolean }>
  sessions?: number
  memoryEnabled?: boolean
  canvasEnabled?: boolean
  [key: string]: unknown
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  id?: string
  createdAt?: string
  parts?: ChatMessagePart[]
}

export interface ChatMessagePart {
  type: string
  text?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
  [key: string]: unknown
}

export interface ChatOptions {
  sessionId?: string
  agentMode?: string
  userId?: string
  timezone?: string
}

export interface ChatStreamEvent {
  type: string
  data?: unknown
}

export interface Surface {
  id: string
  title?: string
  components: CanvasComponent[]
  data: Record<string, unknown>
  apiConfig?: Record<string, unknown>
}

export interface CanvasComponent {
  id: string
  component: string
  children?: string[] | { path: string; templateId?: string }
  child?: string
  [key: string]: unknown
}

export interface CanvasState {
  surfaces: Record<string, Surface>
}

export interface ActionContext {
  [key: string]: unknown
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: FileNode[]
}

export interface SearchResult {
  path: string
  content: string
  score: number
  highlights?: string[]
}

export interface AgentClientConfig {
  baseUrl?: string
  headers?: Record<string, string>
}
