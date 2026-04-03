// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef } from 'react'
import { ToolsClient, getToolsClient } from './client.js'
import type { ToolsClientConfig, ToolSchema, ToolExecuteResult } from './types.js'

function useToolsClient(config?: ToolsClientConfig): ToolsClient {
  const ref = useRef<ToolsClient | null>(null)
  if (!ref.current) {
    ref.current = config ? new ToolsClient(config) : getToolsClient()
  }
  return ref.current
}

// ---------------------------------------------------------------------------
// useTools
// ---------------------------------------------------------------------------

export interface UseToolsOptions {
  config?: ToolsClientConfig
  /** Automatically fetch tool schemas on mount (default: true). */
  autoLoad?: boolean
}

export interface UseToolsResult {
  /** Available tool schemas (empty until loaded). */
  tools: ToolSchema[]
  /** Whether the initial schema fetch is in progress. */
  loading: boolean
  /** Error from the most recent schema fetch, if any. */
  error: Error | null
  /** Re-fetch tool schemas. */
  refresh: () => void
  /**
   * Execute an installed tool.
   *
   * @param toolName - Tool slug (e.g. `METAADS_GET_INSIGHTS`)
   * @param args - Arguments matching the tool's parameter schema
   */
  execute: (toolName: string, args?: Record<string, unknown>) => Promise<ToolExecuteResult>
}

/**
 * React hook for discovering and executing installed integration tools.
 *
 * @example
 * ```tsx
 * import { useTools } from '@shogo-ai/sdk/tools'
 *
 * function AdsManager() {
 *   const { tools, execute, loading } = useTools()
 *   const [insights, setInsights] = useState(null)
 *
 *   const load = async () => {
 *     const res = await execute('METAADS_GET_INSIGHTS', {
 *       ad_account_id: '123',
 *       date_preset: 'last_30_days',
 *     })
 *     if (res.ok) setInsights(JSON.parse(res.data!))
 *   }
 *
 *   if (loading) return <p>Loading tools...</p>
 *   return <button onClick={load}>Load Insights</button>
 * }
 * ```
 */
export function useTools(options?: UseToolsOptions): UseToolsResult {
  const client = useToolsClient(options?.config)
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const fetchSchemas = useCallback(async () => {
    setLoading(true)
    try {
      const schemas = await client.listTools()
      setTools(schemas)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    if (options?.autoLoad !== false) {
      fetchSchemas()
    } else {
      setLoading(false)
    }
  }, [fetchSchemas, options?.autoLoad])

  const execute = useCallback(
    (toolName: string, args?: Record<string, unknown>) =>
      client.execute(toolName, args),
    [client],
  )

  return { tools, loading, error, refresh: fetchSchemas, execute }
}
