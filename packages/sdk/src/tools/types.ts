// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolExecuteResult {
  ok: boolean
  data?: string
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
