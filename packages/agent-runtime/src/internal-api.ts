// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, readFileSync } from 'fs'

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token'

export function deriveApiUrl(): string | null {
  if (process.env.SHOGO_API_URL) return process.env.SHOGO_API_URL
  if (process.env.API_URL) return process.env.API_URL
  const proxyUrl = process.env.AI_PROXY_URL
  if (proxyUrl) {
    try {
      const url = new URL(proxyUrl)
      return `${url.protocol}//${url.host}`
    } catch { /* invalid URL */ }
  }
  const systemNs = process.env.SYSTEM_NAMESPACE || 'shogo-system'
  return `http://api.${systemNs}.svc.cluster.local`
}

/**
 * Public-facing API URL for URLs that end up in browser-facing contexts
 * (e.g. webchat widget embed snippets). Falls back to deriveApiUrl() for
 * local dev where everything runs on localhost.
 */
export function derivePublicApiUrl(): string | null {
  if (process.env.SHOGO_PUBLIC_API_URL) return process.env.SHOGO_PUBLIC_API_URL
  return deriveApiUrl()
}

export function getInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  try {
    if (existsSync(SA_TOKEN_PATH)) {
      headers['Authorization'] = `Bearer ${readFileSync(SA_TOKEN_PATH, 'utf-8').trim()}`
    }
  } catch { /* not in K8s */ }

  // In local mode, include the runtime token for API auth
  if (process.env.RUNTIME_AUTH_SECRET) {
    headers['x-runtime-token'] = process.env.RUNTIME_AUTH_SECRET
  }

  return headers
}

/**
 * POST a cost-metric record to the API server. Fire-and-forget — failures are
 * logged but never thrown so they don't disrupt the agent run.
 *
 * Phase 2.1 — feeds AgentCostMetric rows with multi-signal quality data so the
 * recommendation gate can rely on real quality instead of "didn't throw".
 */
export interface AgentCostMetricPayload {
  workspaceId: string
  projectId?: string
  agentRunId?: string
  agentType: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  toolCalls: number
  creditCost: number
  wallTimeMs: number
  success: boolean
  hitMaxTurns?: boolean
  loopDetected?: boolean
  escalated?: boolean
  responseEmpty?: boolean
}

export async function postCostMetric(payload: AgentCostMetricPayload): Promise<void> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return
  try {
    const res = await fetch(`${apiUrl}/api/internal/agent-cost-metrics`, {
      method: 'POST',
      headers: getInternalHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) {
      console.warn(`[Runtime] postCostMetric HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
  } catch (err: any) {
    // Best-effort — never throw out of cost-metric reporting.
    console.warn('[Runtime] postCostMetric failed:', err?.message ?? err)
  }
}
