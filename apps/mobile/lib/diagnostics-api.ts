// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mobile-side client for the IDE Problems tab.
 *
 * Hardened the same way Terminal.tsx was hardened in PR #458:
 *   - Tolerate non-JSON upstream responses (HTML 503 from Knative cold-starts,
 *     Cloudflare error pages, gateway timeouts) by inspecting `content-type`
 *     before calling `response.json()`.
 *   - Surface a structured `DiagnosticsApiError` with `code` so the UI can
 *     show a "service starting" empty state with a Retry button instead of
 *     a generic "Failed to fetch" toast.
 */

import { agentFetch } from "./agent-fetch"
import { API_URL } from "./api"

// Mirror of the server-side types so the mobile app doesn't pull from
// shared-runtime (which is server-only). Keep these in sync with
// `packages/shared-runtime/src/diagnostics.ts`.
export type DiagnosticSource = "ts" | "eslint" | "build"
export type DiagnosticSeverity = "error" | "warning" | "info" | "hint"

export interface Diagnostic {
  id: string
  source: DiagnosticSource
  severity: DiagnosticSeverity
  file: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  code?: string
  message: string
  ruleUri?: string
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[]
  lastRunAt: string
  sources: DiagnosticSource[]
  fromCache: boolean
  notes?: { source: DiagnosticSource; message: string }[]
}

export interface DiagnosticsUnchanged {
  unchanged: true
  lastRunAt: string
}

export class DiagnosticsApiError extends Error {
  /** Stable error code from the server (`service_starting`, `proxy_error`, ...). */
  readonly code: string
  /** HTTP status, when available. */
  readonly status: number
  /** True when the server hinted to retry (Retry-After header or 503). */
  readonly retryable: boolean

  constructor(message: string, code: string, status: number, retryable: boolean) {
    super(message)
    this.name = "DiagnosticsApiError"
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

/**
 * Parse a fetch response, returning either the JSON body or throwing a
 * structured `DiagnosticsApiError`. The same shape Terminal.tsx now uses.
 */
async function parseResponse<T>(response: Response, label: string): Promise<T> {
  const contentType = response.headers.get("content-type") || ""
  const isJson = contentType.includes("application/json")

  if (!response.ok) {
    let code = "http_error"
    let message = `${label} failed (${response.status})`
    if (isJson) {
      try {
        const body = await response.json()
        if (body?.error?.code) code = body.error.code
        if (body?.error?.message) message = body.error.message
      } catch { /* fall through to default message */ }
    } else {
      // HTML / text fallback — skip body, use status-derived code.
      if (response.status === 503) code = "service_starting"
      else if (response.status === 502) code = "service_unavailable"
      else if (response.status === 504) code = "gateway_timeout"
    }
    const retryable = response.status === 503 || response.status === 502 || response.status === 504
    throw new DiagnosticsApiError(message, code, response.status, retryable)
  }

  if (!isJson) {
    // Successful but not JSON — most likely the SPA fallback returned
    // index.html. Surface it so we don't silently swallow a misconfig.
    throw new DiagnosticsApiError(
      `${label} returned non-JSON response (likely SPA fallback)`,
      "non_json_response",
      response.status,
      false,
    )
  }

  return response.json() as Promise<T>
}

interface FetchOptions {
  signal?: AbortSignal
  /** Optional `since` ISO timestamp to skip the payload if nothing changed. */
  since?: string
  /** Restrict to specific sources; defaults to all. */
  sources?: DiagnosticSource[]
}

export async function fetchDiagnostics(
  projectId: string,
  options: FetchOptions = {},
): Promise<DiagnosticsResult | DiagnosticsUnchanged> {
  const url = new URL(`${API_URL}/api/projects/${projectId}/diagnostics`)
  if (options.since) url.searchParams.set("since", options.since)
  if (options.sources && options.sources.length) {
    url.searchParams.set("source", options.sources.join(","))
  }
  const res = await agentFetch(url.toString(), { signal: options.signal })
  return parseResponse<DiagnosticsResult | DiagnosticsUnchanged>(res, "GET /diagnostics")
}

export async function refreshDiagnostics(
  projectId: string,
  options: FetchOptions = {},
): Promise<DiagnosticsResult> {
  const url = `${API_URL}/api/projects/${projectId}/diagnostics/refresh`
  const res = await agentFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.sources ? { sources: options.sources } : {}),
    signal: options.signal,
  })
  return parseResponse<DiagnosticsResult>(res, "POST /diagnostics/refresh")
}
