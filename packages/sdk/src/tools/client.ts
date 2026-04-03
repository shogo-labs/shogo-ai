// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ToolsClientConfig, ToolSchema, ToolExecuteResult } from './types.js'

/**
 * Client for executing installed integration tools (Composio, MCP, etc.)
 * from workspace code.
 *
 * Defaults to same-origin `/agent/tools/*` paths so canvas apps served
 * from the agent runtime pod need zero configuration.
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

  constructor(config?: ToolsClientConfig) {
    this.baseUrl = config?.baseUrl?.replace(/\/$/, '') ?? ''
    this.headers = { ...config?.headers }
    this.doFetch = config?.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  /**
   * List all installed tools with their schemas.
   */
  async listTools(): Promise<ToolSchema[]> {
    const res = await this.doFetch(this.url('/agent/tools/schemas'), {
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
    const res = await this.doFetch(this.url('/agent/tools/execute'), {
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
 */
export function getToolsClient(config?: ToolsClientConfig): ToolsClient {
  if (!defaultClient || config) {
    defaultClient = new ToolsClient(config)
  }
  return defaultClient
}
