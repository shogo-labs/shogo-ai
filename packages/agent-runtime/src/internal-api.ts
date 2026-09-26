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

/**
 * Returns `projectId` only when it names a real project. A workspace runtime
 * bound with no attached projects gets its runtime key (`ws:<workspaceId>`)
 * as PROJECT_ID, and an unassigned pool runtime has `__POOL__`; the API
 * rejects project-scoped internal calls for either, so callers must skip the
 * call or omit the field instead.
 */
export function projectScopedId(projectId: string | null | undefined): string | undefined {
  if (!projectId || projectId === '__POOL__' || projectId.startsWith('ws:')) return undefined
  return projectId
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
  /** Free-form correlation, e.g. `{ pipelineRunId }` for cross-project pipeline runs. */
  metadata?: Record<string, unknown>
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
  // A projectless workspace runtime has no project to attach the row to.
  if (!apiUrl || !projectScopedId(projectId)) return false
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

export interface PlanMirrorPayload {
  action?: 'upsert' | 'delete'
  filename: string
  name?: string
  overview?: string
  status?: string
  content?: string
  createdAt?: string
  projectId?: string
  workspaceId?: string
  chatSessionId?: string
  runtimeKey?: string
}

export async function postPlanMirror(payload: PlanMirrorPayload): Promise<boolean> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl || !payload.filename) return false
  try {
    const projectId = payload.projectId || process.env.PROJECT_ID || undefined
    const workspaceId = payload.workspaceId || process.env.WORKSPACE_ID || undefined
    // workspaceId/projectId MUST also be query params, not just body fields:
    // the API's home-region router resolves writes from the URL only (never
    // the body, since it may need to buffer/replay it to proxy the request),
    // so a body-only workspaceId would silently handle this write locally
    // instead of routing it to the workspace's home region. See the
    // `POST /plans` comment in apps/api/src/routes/internal.ts.
    const query = new URLSearchParams()
    if (workspaceId) query.set('workspaceId', workspaceId)
    if (projectId) query.set('projectId', projectId)
    const qs = query.toString()
    const response = await fetch(`${apiUrl}/api/internal/plans${qs ? `?${qs}` : ''}`, {
      method: payload.action === 'delete' ? 'DELETE' : 'POST',
      headers: getInternalHeaders(),
      body: JSON.stringify({
        ...payload,
        projectId,
        workspaceId,
        runtimeKey: payload.runtimeKey || process.env.WORKSPACE_RUNTIME_KEY || process.env.PROJECT_ID || undefined,
      }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      console.warn(`[Runtime] postPlanMirror HTTP ${response.status} for ${payload.filename}`)
      return false
    }
    return true
  } catch (error: any) {
    console.warn('[Runtime] postPlanMirror failed:', error?.message ?? error)
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

export interface GitHubPullRequestOptions {
  title: string
  head: string
  base?: string
  body?: string
  draft?: boolean
  runId?: string
}

export interface GitHubPullRequestResult {
  number: number
  url: string
  htmlUrl?: string
  author?: string
}

export interface GitHubCliCredentials {
  token: string
  expiresAt: string
  login: string
  name: string
  email: string
}

/**
 * Installation token for the connected GitHub App. The runtime injects this
 * as `GH_TOKEN` so `gh` comments, reviews, and commits are the App bot.
 * 409 `github_app_not_installed` means the project has no connection.
 */
export async function getGitHubCliCredentials(
  projectId: string,
): Promise<CheckpointCallResult<GitHubCliCredentials>> {
  return checkpointFetch(
    `/api/internal/projects/${encodeURIComponent(projectId)}/github/cli-credentials`,
    {
      method: 'GET',
      parse: (j) => ({
        token: j?.token,
        expiresAt: j?.expiresAt,
        login: j?.login,
        name: j?.name,
        email: j?.email,
      }) as GitHubCliCredentials,
    },
  )
}

export async function createGitHubPullRequest(
  projectId: string,
  opts: GitHubPullRequestOptions,
): Promise<CheckpointCallResult<GitHubPullRequestResult>> {
  return checkpointFetch(
    `/api/internal/projects/${encodeURIComponent(projectId)}/github/pull-request`,
    {
      method: 'POST',
      body: JSON.stringify(opts),
      parse: (j) => j as GitHubPullRequestResult,
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

// ---------------------------------------------------------------------------
// Project lifecycle wrappers — back the `project_*` / `system_apply` tools
// (project-tools.ts). Routes live in apps/api/src/routes/internal.ts under
// the "Project lifecycle" section. Same CheckpointCallResult envelope.
// ---------------------------------------------------------------------------

async function lifecycleFetch<T>(
  path: string,
  init: RequestInit & { parse?: (json: any) => T; timeoutMs?: number },
): Promise<CheckpointCallResult<T>> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return { ok: false, status: 0, error: 'No API URL configured' }
  const { parse, timeoutMs, ...rest } = init
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: getInternalHeaders(),
      signal: AbortSignal.timeout(timeoutMs ?? 20_000),
      ...rest,
    })
    const json = (await res.json().catch(() => null)) as any
    if (!res.ok) {
      const err = json?.error
      const message = typeof err === 'string' ? err : err?.message
      return { ok: false, status: res.status, error: message ?? `HTTP ${res.status}`, code: err?.code }
    }
    return { ok: true, status: res.status, data: parse ? parse(json) : (json as T) }
  } catch (err: any) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return { ok: false, status: 0, error: err?.message ?? String(err), code: timedOut ? 'timeout' : undefined }
  }
}

// ---------------------------------------------------------------------------
// Personal workspace wrappers — profile, goals, and activity primitives.
// ---------------------------------------------------------------------------

export interface PersonalProfile {
  id: string
  workspaceId: string
  name: string
  avatarUrl: string | null
  tagline: string | null
  personality: string | null
  statusText: string | null
  statusUpdatedAt: string | null
}

export interface PersonalGoal {
  id: string
  workspaceId: string
  title: string
  why: string | null
  status: 'active' | 'paused' | 'done'
  plan: unknown
  deliverables: unknown
  schedules?: AgentSchedule[]
  nextCheckInAt: string | null
  lastProgressAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PersonalGoalEvent {
  id: string
  goalId: string
  kind: 'progress' | 'blocker' | 'approval' | 'note' | 'deliverable'
  message: string
  metadata: unknown
  createdAt: string
}

export interface PersonalGoalCreateRequest {
  title: string
  why?: string | null
  status?: PersonalGoal['status']
  plan?: unknown
  deliverables?: unknown
  nextCheckInAt?: string | null
}

export interface PersonalGoalUpdateRequest {
  title?: string
  why?: string | null
  status?: PersonalGoal['status']
  plan?: unknown
  deliverables?: unknown
  nextCheckInAt?: string | null
  lastProgressAt?: string | null
}

export interface AgentSchedule {
  id: string
  workspaceId: string
  goalId: string | null
  userId: string
  name: string
  prompt: string
  cronExpression: string
  timezone: string
  enabled: boolean
  nextRunAt: string
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunSummary: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentScheduleCreateRequest {
  name: string
  prompt: string
  cronExpression: string
  timezone?: string
  goalId?: string | null
  enabled?: boolean
  userId?: string
}

export interface AgentScheduleUpdateRequest {
  name?: string
  prompt?: string
  cronExpression?: string
  timezone?: string
  goalId?: string | null
  enabled?: boolean
  userId?: string
}

async function personalFetch<T>(
  path: string,
  init: RequestInit & { parse?: (json: any) => T } = {},
): Promise<CheckpointCallResult<T>> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return { ok: false, status: 0, error: 'No API URL configured' }
  const { parse, ...rest } = init
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: getInternalHeaders(),
      signal: AbortSignal.timeout(20_000),
      ...rest,
    })
    const json = await res.json().catch(() => null) as any
    if (!res.ok) {
      const err = json?.error
      const message = typeof err === 'string' ? err : err?.message
      return { ok: false, status: res.status, error: message ?? `HTTP ${res.status}`, code: err?.code }
    }
    return { ok: true, status: res.status, data: parse ? parse(json) : (json as T) }
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? String(err) }
  }
}

export async function getAgentProfile(workspaceId: string): Promise<CheckpointCallResult<PersonalProfile>> {
  return personalFetch(`/api/internal/workspaces/${encodeURIComponent(workspaceId)}/agent-profile`, {
    method: 'GET',
    parse: (j) => j?.profile as PersonalProfile,
  })
}

export async function setAgentProfile(
  workspaceId: string,
  changes: Partial<Pick<PersonalProfile, 'name' | 'avatarUrl' | 'tagline' | 'personality' | 'statusText'>>,
): Promise<CheckpointCallResult<PersonalProfile>> {
  return personalFetch(`/api/internal/workspaces/${encodeURIComponent(workspaceId)}/agent-profile`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
    parse: (j) => j?.profile as PersonalProfile,
  })
}

export async function listGoals(
  workspaceId: string,
  status?: PersonalGoal['status'],
): Promise<CheckpointCallResult<PersonalGoal[]>> {
  const query = status ? `?status=${encodeURIComponent(status)}` : ''
  return personalFetch(`/api/internal/workspaces/${encodeURIComponent(workspaceId)}/goals${query}`, {
    method: 'GET',
    parse: (j) => (j?.goals ?? []) as PersonalGoal[],
  })
}

export async function getGoal(
  workspaceId: string,
  goalId: string,
): Promise<CheckpointCallResult<PersonalGoal & { events?: PersonalGoalEvent[] }>> {
  return personalFetch(
    `/api/internal/workspaces/${encodeURIComponent(workspaceId)}/goals/${encodeURIComponent(goalId)}`,
    { method: 'GET', parse: (j) => j?.goal as PersonalGoal & { events?: PersonalGoalEvent[] } },
  )
}

export async function createGoal(
  workspaceId: string,
  input: PersonalGoalCreateRequest,
): Promise<CheckpointCallResult<PersonalGoal>> {
  return personalFetch(`/api/internal/workspaces/${encodeURIComponent(workspaceId)}/goals`, {
    method: 'POST',
    body: JSON.stringify(input),
    parse: (j) => j?.goal as PersonalGoal,
  })
}

export async function updateGoal(
  workspaceId: string,
  goalId: string,
  input: PersonalGoalUpdateRequest,
): Promise<CheckpointCallResult<PersonalGoal>> {
  return personalFetch(
    `/api/internal/workspaces/${encodeURIComponent(workspaceId)}/goals/${encodeURIComponent(goalId)}`,
    { method: 'PATCH', body: JSON.stringify(input), parse: (j) => j?.goal as PersonalGoal },
  )
}

export async function logGoalEvent(
  workspaceId: string,
  goalId: string,
  input: { kind: PersonalGoalEvent['kind']; message: string; metadata?: unknown },
): Promise<CheckpointCallResult<PersonalGoalEvent>> {
  return personalFetch(
    `/api/internal/workspaces/${encodeURIComponent(workspaceId)}/goals/${encodeURIComponent(goalId)}/events`,
    { method: 'POST', body: JSON.stringify(input), parse: (j) => j?.event as PersonalGoalEvent },
  )
}

export async function listSchedules(
  workspaceId: string,
  goalId?: string,
): Promise<CheckpointCallResult<AgentSchedule[]>> {
  const query = goalId ? `?goalId=${encodeURIComponent(goalId)}` : ''
  return personalFetch(`/api/internal/workspaces/${encodeURIComponent(workspaceId)}/schedules${query}`, {
    method: 'GET',
    parse: (j) => (j?.schedules ?? []) as AgentSchedule[],
  })
}

export async function createSchedule(
  workspaceId: string,
  input: AgentScheduleCreateRequest,
): Promise<CheckpointCallResult<AgentSchedule>> {
  return personalFetch(`/api/internal/workspaces/${encodeURIComponent(workspaceId)}/schedules`, {
    method: 'POST',
    body: JSON.stringify(input),
    parse: (j) => j?.schedule as AgentSchedule,
  })
}

export async function updateSchedule(
  workspaceId: string,
  scheduleId: string,
  input: AgentScheduleUpdateRequest,
): Promise<CheckpointCallResult<AgentSchedule>> {
  return personalFetch(
    `/api/internal/workspaces/${encodeURIComponent(workspaceId)}/schedules/${encodeURIComponent(scheduleId)}`,
    { method: 'PATCH', body: JSON.stringify(input), parse: (j) => j?.schedule as AgentSchedule },
  )
}

export async function deleteSchedule(
  workspaceId: string,
  scheduleId: string,
  userId?: string,
): Promise<CheckpointCallResult<{ ok: true }>> {
  return personalFetch(
    `/api/internal/workspaces/${encodeURIComponent(workspaceId)}/schedules/${encodeURIComponent(scheduleId)}`,
    { method: 'DELETE', body: JSON.stringify({ userId }), parse: (j) => j as { ok: true } },
  )
}

/**
 * Upload raw image bytes as the agent's avatar and return the updated
 * profile. Unlike the other wrappers here this sends a binary body, so it
 * can't go through `personalFetch` (which always sets
 * `Content-Type: application/json`). Used by `agent_profile_set` in
 * `workspace-agent-tools.ts` when called with `avatarImagePath` — the
 * generated image never leaves this pod as a raw filesystem path, it's
 * uploaded to durable storage and the resulting URL becomes `avatarUrl`.
 */
export async function uploadAgentAvatar(
  workspaceId: string,
  imageBuffer: Buffer,
  contentType = 'image/png',
): Promise<CheckpointCallResult<PersonalProfile>> {
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return { ok: false, status: 0, error: 'No API URL configured' }
  try {
    const res = await fetch(
      `${apiUrl}/api/internal/workspaces/${encodeURIComponent(workspaceId)}/agent-avatar`,
      {
        method: 'POST',
        headers: { ...getInternalHeaders(), 'Content-Type': contentType },
        body: imageBuffer as unknown as BodyInit,
        signal: AbortSignal.timeout(30_000),
      },
    )
    const json = (await res.json().catch(() => null)) as any
    if (!res.ok) {
      const err = json?.error
      const message = typeof err === 'string' ? err : err?.message
      return { ok: false, status: res.status, error: message ?? `HTTP ${res.status}`, code: err?.code }
    }
    return { ok: true, status: res.status, data: json?.profile as PersonalProfile }
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? String(err) }
  }
}

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
  workingMode: string
  settings: unknown
  createdAt?: string
}

export interface CreateProjectRequest {
  name: string
  description?: string
  techStackId?: string
  workingMode?: 'managed' | 'external'
  templateId?: string
  settings?: Record<string, unknown>
  hidden?: boolean
  /** Acting user — forwarded from ToolContext.userId when present. */
  userId?: string
}

export async function createProject(
  workspaceId: string,
  req: CreateProjectRequest,
): Promise<CheckpointCallResult<ProjectSummary>> {
  return lifecycleFetch(`/api/internal/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
    method: 'POST',
    body: JSON.stringify(req),
    parse: (j) => j?.project as ProjectSummary,
    timeoutMs: 30_000,
  })
}

export interface ProjectGraphNode {
  id: string
  name: string
  description: string | null
  workingMode: string
  settings: unknown
  attachments: Array<{ attachedProjectId: string; attachMode: 'readwrite' | 'readonly' }>
  agent: { heartbeatEnabled: boolean; heartbeatInterval: number; modelName: string; modelProvider: string } | null
}

export async function getWorkspaceProjectGraph(
  workspaceId: string,
): Promise<CheckpointCallResult<ProjectGraphNode[]>> {
  return lifecycleFetch(`/api/internal/workspaces/${encodeURIComponent(workspaceId)}/projects/graph`, {
    method: 'GET',
    parse: (j) => (j?.projects ?? []) as ProjectGraphNode[],
  })
}

export interface AttachmentRow {
  id: string
  attachedProjectId: string
  attachedProjectName: string | null
  attachMode: 'readwrite' | 'readonly'
}

export async function listProjectAttachments(projectId: string): Promise<CheckpointCallResult<AttachmentRow[]>> {
  return lifecycleFetch(`/api/internal/projects/${encodeURIComponent(projectId)}/attachments`, {
    method: 'GET',
    parse: (j) => (j?.attachments ?? []) as AttachmentRow[],
  })
}

export async function attachProject(
  anchorProjectId: string,
  attachedProjectId: string,
  attachMode: 'readwrite' | 'readonly' = 'readwrite',
): Promise<CheckpointCallResult<{ attachment: AttachmentRow; mounted: boolean }>> {
  return lifecycleFetch(`/api/internal/projects/${encodeURIComponent(anchorProjectId)}/attachments`, {
    method: 'POST',
    body: JSON.stringify({ attachedProjectId, attachMode }),
    parse: (j) => ({ attachment: j?.attachment as AttachmentRow, mounted: j?.mounted === true }),
    timeoutMs: 60_000,
  })
}

export async function detachProject(
  anchorProjectId: string,
  attachedProjectId: string,
): Promise<CheckpointCallResult<{ removed: boolean }>> {
  return lifecycleFetch(
    `/api/internal/projects/${encodeURIComponent(anchorProjectId)}/attachments/${encodeURIComponent(attachedProjectId)}`,
    { method: 'DELETE', parse: (j) => ({ removed: j?.removed === true }) },
  )
}

export interface ProjectConfigPatch {
  name?: string
  description?: string | null
  settings?: Record<string, unknown>
  slackEnabled?: boolean
  agent?: {
    heartbeatEnabled?: boolean
    heartbeatInterval?: number
    modelProvider?: string
    modelName?: string
    quietHoursStart?: string | null
    quietHoursEnd?: string | null
    quietHoursTimezone?: string | null
  }
}

export interface ProjectConfigSnapshot {
  id: string
  name: string
  description: string | null
  settings: unknown
  slackEnabled: boolean
  agent: {
    heartbeatEnabled: boolean
    heartbeatInterval: number
    modelProvider: string
    modelName: string
    quietHoursStart: string | null
    quietHoursEnd: string | null
    quietHoursTimezone: string | null
    nextHeartbeatAt: string | null
  } | null
}

export async function getProjectConfig(projectId: string): Promise<CheckpointCallResult<ProjectConfigSnapshot>> {
  return lifecycleFetch(`/api/internal/projects/${encodeURIComponent(projectId)}/config`, {
    method: 'GET',
    parse: (j) => j?.project as ProjectConfigSnapshot,
  })
}

export async function configureProject(
  projectId: string,
  patch: ProjectConfigPatch,
): Promise<CheckpointCallResult<ProjectConfigSnapshot>> {
  return lifecycleFetch(`/api/internal/projects/${encodeURIComponent(projectId)}/config`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    parse: (j) => j?.project as ProjectConfigSnapshot,
  })
}

export interface AgentCallRequest {
  message: string
  /** Pipeline correlation id, threaded into the callee's AgentCostMetric.metadata. */
  runId?: string
  /** Callee session key. Defaults to `run:<runId>` when a runId is given. */
  sessionId?: string
  /** Block for the reply (default true). */
  wait?: boolean
  /** Reply timeout in ms when waiting (default 5 min, max 20 min). */
  timeoutMs?: number
  callerProjectId?: string
}

export interface AgentCallResult {
  status: 'completed' | 'accepted'
  reply?: string
  runId?: string
  sessionId?: string
}

export async function callProjectAgent(
  targetProjectId: string,
  req: AgentCallRequest,
): Promise<CheckpointCallResult<AgentCallResult>> {
  const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 5 * 60_000, 10_000), 20 * 60_000)
  return lifecycleFetch(`/api/internal/projects/${encodeURIComponent(targetProjectId)}/agent-call`, {
    method: 'POST',
    body: JSON.stringify({ ...req, timeoutMs }),
    parse: (j) => j as AgentCallResult,
    // The API adds its own 5s grace on top of the runtime's wait budget.
    timeoutMs: req.wait === false ? 20_000 : timeoutMs + 10_000,
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
