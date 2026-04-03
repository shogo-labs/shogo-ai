// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * @shogo-ai/sdk/tools
 *
 * Client and React hooks for executing installed integration tools
 * (Composio, MCP servers, etc.) from workspace code. Tools must first
 * be installed via the agent's `tool_install` command.
 *
 * The client defaults to same-origin requests so canvas apps served
 * from the agent runtime need zero configuration.
 *
 * @example Imperative
 * ```typescript
 * import { ToolsClient } from '@shogo-ai/sdk/tools'
 *
 * const tools = new ToolsClient()
 * const result = await tools.execute('METAADS_GET_INSIGHTS', {
 *   ad_account_id: '123456',
 *   date_preset: 'last_30_days',
 * })
 * ```
 *
 * @example React hook
 * ```tsx
 * import { useTools } from '@shogo-ai/sdk/tools'
 *
 * function Dashboard() {
 *   const { execute, tools, loading } = useTools()
 *   // ...
 * }
 * ```
 */

// Client
export { ToolsClient, getToolsClient } from './client.js'

// React hooks
export { useTools } from './hooks.js'

// Types
export type {
  ToolsClientConfig,
  ToolSchema,
  ToolExecuteResult,
} from './types.js'

export type { UseToolsOptions, UseToolsResult } from './hooks.js'
