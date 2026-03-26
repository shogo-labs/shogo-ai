// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

import type {
  AgentClientConfig,
  AgentExportBundle,
  AgentImportResult,
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
  private doFetch: typeof fetch

  constructor(config?: AgentClientConfig) {
    this.baseUrl = config?.baseUrl?.replace(/\/$/, '') ?? ''
    this.headers = config?.headers ?? {}
    this.doFetch = config?.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  /** Encode each segment of a relative path individually so slashes are preserved. */
  private encodePath(relativePath: string): string {
    return relativePath.split('/').map(encodeURIComponent).join('/')
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.doFetch(this.url(path), {
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

    const res = await this.doFetch(this.url('/agent/chat'), {
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
    const data = await this.fetchJson<{ tree: FileNode[] }>('/agent/workspace/tree')
    return data.tree ?? []
  }

  async readFile(path: string): Promise<string> {
    const res = await this.doFetch(this.url(`/agent/workspace/files/${this.encodePath(path)}`), {
      headers: this.headers,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Agent readFile ${res.status}: ${text}`)
    }
    const data = (await res.json()) as { content: string }
    return data.content ?? ''
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.fetchJson(`/agent/workspace/files/${this.encodePath(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  }

  async deleteFile(path: string): Promise<void> {
    await this.fetchJson(`/agent/workspace/files/${this.encodePath(path)}`, {
      method: 'DELETE',
    })
  }

  async searchFiles(
    query: string,
    options?: { limit?: number; pathFilter?: string },
  ): Promise<SearchResult[]> {
    const body: Record<string, unknown> = { query }
    if (options?.limit != null) body.limit = options.limit
    if (options?.pathFilter != null) body.path_filter = options.pathFilter
    const data = await this.fetchJson<{ results: SearchResult[] }>('/agent/workspace/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return data.results ?? []
  }

  /** Allowed workspace root files (AGENTS.md, SOUL.md, …). */
  async readWorkspaceConfigFile(filename: string): Promise<string> {
    const data = await this.fetchJson<{ content: string }>(`/agent/files/${encodeURIComponent(filename)}`)
    return data.content ?? ''
  }

  async writeWorkspaceConfigFile(filename: string, content: string): Promise<void> {
    await this.fetchJson(`/agent/files/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  }

  async mkdirWorkspace(relativePath: string): Promise<void> {
    await this.fetchJson('/agent/workspace/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: relativePath }),
    })
  }

  async uploadWorkspaceFiles(formData: FormData): Promise<{ uploaded: string[]; count: number }> {
    // FormData must not include Content-Type — fetch sets multipart boundary automatically.
    const headers = { ...this.headers }
    delete headers['Content-Type']
    delete headers['content-type']
    const res = await this.doFetch(this.url('/agent/workspace/upload'), {
      method: 'POST',
      headers,
      body: formData,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Agent upload ${res.status}: ${text}`)
    }
    const data = (await res.json()) as { uploaded?: string[]; count?: number }
    return { uploaded: data.uploaded ?? [], count: data.count ?? 0 }
  }

  /** Absolute URL for browser download / native WebView (GET returns raw bytes). */
  workspaceFileDownloadUrl(relativePath: string): string {
    return this.url(`/agent/workspace/download/${this.encodePath(relativePath)}`)
  }

  async exportAgentBundle(): Promise<AgentExportBundle> {
    return this.fetchJson<AgentExportBundle>('/agent/export')
  }

  async importAgentBundle(bundle: AgentExportBundle | Record<string, unknown>): Promise<AgentImportResult> {
    return this.fetchJson<AgentImportResult>('/agent/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle),
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
