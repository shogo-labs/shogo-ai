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
  WorkspaceBundle,
} from './types.js'

/** Per-request bodies set Content-Type; shared headers must not force a single type (e.g. multipart). */
/** Live workspace event streamed from /agent/canvas/stream. */
export type WorkspaceEvent =
  | { type: 'init' }
  | { type: 'reload' }
  | { type: 'file.changed'; path: string; mtime: number }
  | { type: 'file.deleted'; path: string }

function withoutContentType(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type') continue
    out[key] = value
  }
  return out
}

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
  /** Auth / context headers only — never `Content-Type` (set per request from the body). */
  private ambientHeaders: Record<string, string>
  private doFetch: typeof fetch

  constructor(config?: AgentClientConfig) {
    this.baseUrl = config?.baseUrl?.replace(/\/$/, '') ?? ''
    this.ambientHeaders = withoutContentType(config?.headers ?? {})
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
      headers: { ...this.ambientHeaders, ...init?.headers },
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
      headers: { 'Content-Type': 'application/json', ...this.ambientHeaders },
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
    return new EventSource(this.url('/agent/canvas/stream'), { withCredentials: true })
  }

  /**
   * Subscribe to live workspace events (file.changed / file.deleted / reload).
   *
   * Unlike {@link subscribeToCanvas}, this parses event JSON, filters/types
   * it, and transparently reconnects with exponential backoff on error. Use
   * this for IDE-style "agent is editing my file" UX.
   *
   * @returns A disposer — call it to close the stream. Idempotent.
   */
  subscribeToWorkspace(
    onEvent: (event: WorkspaceEvent) => void,
    opts: { onError?: (err: unknown) => void; includeReload?: boolean } = {},
  ): () => void {
    let es: EventSource | null = null
    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoffMs = 1000
    const BACKOFF_CAP = 8000

    const open = () => {
      if (closed) return
      const url = this.url('/agent/canvas/stream')
      console.log('[LIVE] AgentClient.subscribeToWorkspace opening EventSource to', url)
      es = new EventSource(url, { withCredentials: true })
      es.onopen = () => console.log('[LIVE] EventSource OPEN', url)
      es.onmessage = (ev) => {
        let parsed: unknown
        try { parsed = JSON.parse(ev.data) } catch { return }
        if (!parsed || typeof parsed !== 'object') return
        const evt = parsed as WorkspaceEvent
        if (evt.type === 'reload' && !opts.includeReload) return
        backoffMs = 1000 // success = reset backoff
        try { onEvent(evt) } catch (e) { opts.onError?.(e) }
      }
      es.onerror = (e) => {
        opts.onError?.(e)
        try { es?.close() } catch {}
        es = null
        if (closed) return
        reconnectTimer = setTimeout(open, backoffMs)
        backoffMs = Math.min(BACKOFF_CAP, backoffMs * 2)
      }
    }
    open()

    return () => {
      closed = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      try { es?.close() } catch {}
      es = null
    }
  }

  async getCanvasState(): Promise<CanvasState> {
    return this.fetchJson<CanvasState>('/agent/canvas/state')
  }

  async dispatchAction(
    surfaceId: string,
    actionName: string,
    context?: ActionContext,
  ): Promise<void> {
    await this.fetchJson('/agent/canvas/action', {
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

  /**
   * Full workspace snapshot for project export (K8s / server-side).
   * Paths are relative to workspace root; values are base64-encoded file bytes.
   */
  async getWorkspaceBundle(): Promise<WorkspaceBundle> {
    return this.fetchJson<WorkspaceBundle>('/agent/workspace/bundle')
  }

  async readFile(path: string): Promise<string> {
    const res = await this.doFetch(this.url(`/agent/workspace/files/${this.encodePath(path)}`), {
      headers: this.ambientHeaders,
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
    const res = await this.doFetch(this.url('/agent/workspace/upload'), {
      method: 'POST',
      headers: this.ambientHeaders,
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
