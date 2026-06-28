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

// ---------------------------------------------------------------------------
// Checkpoint read/rollback wrappers (WS4)
//
// The product already maintains a full auto-checkpoint+rollback system on the
// API side (ProjectCheckpoint rows + git). The agent runtime previously had no
// way to SEE or USE it, so it told users "no git history" and hand-reverted.
// These wrappers call the cluster-internal checkpoint routes so the
// `checkpoint` agent tool can list, diff, and roll back to real snapshots.
// ---------------------------------------------------------------------------

export interface CheckpointSummary {
  id: string
  commitSha?: string | null
  message?: string | null
  name?: string | null
  description?: string | null
  createdAt?: string
  isAutomatic?: boolean
  filesChanged?: number
  additions?: number
  deletions?: number
}

/**
 * Result envelope for checkpoint calls. `code === 'checkpoints_disabled_in_external_mode'`
 * means the project is folder-linked (the user owns git) — the tool surfaces
 * that to the model gracefully instead of treating it as a hard failure.
 */
export interface CheckpointCallResult<T> {
  ok: boolean
  status: number
  data?: T
  error?: string
  code?: string
}

async function checkpointFetch<T>(
  path: string,
  init: RequestInit & { parse?: (json: any) => T },
): Promise<CheckpointCallResult<T>> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return { ok: false, status: 0, error: 'No API URL configured' }
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: getInternalHeaders(),
      signal: AbortSignal.timeout(20_000),
      ...init,
    })
    const json = await res.json().catch(() => null) as any
    if (!res.ok) {
      const err = json?.error
      const message = typeof err === 'string' ? err : err?.message
      return { ok: false, status: res.status, error: message ?? `HTTP ${res.status}`, code: err?.code }
    }
    return { ok: true, status: res.status, data: init.parse ? init.parse(json) : (json as T) }
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? String(err) }
  }
}

export async function listCheckpoints(
  projectId: string,
  limit = 20,
): Promise<CheckpointCallResult<CheckpointSummary[]>> {
  return checkpointFetch(
    `/api/internal/projects/${encodeURIComponent(projectId)}/checkpoints?limit=${limit}`,
    { method: 'GET', parse: (j) => (j?.checkpoints ?? []) as CheckpointSummary[] },
  )
}

export async function getCheckpoint(
  projectId: string,
  checkpointId: string,
): Promise<CheckpointCallResult<CheckpointSummary>> {
  return checkpointFetch(
    `/api/internal/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}`,
    { method: 'GET', parse: (j) => (j?.checkpoint ?? j) as CheckpointSummary },
  )
}

export async function getCheckpointDiff(
  projectId: string,
  checkpointId: string,
  toCheckpointId?: string,
): Promise<CheckpointCallResult<unknown>> {
  const qs = toCheckpointId ? `?to=${encodeURIComponent(toCheckpointId)}` : ''
  return checkpointFetch(
    `/api/internal/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/diff${qs}`,
    { method: 'GET', parse: (j) => j?.diff ?? j },
  )
}

export async function rollbackCheckpoint(
  projectId: string,
  checkpointId: string,
  includeDatabase?: boolean,
): Promise<CheckpointCallResult<unknown>> {
  return checkpointFetch(
    `/api/internal/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/rollback`,
    {
      method: 'POST',
      body: JSON.stringify({ includeDatabase: includeDatabase ?? false }),
      parse: (j) => j,
    },
  )
}

// ---------------------------------------------------------------------------
// Publish wrappers — let the agent's `publish` tool deploy to {subdomain}.shogo.one
//
// The public publish route is session-authenticated and unreachable from the
// pod; these call the cluster-internal mirror (auth: SA token / x-runtime-token)
// so the tool can read publish state (first-publish vs republish) and trigger a
// (re)publish. Reuses the same CheckpointCallResult envelope shape.
// ---------------------------------------------------------------------------

export interface PublishState {
  published: boolean
  subdomain: string | null
  publishedAt: number | null
  accessLevel: string | null
  hasPassword: boolean
  publishStatus: string | null
}

export interface PublishResult {
  url: string
  subdomain: string
  publishedAt?: number
  accessLevel?: string
  hasPassword?: boolean
}

export interface PublishOptions {
  subdomain: string
  accessLevel?: 'anyone' | 'authenticated' | 'private' | 'password'
  password?: string
  siteTitle?: string
  siteDescription?: string
}

async function publishFetch<T>(
  path: string,
  init: RequestInit & { parse?: (json: any) => T },
): Promise<CheckpointCallResult<T>> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return { ok: false, status: 0, error: 'No API URL configured' }
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: getInternalHeaders(),
      // Publish builds + uploads the app, which can take a while — be generous.
      signal: AbortSignal.timeout(120_000),
      ...init,
    })
    const json = (await res.json().catch(() => null)) as any
    if (!res.ok) {
      const err = json?.error
      const message = typeof err === 'string' ? err : err?.message
      return { ok: false, status: res.status, error: message ?? `HTTP ${res.status}`, code: err?.code }
    }
    return { ok: true, status: res.status, data: init.parse ? init.parse(json) : (json as T) }
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? String(err) }
  }
}

export async function getPublishState(projectId: string): Promise<CheckpointCallResult<PublishState>> {
  return publishFetch(`/api/internal/projects/${encodeURIComponent(projectId)}/publish`, {
    method: 'GET',
    parse: (j) => j as PublishState,
  })
}

export async function publishProject(
  projectId: string,
  opts: PublishOptions,
): Promise<CheckpointCallResult<PublishResult>> {
  return publishFetch(`/api/internal/projects/${encodeURIComponent(projectId)}/publish`, {
    method: 'POST',
    body: JSON.stringify(opts),
    parse: (j) => j as PublishResult,
  })
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
