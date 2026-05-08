// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ToolsClientConfig, ToolSchema, ToolExecuteResult } from './types.js'

/**
 * Path layout for the tools HTTP API. The browser-facing client targets
 * the same-origin sidecar (`/api/tools/*` mounted by
 * `createToolsHandlers()` in `server.tsx`); the server-side client
 * targets the agent runtime directly (`/agent/tools/*` on
 * `127.0.0.1:RUNTIME_PORT`).
 */
interface PathLayout {
  schemas: string
  execute: string
}

const BROWSER_PATHS: PathLayout = {
  schemas: '/api/tools/schemas',
  execute: '/api/tools/execute',
}

const RUNTIME_PATHS: PathLayout = {
  schemas: '/agent/tools/schemas',
  execute: '/agent/tools/execute',
}

/**
 * Client for executing installed integration tools from workspace code.
 *
 * Defaults to same-origin `/api/tools/*` paths so canvas apps served
 * from the agent runtime pod need zero configuration. The sidecar
 * forwards each call to the agent runtime over `127.0.0.1` and
 * attaches the runtime token; the browser never holds credentials.
 *
 * For server-side use (custom-routes.ts, server.tsx), prefer
 * {@link getServerToolsClient} — it targets the runtime directly and
 * auto-injects the runtime token.
 *
 * @example
 * ```typescript
 * import { ToolsClient } from '@shogo-ai/sdk/tools'
 *
 * const tools = new ToolsClient()
 * const result = await tools.execute('METAADS_GET_INSIGHTS', {
 *   ad_account_id: '123456',
 *   date_preset: 'last_30_days',
 * })
 * if (result.ok) console.log(result.data)
 * ```
 */
export class ToolsClient {
  private baseUrl: string
  private headers: Record<string, string>
  private doFetch: typeof fetch
  private paths: PathLayout

  constructor(config?: ToolsClientConfig & { paths?: PathLayout }) {
    this.baseUrl = config?.baseUrl?.replace(/\/$/, '') ?? ''
    this.headers = { ...config?.headers }
    this.doFetch = config?.fetch ?? globalThis.fetch.bind(globalThis)
    this.paths = config?.paths ?? BROWSER_PATHS
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  /**
   * List all installed tools with their schemas.
   */
  async listTools(): Promise<ToolSchema[]> {
    const res = await this.doFetch(this.url(this.paths.schemas), {
      headers: this.headers,
    })
    if (!res.ok) {
      throw new Error(`Tools list failed (${res.status}): ${await res.text().catch(() => res.statusText)}`)
    }
    const data = (await res.json()) as { tools: ToolSchema[] }
    return data.tools ?? []
  }

  /**
   * Execute an installed tool by name.
   *
   * @param toolName - Tool slug (e.g. `METAADS_GET_INSIGHTS`, `GMAIL_SEND_EMAIL`)
   * @param args - Arguments matching the tool's parameter schema
   */
  async execute(toolName: string, args: Record<string, unknown> = {}): Promise<ToolExecuteResult> {
    const res = await this.doFetch(this.url(this.paths.execute), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({ tool: toolName, args }),
    })
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => res.statusText)
      return { ok: false, error: `Request failed (${res.status}): ${text}` }
    }
    return (await res.json()) as ToolExecuteResult
  }
}

let defaultClient: ToolsClient | null = null

/**
 * Get or create a singleton ToolsClient with default (same-origin) configuration.
 *
 * Intended for use in browser code (React components, hooks). Calls go
 * to the pod's `/api/tools/*` sidecar mount, which forwards to the
 * agent runtime with the runtime token attached.
 */
export function getToolsClient(config?: ToolsClientConfig): ToolsClient {
  if (!defaultClient || config) {
    defaultClient = new ToolsClient(config)
  }
  return defaultClient
}

let defaultServerClient: ToolsClient | null = null

/**
 * Get or create a singleton ToolsClient configured for **server-side**
 * use inside a Shogo-managed pod (custom-routes.ts, server.tsx).
 *
 * Reads `RUNTIME_PORT` and `RUNTIME_AUTH_SECRET` from `process.env`,
 * targets the agent runtime over `127.0.0.1`, and auto-injects the
 * runtime token. Throws if those env vars are missing — which only
 * happens outside a managed pod.
 *
 * @example
 * ```typescript
 * // custom-routes.ts
 * import { getServerToolsClient } from '@shogo-ai/sdk/tools'
 *
 * app.get('/dashboard', async (c) => {
 *   const res = await getServerToolsClient().execute('JIRA_SEARCH_ISSUES', {
 *     jql: 'assignee = currentUser()',
 *   })
 *   return c.json(res)
 * })
 * ```
 */
export function getServerToolsClient(config?: ToolsClientConfig): ToolsClient {
  if (defaultServerClient && !config) return defaultServerClient

  const runtimeToken = process.env.RUNTIME_AUTH_SECRET
  const portRaw = process.env.RUNTIME_PORT
  if (!runtimeToken || !portRaw) {
    throw new Error(
      'getServerToolsClient: RUNTIME_AUTH_SECRET and RUNTIME_PORT must be set. ' +
        'These are injected automatically inside a Shogo-managed pod. ' +
        'For browser code, use `getToolsClient()` or `useTools()` instead.',
    )
  }
  const port = parseInt(portRaw, 10)
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`getServerToolsClient: invalid RUNTIME_PORT "${portRaw}"`)
  }
  const merged: ToolsClientConfig & { paths: PathLayout } = {
    baseUrl: config?.baseUrl ?? `http://127.0.0.1:${port}`,
    paths: RUNTIME_PATHS,
    headers: { 'x-runtime-token': runtimeToken, ...(config?.headers ?? {}) },
    ...(config?.fetch ? { fetch: config.fetch } : {}),
  }
  const client = new ToolsClient(merged)
  if (!config) defaultServerClient = client
  return client
}
