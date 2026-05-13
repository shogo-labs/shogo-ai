// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Result of executing an installed tool via {@link ToolsClient.execute}.
 *
 * `data` is auto-parsed from JSON when the underlying runtime serialized
 * a JSON value (object, array, number, boolean, null, or a JSON-encoded
 * string). For tools that return raw text (markdown, plain prose), the
 * SDK leaves `data` as the original string. Use the generic parameter
 * to type the expected payload:
 *
 * ```typescript
 * const me = await tools.execute<{ accountId: string }>('JIRA_GET_CURRENT_USER', {})
 * me.data?.accountId // string | undefined
 * ```
 */
export interface ToolExecuteResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export interface ToolsClientConfig {
  baseUrl?: string
  /**
   * Sent on every request (e.g. `Authorization`). Do not set `Content-Type` here —
   * it is set automatically for JSON requests.
   */
  headers?: Record<string, string>
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetch?: typeof fetch
}
