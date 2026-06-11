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

/**
 * Record a `ProjectCheckpoint` row for an already-made local commit
 * (pod-owned `git_only` model). Best-effort — failures are logged, never
 * thrown: the commit is already durable in the persisted `.git`, and the
 * row can be reconciled on a later read. Auth uses the standard internal
 * headers (K8s SA token in cluster, `x-runtime-token` locally).
 */
export interface CheckpointRecordPayload {
  commitSha: string
  commitMessage: string
  branch: string
  filesChanged: number
  additions: number
  deletions: number
  isAutomatic?: boolean
}

export async function postCheckpointRecord(
  projectId: string,
  payload: CheckpointRecordPayload,
): Promise<boolean> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return false
  try {
    const res = await fetch(
      `${apiUrl}/api/internal/projects/${encodeURIComponent(projectId)}/checkpoints/record`,
      {
        method: 'POST',
        headers: getInternalHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!res.ok) {
      console.warn(`[Runtime] postCheckpointRecord HTTP ${res.status} for ${projectId}`)
      return false
    }
    return true
  } catch (err: any) {
    console.warn('[Runtime] postCheckpointRecord failed:', err?.message ?? err)
    return false
  }
}

/**
 * BETA: per-chat git worktrees — reflect a chat's worktree lifecycle into the
 * product DB (ChatSession.worktree* columns) so the UI can render the branch
 * chip and merge state across reloads. Best-effort; never throws.
 */
export interface WorktreeStatusPayload {
  worktreeBranch?: string | null
  worktreeStatus?: 'active' | 'merging' | 'merged' | null
  worktreePath?: string | null
}

export async function postWorktreeStatus(
  chatSessionId: string,
  payload: WorktreeStatusPayload,
): Promise<boolean> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return false
  try {
    const res = await fetch(
      `${apiUrl}/api/internal/chat-sessions/${encodeURIComponent(chatSessionId)}/worktree`,
      {
        method: 'POST',
        headers: getInternalHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!res.ok) {
      console.warn(`[Runtime] postWorktreeStatus HTTP ${res.status} for ${chatSessionId}`)
      return false
    }
    return true
  } catch (err: any) {
    console.warn('[Runtime] postWorktreeStatus failed:', err?.message ?? err)
    return false
  }
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
