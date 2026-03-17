// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

import type {
  AgentClientConfig,
  AgentStatus,
  ChatMessage,
  ChatOptions,
  CanvasState,
  ActionContext,
  FileNode,
  SearchResult,
  VisualMode,
} from './types.js'

/**
 * Client for communicating with a Shogo agent runtime.
 *
 * Defaults to relative URLs so apps served from the same pod
 * can call agent APIs without configuration.
 *
 * @example
 * ```typescript
 * import { AgentClient } from '@shogo-ai/sdk/agent'
 *
 * const agent = new AgentClient()
 * const status = await agent.getStatus()
 * ```
 */
export class AgentClient {
  private baseUrl: string
  private headers: Record<string, string>

  constructor(config?: AgentClientConfig) {
    this.baseUrl = config?.baseUrl?.replace(/\/$/, '') ?? ''
    this.headers = config?.headers ?? {}
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: { ...this.headers, ...init?.headers },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Agent API ${res.status}: ${text}`)
    }
    return res.json() as Promise<T>
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<AgentStatus> {
    return this.fetchJson<AgentStatus>('/agent/status')
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  /**
   * Send a chat message and receive an SSE stream.
   * Returns the raw Response so callers can consume the stream
   * using the AI SDK, ReadableStream, or line-by-line parsing.
   */
  async chat(
    messages: Array<{ role: string; content?: string; parts?: Array<{ type: string; text?: string }> }>,
    options?: ChatOptions,
  ): Promise<Response> {
    const body: Record<string, unknown> = { messages }
    if (options?.sessionId) body.sessionId = options.sessionId
    if (options?.agentMode) body.agentMode = options.agentMode
    if (options?.userId) body.userId = options.userId
    if (options?.timezone) body.timezone = options.timezone

    const res = await fetch(this.url('/agent/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Agent chat ${res.status}: ${text}`)
    }
    return res
  }

  async getChatHistory(sessionId?: string): Promise<ChatMessage[]> {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
    return this.fetchJson<ChatMessage[]>(`/agent/chat/history${qs}`)
  }

  // ---------------------------------------------------------------------------
  // Canvas / Dynamic App
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to canvas surface updates via SSE.
   * Returns an EventSource — listen to `message` events for JSON payloads.
   */
  subscribeToCanvas(): EventSource {
    return new EventSource(this.url('/agent/dynamic-app/stream'))
  }

  async getCanvasState(): Promise<CanvasState> {
    return this.fetchJson<CanvasState>('/agent/dynamic-app/state')
  }

  async dispatchAction(
    surfaceId: string,
    actionName: string,
    context?: ActionContext,
  ): Promise<void> {
    await this.fetchJson('/agent/dynamic-app/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ surfaceId, name: actionName, context }),
    })
  }

  // ---------------------------------------------------------------------------
  // Workspace Files
  // ---------------------------------------------------------------------------

  async getWorkspaceTree(): Promise<FileNode[]> {
    return this.fetchJson<FileNode[]>('/agent/workspace/tree')
  }

  async readFile(path: string): Promise<string> {
    const res = await fetch(this.url(`/agent/workspace/files/${encodeURIComponent(path)}`), {
      headers: this.headers,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Agent readFile ${res.status}: ${text}`)
    }
    return res.text()
  }

  async writeFile(path: string, content: string): Promise<void> {
    const res = await fetch(this.url(`/agent/workspace/files/${encodeURIComponent(path)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', ...this.headers },
      body: content,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Agent writeFile ${res.status}: ${text}`)
    }
  }

  async deleteFile(path: string): Promise<void> {
    await this.fetchJson(`/agent/workspace/files/${encodeURIComponent(path)}`, {
      method: 'DELETE',
    })
  }

  async searchFiles(query: string): Promise<SearchResult[]> {
    return this.fetchJson<SearchResult[]>('/agent/workspace/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
  }

  // ---------------------------------------------------------------------------
  // Mode
  // ---------------------------------------------------------------------------

  async getMode(): Promise<VisualMode> {
    const res = await this.fetchJson<{ mode: VisualMode }>('/agent/mode')
    return res.mode
  }

  async setMode(mode: VisualMode): Promise<void> {
    await this.fetchJson('/agent/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
  }

  // ---------------------------------------------------------------------------
  // Control
  // ---------------------------------------------------------------------------

  async triggerHeartbeat(): Promise<void> {
    await this.fetchJson('/agent/heartbeat/trigger', { method: 'POST' })
  }

  async stop(): Promise<void> {
    await this.fetchJson('/agent/stop', { method: 'POST' })
  }

  async resetSession(): Promise<void> {
    await this.fetchJson('/agent/session/reset', { method: 'POST' })
  }

  async updateConfig(config: Record<string, unknown>): Promise<void> {
    await this.fetchJson('/agent/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    })
  }
}

let defaultClient: AgentClient | null = null

/**
 * Get or create a singleton AgentClient with default (relative URL) configuration.
 */
export function getAgentClient(config?: AgentClientConfig): AgentClient {
  if (!defaultClient || config) {
    defaultClient = new AgentClient(config)
  }
  return defaultClient
}
