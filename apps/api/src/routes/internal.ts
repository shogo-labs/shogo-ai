// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal API Routes
 *
 * Endpoints for cluster-internal communication between the API and runtime pods.
 * These are NOT exposed via external ingress — only reachable within the K8s cluster.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { join, resolve } from 'path'
import { validatePodToken } from '../lib/k8s-auth'
import {
  recordCheckpointForCommit,
  listCheckpoints as listCheckpointsSvc,
  getCheckpoint as getCheckpointSvc,
  rollback as rollbackSvc,
  getDiff as getDiffSvc,
} from '../services/checkpoint.service'
import { prisma } from '../lib/prisma'
import { hydrateRepo } from '../services/git-repo-store'
import { trackEvent } from '../services/loops.service'
import {
  attachProject,
  detachProject,
  getAttachedProjects,
} from '../services/workspace-session.service'
import { resolveWorkspaceRuntimeUrl } from '../lib/resolve-workspace-runtime-url'
import { deriveWorkspaceRuntimeToken } from '../lib/workspace-runtime-token'
import { getRuntimeManager } from '../lib/runtime/manager'
import { getMetalWarmPoolController } from '../lib/metal-warm-pool-controller'
import { resolve as resolvePath } from 'path'
import { searchWorkspaceHistory, renderWorkspaceTranscript, readWorkspacePlan } from '../lib/history-search'
import { workspaceAgentRoutes, type WorkspaceAgentAuthContext } from './workspace-agent'
import { saveAgentAvatar } from '../services/workspace-agent-cloud-storage'
import {
  authenticate,
  authorizeWorkspaceRuntimeRequest,
  authorizeWorkspaceScope,
  logAuthReject,
  validateAuth,
  type InternalIdentity,
} from './internal-auth'
import { projectTrustRoutes } from './internal-project-trust'

const app = new Hono()

// Resolve the workspaces root the same way server.ts does so the internal
// checkpoint routes operate on the same on-disk repos as the public ones.
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || resolve(process.cwd(), 'workspaces')

function internalWorkspacePath(projectId: string): string {
  return join(WORKSPACES_DIR, projectId)
}

/** Folder-linked projects have no Shogo-managed git → typed 409 (mirrors public route). */
function externalModeResponse(c: Context) {
  return c.json(
    {
      error: {
        code: 'checkpoints_disabled_in_external_mode',
        message:
          "Checkpoints are disabled for folder-linked projects. Use your own git workflow — Shogo doesn't manage the repo.",
      },
    },
    409,
  )
}

async function loadProjectForCheckpoints(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, workingMode: true } as any,
  })
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000

function checkRateLimit(projectId: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(projectId)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(projectId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

/**
 * GET /api/internal/pod-config/:projectId
 *
 * Called by runtime pods on boot (self-assign path) to fetch project-specific
 * environment variables. Authenticated via K8s ServiceAccount token.
 */
app.get('/pod-config/:projectId', async (c) => {
  const projectId = c.req.param('projectId')

  if (!checkRateLimit(projectId)) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  // Validate K8s SA token
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  const identity = await validatePodToken(token)
  if (!identity) {
    return c.json({ error: 'Invalid or unauthorized service account token' }, 403)
  }

  console.log(
    `[Internal] Pod config requested for ${projectId} by ${identity.serviceAccountName} in ${identity.namespace}`
  )

  // Build project env vars (reuses the same logic as warm pool assignment)
  try {
    const { getWarmPoolController } = await import('../lib/warm-pool-controller')
    const warmPool = getWarmPoolController()
    const env = await warmPool.buildProjectEnv(projectId)

    return c.json({ projectId, env })
  } catch (err: any) {
    console.error(`[Internal] Failed to build pod config for ${projectId}:`, err.message)
    return c.json({ error: 'Failed to build pod configuration' }, 500)
  }
})

/**
 * GET /api/internal/whoami/:serviceName
 *
 * Called by runtime pods on boot when they have neither an `ASSIGNED_PROJECT`
 * env var nor a `.shogo-pool-assignment` marker on disk — the failure mode
 * triggered when K8s recreates a promoted warm-pool pod (OOM kill, node
 * drain, deploy, eviction). The recreated pod still has its stable
 * `KNATIVE_SERVICE_NAME` from the Downward API, and the API has the
 * authoritative project↔service mapping in `Project.knativeServiceName`,
 * so the pod can ask "which project am I supposed to be serving?" without
 * any out-of-band coordination.
 *
 * Returns `{ projectId: string | null }`. A `null` projectId is a valid
 * answer ("this service is in the warm pool but not promoted") — the
 * caller stays in pool mode and waits for `/pool/assign`.
 *
 * Authenticated via K8s ServiceAccount token.
 */
app.get('/whoami/:serviceName', async (c) => {
  const serviceName = c.req.param('serviceName')

  // Defense-in-depth: limit to the Knative naming alphabet so we cannot be
  // tricked into a Prisma query with a wildcard. K8s already rejects names
  // outside RFC 1123 subdomain syntax, but the value comes off the wire.
  if (!/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(serviceName)) {
    return c.json({ error: 'Invalid serviceName' }, 400)
  }

  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }
  const token = authHeader.slice(7)
  const identity = await validatePodToken(token)
  if (!identity) {
    return c.json({ error: 'Invalid or unauthorized service account token' }, 403)
  }

  try {
    const { prisma } = await import('../lib/prisma')
    const project = await prisma.project.findFirst({
      where: { knativeServiceName: serviceName },
      select: { id: true },
    })
    return c.json({ projectId: project?.id ?? null })
  } catch (err: any) {
    console.error(`[Internal] whoami(${serviceName}) lookup failed:`, err.message)
    return c.json({ error: 'Lookup failed' }, 500)
  }
})

/**
 * POST /api/internal/heartbeat/complete
 *
 * Called by the agent pod after a heartbeat tick finishes.
 * Updates lastHeartbeatAt in the DB. Authenticated via K8s SA token.
 */
app.post('/heartbeat/complete', async (c) => {
  // Parse body first so we have projectId for runtime-token validation
  const body = await c.req.json()
  const projectId = body.projectId as string

  if (!projectId || typeof projectId !== 'string') {
    return c.json({ error: 'projectId is required' }, 400)
  }

  if (!(await validateAuth(c, projectId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const { prisma } = await import('../lib/prisma')
    await prisma.agentConfig.updateMany({
      where: { projectId },
      data: { lastHeartbeatAt: new Date() },
    })

    return c.json({ ok: true })
  } catch (err: any) {
    console.error(`[Internal] Failed to update heartbeat completion for ${projectId}:`, err.message)
    return c.json({ error: 'Failed to update heartbeat completion' }, 500)
  }
})

/**
 * PUT /api/internal/heartbeat/config/:projectId
 *
 * Update heartbeat scheduling config for an agent. Manages nextHeartbeatAt
 * based on enabled/disabled state and interval changes.
 */
app.put('/heartbeat/config/:projectId', async (c) => {
  const projectId = c.req.param('projectId')

  if (!(await validateAuth(c, projectId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const body = await c.req.json()

  try {
    const { prisma } = await import('../lib/prisma')
    const data: Record<string, any> = {}

    if (typeof body.heartbeatEnabled === 'boolean') {
      data.heartbeatEnabled = body.heartbeatEnabled
    }
    if (typeof body.heartbeatInterval === 'number' && body.heartbeatInterval >= 60) {
      data.heartbeatInterval = body.heartbeatInterval
    }
    if (body.quietHoursStart !== undefined) data.quietHoursStart = body.quietHoursStart || null
    if (body.quietHoursEnd !== undefined) data.quietHoursEnd = body.quietHoursEnd || null
    if (body.quietHoursTimezone !== undefined) data.quietHoursTimezone = body.quietHoursTimezone || null

    const existing = await prisma.agentConfig.findUnique({ where: { projectId } })
    if (!existing) {
      return c.json({ error: 'Agent config not found' }, 404)
    }

    const enabled = data.heartbeatEnabled ?? existing.heartbeatEnabled
    const interval = data.heartbeatInterval ?? existing.heartbeatInterval

    if (enabled) {
      const jitter = Math.floor(Math.random() * interval * 0.1) * 1000
      data.nextHeartbeatAt = new Date(Date.now() + interval * 1000 + jitter)
    } else {
      data.nextHeartbeatAt = null
    }

    await prisma.agentConfig.update({
      where: { projectId },
      data,
    })

    // FIRE-AND-FORGET: track first heartbeat scheduled when enabling for the first time
    if (enabled && !existing.heartbeatEnabled) {
      // Look up the project owner to identify the user
      prisma.project.findUnique({
        where: { id: projectId },
        select: { createdBy: true },
      }).then((proj) => {
        if (proj?.createdBy) {
          trackEvent(proj.createdBy, 'first_heartbeat_scheduled', { project_id: projectId }).catch(() => {})
        }
      }).catch(() => {})
    }

    return c.json({ ok: true, nextHeartbeatAt: data.nextHeartbeatAt })
  } catch (err: any) {
    console.error(`[Internal] Failed to update heartbeat config for ${projectId}:`, err.message)
    return c.json({ error: 'Failed to update heartbeat config' }, 500)
  }
})

/**
 * POST /api/internal/validate-preview-token
 *
 * Called by runtime pods to validate a preview JWT without holding the signing
 * secret. The API server verifies the token and returns the decoded payload.
 */
app.post('/validate-preview-token', async (c) => {
  if (!(await validateAuth(c))) {
    return c.json({ valid: false, error: 'Unauthorized' }, 401)
  }

  let body: { token?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ valid: false, error: 'Invalid request body' }, 400)
  }

  const token = body.token
  if (!token || typeof token !== 'string') {
    return c.json({ valid: false, error: 'token is required' }, 400)
  }

  try {
    const { verifyPreviewToken } = await import('../lib/preview-token')
    const payload = await verifyPreviewToken(token)
    if (!payload) {
      return c.json({ valid: false })
    }
    return c.json({ valid: true, projectId: payload.projectId, exp: payload.exp })
  } catch (err: any) {
    console.error('[Internal] Failed to validate preview token:', err.message)
    return c.json({ valid: false, error: 'Validation failed' }, 500)
  }
})

/**
 * POST /api/internal/validate-runtime-token
 *   body: { token: string, expectedProjectId?: string }
 *
 * Called by runtime pods to validate an incoming `x-runtime-token` whose
 * byte-for-byte value does NOT match the pod's own `RUNTIME_AUTH_SECRET`.
 * That mismatch is normal during:
 *   - warm-pool reassignment races (pod env updated, in-flight request
 *     still carries the previous project's token, or vice versa),
 *   - signing-secret rotation windows where the API has dual-rotated but
 *     a long-lived pod still holds the old derived token,
 *   - stale-image pods inherited across a deploy.
 *
 * The pod can't HMAC-verify a v1 token itself without holding the platform
 * signing secret (deliberately scoped to the API to keep blast radius tight
 * — see `apps/api/src/lib/runtime-token.md`). So the pod delegates: hand
 * the API the token, the API returns `{ valid, projectId }`. Mirrors the
 * existing `/validate-preview-token` pattern.
 *
 * Authenticated like the rest of /internal: K8s SA bearer, or HMAC-signed
 * `x-runtime-token` (metal / local desktop / Knative SA fallthrough).
 */
app.post('/validate-runtime-token', async (c) => {
  if (!(await validateAuth(c))) {
    return c.json({ valid: false, error: 'Unauthorized' }, 401)
  }

  let body: { token?: string; expectedProjectId?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ valid: false, error: 'Invalid request body' }, 400)
  }

  const token = body.token
  if (!token || typeof token !== 'string') {
    return c.json({ valid: false, error: 'token is required' }, 400)
  }

  try {
    const { verifyRuntimeToken } = await import('../lib/runtime-token')
    // v1 tokens self-identify, so expectedProjectId is only consulted as a
    // legacy fallback. We pass it through but verifyRuntimeToken ignores it
    // when the token is v1-formatted.
    const verified = verifyRuntimeToken(token, body.expectedProjectId)
    if (!verified.ok) {
      return c.json({ valid: false, reason: verified.reason })
    }
    return c.json({ valid: true, projectId: verified.projectId, format: verified.format })
  } catch (err: any) {
    console.error('[Internal] Failed to validate runtime token:', err.message)
    return c.json({ valid: false, error: 'Validation failed' }, 500)
  }
})

/**
 * GET /api/internal/subagent-overrides/resolve
 *   ?workspaceId=...&projectId=...&agentType=...
 *
 * Called by agent-runtime spawning a sub-agent to learn whether the user has
 * overridden the built-in default model for this agent type. Authenticated
 * via K8s SA token or HMAC-signed `x-runtime-token`.
 *
 * Returns 200 { override: { model, provider, source } | null }.
 */
app.get('/subagent-overrides/resolve', async (c) => {
  const workspaceId = c.req.query('workspaceId')
  const projectId = c.req.query('projectId') || undefined
  const agentType = c.req.query('agentType')
  // Phase 3.2 — optional bucket key so the experiment assignment is stable
  // for repeated calls with the same agentRunId (no double-assignment within
  // a single chat turn).
  const bucketKey = c.req.query('bucketKey') || undefined

  if (!workspaceId || !agentType) {
    return c.json({ error: 'workspaceId and agentType are required' }, 400)
  }

  if (!(await authorizeWorkspaceScope(c, workspaceId, projectId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const { resolveSubagentModelOverride, pickExperimentModel } = await import(
      '../services/cost-analytics.service'
    )
    const override = await resolveSubagentModelOverride(workspaceId, agentType, projectId)
    if (override) return c.json({ override, experiment: null })

    // No explicit override — fall back to the active experiment, if any.
    const exp = await pickExperimentModel(workspaceId, agentType, bucketKey)
    return c.json({ override: null, experiment: exp })
  } catch (err: any) {
    console.error(`[Internal] Failed to resolve subagent override for ${workspaceId}/${agentType}:`, err.message)
    return c.json({ error: 'Failed to resolve override' }, 500)
  }
})

/**
 * POST /api/internal/agent-cost-metrics
 *   body: { workspaceId, projectId?, agentRunId?, agentType, model,
 *           inputTokens, outputTokens, cachedInputTokens?, toolCalls,
 *           creditCost, wallTimeMs, success, hitMaxTurns?, loopDetected?,
 *           escalated?, responseEmpty? }
 *
 * Called by agent-runtime when a sub-agent run completes (Phase 2.1). The
 * runtime emits the legacy `success` flag plus the multi-signal quality
 * fields; the API server persists them so the recommendation gate can score
 * runs on real quality instead of "didn't throw".
 *
 * Authenticated like the override endpoint above.
 */
app.post('/agent-cost-metrics', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const projectId = typeof body.projectId === 'string' ? body.projectId : undefined
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null
  // The target workspace comes from the body, so a project/workspace runtime
  // token must be checked against it — otherwise any pod could write metrics
  // (and skew model-quality analytics) for a workspace it doesn't belong to.
  if (!(await authorizeWorkspaceScope(c, workspaceId, projectId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const agentType = typeof body.agentType === 'string' ? body.agentType : null
  const model = typeof body.model === 'string' ? body.model : null
  if (!workspaceId || !agentType || !model) {
    return c.json({ error: 'workspaceId, agentType, and model are required' }, 400)
  }

  try {
    const { recordAgentCostMetric } = await import('../services/cost-analytics.service')
    await recordAgentCostMetric({
      workspaceId,
      projectId,
      agentRunId: typeof body.agentRunId === 'string' ? body.agentRunId : undefined,
      agentType,
      model,
      inputTokens: numberOr(body.inputTokens, 0),
      outputTokens: numberOr(body.outputTokens, 0),
      cachedInputTokens: numberOr(body.cachedInputTokens, 0),
      toolCalls: numberOr(body.toolCalls, 0),
      creditCost: numberOr(body.creditCost, 0),
      wallTimeMs: numberOr(body.wallTimeMs, 0),
      success: body.success !== false,
      hitMaxTurns: body.hitMaxTurns === true,
      loopDetected: body.loopDetected === true,
      escalated: body.escalated === true,
      responseEmpty: body.responseEmpty === true,
      // Free-form correlation (e.g. `pipelineRunId` from `project_call`).
      // Bounded so a runtime can't stuff arbitrary payloads into analytics.
      metadata:
        body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          && JSON.stringify(body.metadata).length <= 4_096
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    })
    return c.json({ ok: true })
  } catch (err: any) {
    console.error('[Internal] Failed to record agent cost metric:', err.message)
    return c.json({ error: 'Failed to record metric' }, 500)
  }
})

// ---------------------------------------------------------------------------
// Workspace agent profile and goals (universal workspace primitives; see
// routes/workspace-agent.ts). Mounted here with the runtime-pod / SA
// authorization strategy — the handler implementation is shared with the
// session-authenticated mount in server.ts so the two surfaces can't drift.
// ---------------------------------------------------------------------------

app.route(
  '/',
  workspaceAgentRoutes({
    saveAgentAvatar,
    authorize: async (c): Promise<WorkspaceAgentAuthContext | Response> => {
      const workspaceId = c.req.param('workspaceId')
      if (!(await authorizeWorkspaceScope(c, workspaceId))) {
        return c.json({ error: 'Unauthorized' }, 401)
      }
      return { workspaceId }
    },
  }),
)

// ---------------------------------------------------------------------------
// Workspace meta-agent membership
// ---------------------------------------------------------------------------

/**
 * User-facing project catalog for this workspace: what `list_projects`
 * returns to the agent for chat display, and what the mount/unmount member
 * endpoints below use to authorize attaching a project to a session.
 * Excludes `hidden` projects (personal-companion builder delegates, or any
 * workspace's explicitly-hidden projects) — those are resolved by id only
 * (`project_call`), never surfaced in a list a user or chat transcript can
 * read. `list_projects`/`mount_project`/`unmount_project` are themselves
 * disabled for the `personal` capability profile (see
 * `capability-profiles.ts`), so this only affects team workspaces today.
 */
async function accessibleWorkspaceProjects(workspaceId: string, userId: string) {
  const workspaceMember = await prisma.member.findFirst({
    where: { workspaceId, userId },
    select: { id: true },
  })
  return prisma.project.findMany({
    where: {
      workspaceId,
      hidden: false,
      ...(workspaceMember ? {} : { members: { some: { userId } } }),
    },
    select: { id: true, name: true, description: true, createdBy: true },
    orderBy: { name: 'asc' },
  })
}

async function workspaceRuntimeMemberCall(
  workspaceId: string,
  attachedProjectIds: string[],
  path: string,
  init: RequestInit,
  opts: { readonlyProjectIds?: string[]; hostRealPath?: string } = {},
) {
  const resolved = await resolveWorkspaceRuntimeUrl(workspaceId, {
    attachedProjectIds,
    runtimeManager: getRuntimeManager(),
    alwaysEnabled: true,
    logTag: 'WorkspaceMembers',
  })
  const requestJson =
    typeof init.body === 'string' ? JSON.parse(init.body) : {}
  if (resolved.mode === 'metal' && path.startsWith('/internal/workspace/members')) {
    const projectId =
      typeof requestJson?.id === 'string'
        ? requestJson.id
        : decodeURIComponent(path.split('/').pop() || '')
    const result = await getMetalWarmPoolController().workspaceMember(
      workspaceId,
      path.endsWith('/members') ? 'mount' : 'unmount',
      projectId,
      `/app/workspace/${projectId}`,
    )
    return { resolved, body: result }
  }
  if (resolved.mode === 'host') {
    await getRuntimeManager().refreshWorkspaceMergedRoot(
      workspaceId,
      attachedProjectIds,
      opts.readonlyProjectIds ?? [],
    )
  }
  let requestBody = init.body
  if (resolved.mode === 'host' && opts.hostRealPath && typeof requestBody === 'string') {
    const parsed = JSON.parse(requestBody)
    parsed.realPath = opts.hostRealPath
    requestBody = JSON.stringify(parsed)
  }
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('x-runtime-token', deriveWorkspaceRuntimeToken(workspaceId))
  const response = await fetch(`${resolved.url}${path}`, { ...init, headers, ...(requestBody ? { body: requestBody } : {}) })
  const responseBody = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(responseBody?.error?.message || responseBody?.error || `workspace runtime HTTP ${response.status}`)
  }
  return { resolved, body: responseBody }
}

app.get('/workspaces/:workspaceId/projects', async (c) => {
  const workspaceId = c.req.param('workspaceId')
  const identity = await authorizeWorkspaceRuntimeRequest(c, workspaceId)
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  const userId = c.req.query('userId')
  const sessionId = c.req.query('sessionId')
  if (!userId) return c.json({ error: 'userId is required' }, 400)
  const projects = await accessibleWorkspaceProjects(workspaceId, userId)
  const attached = sessionId ? await getAttachedProjects(sessionId) : []
  const attachedIds = new Set(attached.map((row) => row.projectId))
  return c.json({
    projects: projects.map((project) => ({
      ...project,
      mounted: attachedIds.has(project.id),
      attachMode: attached.find((row) => row.projectId === project.id)?.attachMode ?? null,
    })),
  })
})

app.get('/workspaces/:workspaceId/history/search', async (c) => {
  const workspaceId = c.req.param('workspaceId')
  if (!(await authorizeWorkspaceScope(c, workspaceId))) return c.json({ error: 'Unauthorized' }, 401)
  const rawKind = c.req.query('kind')
  const kind = rawKind === 'chat' || rawKind === 'plan' ? rawKind : 'all'
  return c.json({
    workspaceId,
    kind,
    ...(await searchWorkspaceHistory({
      workspaceId,
      query: c.req.query('q') || c.req.query('query') || '',
      kind,
      limit: Number(c.req.query('limit') || 8),
      excludeSessionId: c.req.query('exclude') || undefined,
    })),
  })
})

app.get('/workspaces/:workspaceId/history/read', async (c) => {
  const workspaceId = c.req.param('workspaceId')
  if (!(await authorizeWorkspaceScope(c, workspaceId))) return c.json({ error: 'Unauthorized' }, 401)
  const kind = c.req.query('kind')
  const id = c.req.query('id')
  if ((kind !== 'chat' && kind !== 'plan') || !id) return c.json({ error: 'kind and id are required' }, 400)
  if (kind === 'plan') {
    const plan = await readWorkspacePlan(id, { workspaceId })
    return plan ? c.json(plan) : c.json({ error: 'Not found' }, 404)
  }
  const transcript = await renderWorkspaceTranscript(id, {
    workspaceId,
    from: Number(c.req.query('from') || 0),
    limit: Number(c.req.query('limit') || 100),
  })
  return transcript ? c.json(transcript) : c.json({ error: 'Not found' }, 404)
})

app.get('/chat-sessions/:chatSessionId/transcript', async (c) => {
  const chatSessionId = c.req.param('chatSessionId')
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId || !(await authorizeWorkspaceScope(c, workspaceId))) return c.json({ error: 'Unauthorized' }, 401)
  const transcript = await renderWorkspaceTranscript(chatSessionId, {
    workspaceId,
    from: Number(c.req.query('from') || 0),
    limit: Number(c.req.query('limit') || 100),
  })
  return transcript ? c.json(transcript) : c.json({ error: 'Not found' }, 404)
})

app.post('/plans', async (c) => {
  // `workspaceId`/`projectId` are read from the QUERY string (not just the
  // body) so `resolveWorkspaceIdForRequest` can home-region-route this write
  // via its normal path/query resolution (steps 2/5b) *before* the body is
  // read/proxied. The router deliberately never reads the body — a body-only
  // workspaceId falls through to "handle locally", which is wrong here since
  // this route can UPDATE an existing row (upsert-by-filename), not just
  // create one. Callers (see `postPlanMirror`) must send both as query params.
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.filename !== 'string' || typeof body.content !== 'string') return c.json({ error: 'filename and content are required' }, 400)
  const projectId = c.req.query('projectId') || (typeof body.projectId === 'string' ? body.projectId : undefined)
  const workspaceId = c.req.query('workspaceId') || (typeof body.workspaceId === 'string'
    ? body.workspaceId
    : projectId
      ? (await (prisma as any).project.findUnique({ where: { id: projectId }, select: { workspaceId: true } }))?.workspaceId ?? null
      : null)
  if (!(await authorizeWorkspaceScope(c, workspaceId, projectId))) return c.json({ error: 'Unauthorized' }, 401)
  const where = { projectId: projectId ?? null, filename: body.filename }
  const existing = await (prisma as any).plan.findFirst({ where })
  const data = {
    workspaceId,
    projectId: projectId ?? null,
    chatSessionId: typeof body.chatSessionId === 'string' ? body.chatSessionId : null,
    runtimeKey: typeof body.runtimeKey === 'string' ? body.runtimeKey : null,
    filename: body.filename,
    name: typeof body.name === 'string' ? body.name : body.filename,
    overview: typeof body.overview === 'string' ? body.overview : '',
    status: typeof body.status === 'string' ? body.status : 'pending',
    content: body.content,
    ...(body.createdAt ? { createdAt: new Date(String(body.createdAt)) } : {}),
  }
  const plan = existing
    ? await (prisma as any).plan.update({ where: { id: existing.id }, data })
    : await (prisma as any).plan.create({ data })
  return c.json(plan)
})

app.delete('/plans', async (c) => {
  // See the POST /plans comment above: workspaceId/projectId must come from
  // the query string for the home-region router to resolve this write.
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.filename !== 'string') return c.json({ error: 'filename is required' }, 400)
  const projectId = c.req.query('projectId') || (typeof body.projectId === 'string' ? body.projectId : undefined)
  const workspaceId = c.req.query('workspaceId') || (typeof body.workspaceId === 'string'
    ? body.workspaceId
    : projectId
      ? (await (prisma as any).project.findUnique({ where: { id: projectId }, select: { workspaceId: true } }))?.workspaceId ?? null
      : null)
  if (!(await authorizeWorkspaceScope(c, workspaceId, projectId))) return c.json({ error: 'Unauthorized' }, 401)
  const existing = await (prisma as any).plan.findFirst({ where: { projectId: projectId ?? null, filename: body.filename } })
  if (existing) await (prisma as any).plan.delete({ where: { id: existing.id } })
  return c.json({ deleted: Boolean(existing) })
})

app.post('/workspaces/:workspaceId/sessions/:sessionId/members', async (c) => {
  const workspaceId = c.req.param('workspaceId')
  const sessionId = c.req.param('sessionId')
  const identity = await authorizeWorkspaceRuntimeRequest(c, workspaceId)
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  const projectId = typeof body?.projectId === 'string' ? body.projectId : ''
  if (!userId || !projectId) return c.json({ error: 'userId and projectId are required' }, 400)
  const projects = await accessibleWorkspaceProjects(workspaceId, userId)
  const project = projects.find((row) => row.id === projectId)
  if (!project) return c.json({ error: 'Project is not accessible in this workspace' }, 403)

  try {
    const attachedRow = await attachProject(
      sessionId,
      projectId,
      body?.attachMode === 'readonly' ? 'readonly' : 'readwrite',
    )
    const attached = await getAttachedProjects(sessionId)
    const attachedIds = attached.map((row) => row.projectId)
    const readonlyIds = attached.filter((row) => row.attachMode === 'readonly').map((row) => row.projectId)
    const hostPath = resolvePath(process.env.WORKSPACES_DIR || resolvePath(process.cwd(), 'workspaces'), projectId)
    const { body: runtimeBody } = await workspaceRuntimeMemberCall(
      workspaceId,
      attachedIds,
      '/internal/workspace/members',
      {
        method: 'POST',
        body: JSON.stringify({
          id: project.id,
          name: project.name,
          description: project.description,
          readonly: attachedRow.attachMode === 'readonly',
        }),
      },
      {
        readonlyProjectIds: readonlyIds,
        hostRealPath: hostPath,
      },
    )
    return c.json({ ok: true, attached: attachedRow, project, runtime: runtimeBody })
  } catch (error: any) {
    return c.json({ error: error?.message ?? 'mount failed' }, 502)
  }
})

app.delete('/workspaces/:workspaceId/sessions/:sessionId/members/:projectId', async (c) => {
  const workspaceId = c.req.param('workspaceId')
  const sessionId = c.req.param('sessionId')
  const projectId = c.req.param('projectId')
  const identity = await authorizeWorkspaceRuntimeRequest(c, workspaceId)
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json().catch(() => ({}))
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  if (!userId) return c.json({ error: 'userId is required' }, 400)
  const accessible = await accessibleWorkspaceProjects(workspaceId, userId)
  if (!accessible.some((project) => project.id === projectId)) {
    return c.json({ error: 'Project is not accessible in this workspace' }, 403)
  }
  try {
    const removed = await detachProject(sessionId, projectId)
    const attached = await getAttachedProjects(sessionId)
    const attachedIds = attached.map((row) => row.projectId)
    const readonlyIds = attached.filter((row) => row.attachMode === 'readonly').map((row) => row.projectId)
    const { body: runtimeBody } = await workspaceRuntimeMemberCall(
      workspaceId,
      attachedIds,
      `/internal/workspace/members/${encodeURIComponent(projectId)}`,
      { method: 'DELETE', body: JSON.stringify({}) },
    )
    return c.json({ ok: true, removed, runtime: runtimeBody })
  } catch (error: any) {
    return c.json({ error: error?.message ?? 'unmount failed' }, 502)
  }
})

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * POST /api/internal/agent-eval-results
 *   body: { workspaceId?, agentType, model, provider?, suite, totalCases,
 *           passedCases, avgWallTimeMs?, avgCreditCost?, commitSha?, metadata? }
 *
 * Persists the outcome of an evaluation suite run for a (agentType, model)
 * pair. Used by the nightly eval pipeline + the bench-explore-models script
 * (Phase 3.1) to give the recommendation gate eval-anchored ground truth.
 *
 * `workspaceId` is optional — global eval results (no workspace) are visible
 * to every workspace as the default anchor. Because a global row is an anchor
 * for *every* workspace's recommendation gate, writing one requires a
 * cluster-scoped SA credential; a runtime token may only write rows scoped to
 * its own workspace.
 */
app.post('/agent-eval-results', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const bodyWorkspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null
  if (!(await authorizeWorkspaceScope(c, bodyWorkspaceId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const agentType = typeof body.agentType === 'string' ? body.agentType : null
  const model = typeof body.model === 'string' ? body.model : null
  const suite = typeof body.suite === 'string' ? body.suite : null
  if (!agentType || !model || !suite) {
    return c.json({ error: 'agentType, model, and suite are required' }, 400)
  }

  const totalCases = numberOr(body.totalCases, 0)
  const passedCases = numberOr(body.passedCases, 0)
  if (totalCases <= 0) {
    return c.json({ error: 'totalCases must be > 0' }, 400)
  }
  if (passedCases < 0 || passedCases > totalCases) {
    return c.json({ error: 'passedCases must be in [0, totalCases]' }, 400)
  }

  try {
    const { recordAgentEvalResult } = await import('../services/cost-analytics.service')
    const row = await recordAgentEvalResult({
      workspaceId: bodyWorkspaceId,
      agentType,
      model,
      provider: typeof body.provider === 'string' ? body.provider : null,
      suite,
      totalCases,
      passedCases,
      avgWallTimeMs: numberOr(body.avgWallTimeMs, 0),
      avgCreditCost: numberOr(body.avgCreditCost, 0),
      commitSha: typeof body.commitSha === 'string' ? body.commitSha : null,
      metadata: body.metadata && typeof body.metadata === 'object'
        ? (body.metadata as Record<string, unknown>)
        : undefined,
    })
    return c.json({ ok: true, id: row.id, passRate: row.passRate })
  } catch (err: any) {
    console.error('[Internal] Failed to record agent eval result:', err.message)
    return c.json({ error: 'Failed to record eval result' }, 500)
  }
})

// GET /projects/:projectId/trust — see ./internal-project-trust.ts
app.route('/', projectTrustRoutes({ authorize: validateAuth }))

/**
 * POST /api/internal/projects/:projectId/checkpoints/record
 *   body: { commitSha, commitMessage, branch, filesChanged, additions,
 *           deletions, isAutomatic? }
 *
 * Called by the agent-runtime pod after each local commit in the pod-owned
 * `git_only` model. The pod owns the durable repo (it persists `.git` to
 * object storage) and no longer pushes to an API origin, so the legacy
 * post-receive hook can't write the `ProjectCheckpoint` row. The pod
 * computes the commit metadata locally and hands it to us; we insert the
 * row, idempotent on `commitSha`.
 *
 * Auth: K8s SA token (cluster) OR `x-runtime-token` (local desktop).
 */
app.post('/projects/:projectId/checkpoints/record', async (c) => {
  const projectId = c.req.param('projectId')
  if (!projectId) return c.json({ error: 'Missing projectId' }, 400)

  if (!(await validateAuth(c, projectId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const commitSha = typeof body.commitSha === 'string' ? body.commitSha : null
  if (!commitSha || !/^[0-9a-f]{7,64}$/i.test(commitSha)) {
    return c.json({ error: 'Valid commitSha is required' }, 400)
  }

  try {
    // Idempotent on (projectId, commitSha) — a re-delivered record (pod retry,
    // warm-pool race) must not create a duplicate row. Shared with the publish
    // flow via checkpoint.service so both paths dedupe identically.
    const result = await recordCheckpointForCommit(projectId, commitSha, {
      commitMessage: typeof body.commitMessage === 'string' ? body.commitMessage : undefined,
      branch: typeof body.branch === 'string' ? body.branch : undefined,
      filesChanged: numberOr(body.filesChanged, 0),
      additions: numberOr(body.additions, 0),
      deletions: numberOr(body.deletions, 0),
      isAutomatic: body.isAutomatic !== false,
    })
    if (!result) {
      return c.json({ error: 'Valid commitSha is required' }, 400)
    }
    return c.json({ ok: true, id: result.id, ...(result.deduped && { deduped: true }) })
  } catch (err: any) {
    console.error(`[Internal] Failed to record checkpoint for ${projectId}:`, err.message)
    return c.json({ error: 'Failed to record checkpoint' }, 500)
  }
})

/**
 * GET  /api/internal/projects/:projectId/checkpoints                  — list
 * GET  /api/internal/projects/:projectId/checkpoints/:checkpointId    — detail
 * GET  /api/internal/projects/:projectId/checkpoints/:checkpointId/diff — diff vs HEAD
 * POST /api/internal/projects/:projectId/checkpoints/:checkpointId/rollback
 *
 * Cluster-internal mirror of the public checkpoint routes so the agent-runtime
 * pod can let the agent SEE and USE the existing auto-checkpoint/rollback
 * system (fixes the "no git history" lie + hand-reverts). Auth: K8s SA token
 * (cluster) OR `x-runtime-token` (local desktop). Folder-linked (external)
 * projects return a typed 409 the agent surfaces gracefully.
 */
app.get('/projects/:projectId/checkpoints', async (c) => {
  const projectId = c.req.param('projectId')
  if (!projectId) return c.json({ error: 'Missing projectId' }, 400)
  if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const project = await loadProjectForCheckpoints(projectId)
    if (!project) return c.json({ error: 'Project not found' }, 404)
    if ((project as any).workingMode === 'external') return externalModeResponse(c)

    const limit = Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100)
    const checkpoints = await listCheckpointsSvc(projectId, { limit })
    return c.json({ ok: true, checkpoints })
  } catch (err: any) {
    console.error(`[Internal] checkpoint list for ${projectId} failed:`, err.message)
    return c.json({ error: 'Failed to list checkpoints' }, 500)
  }
})

app.get('/projects/:projectId/checkpoints/:checkpointId', async (c) => {
  const projectId = c.req.param('projectId')
  const checkpointId = c.req.param('checkpointId')
  if (!projectId || !checkpointId) return c.json({ error: 'Missing params' }, 400)
  if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const project = await loadProjectForCheckpoints(projectId)
    if (!project) return c.json({ error: 'Project not found' }, 404)
    if ((project as any).workingMode === 'external') return externalModeResponse(c)

    const checkpoint = await getCheckpointSvc(checkpointId)
    if (!checkpoint) return c.json({ error: 'Checkpoint not found' }, 404)
    return c.json({ ok: true, checkpoint })
  } catch (err: any) {
    console.error(`[Internal] checkpoint get for ${projectId} failed:`, err.message)
    return c.json({ error: 'Failed to get checkpoint' }, 500)
  }
})

app.get('/projects/:projectId/checkpoints/:checkpointId/diff', async (c) => {
  const projectId = c.req.param('projectId')
  const checkpointId = c.req.param('checkpointId')
  if (!projectId || !checkpointId) return c.json({ error: 'Missing params' }, 400)
  if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const project = await loadProjectForCheckpoints(projectId)
    if (!project) return c.json({ error: 'Project not found' }, 404)
    if ((project as any).workingMode === 'external') return externalModeResponse(c)

    const workspacePath = internalWorkspacePath(projectId)
    await hydrateRepo(projectId, workspacePath).catch((err) =>
      console.warn(`[Internal] hydrate for ${projectId} failed:`, err?.message ?? err),
    )
    const diff = await getDiffSvc(workspacePath, checkpointId, c.req.query('to'))
    if (!diff) return c.json({ error: 'Checkpoint not found' }, 404)
    return c.json({ ok: true, diff })
  } catch (err: any) {
    console.error(`[Internal] checkpoint diff for ${projectId} failed:`, err.message)
    return c.json({ error: 'Failed to get diff' }, 500)
  }
})

app.post('/projects/:projectId/checkpoints/:checkpointId/rollback', async (c) => {
  const projectId = c.req.param('projectId')
  const checkpointId = c.req.param('checkpointId')
  if (!projectId || !checkpointId) return c.json({ error: 'Missing params' }, 400)
  if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const project = await loadProjectForCheckpoints(projectId)
    if (!project) return c.json({ error: 'Project not found' }, 404)
    if ((project as any).workingMode === 'external') return externalModeResponse(c)

    const body = (await c.req.json().catch(() => ({}))) as { includeDatabase?: boolean }
    const workspacePath = internalWorkspacePath(projectId)
    await hydrateRepo(projectId, workspacePath).catch((err) =>
      console.warn(`[Internal] hydrate for ${projectId} failed:`, err?.message ?? err),
    )
    const result = await rollbackSvc({
      projectId,
      workspacePath,
      checkpointId,
      includeDatabase: body.includeDatabase === true,
      createdBy: 'agent',
    })
    if (!result.success) {
      return c.json({ error: result.error || 'Rollback failed' }, 400)
    }
    return c.json({
      ok: true,
      rolledBackTo: result.previousCheckpoint,
      newCheckpoint: result.newCheckpoint,
    })
  } catch (err: any) {
    console.error(`[Internal] checkpoint rollback for ${projectId} failed:`, err.message)
    return c.json({ error: 'Failed to rollback' }, 500)
  }
})

/**
 * GET /api/internal/projects/:projectId/publish — current publish state.
 *
 * Lets the agent's publish tool tell a first publish (no subdomain yet, must
 * confirm one with the user) from a republish (reuse the live subdomain). Auth:
 * K8s SA token (cluster) OR HMAC-signed `x-runtime-token` (metal / local).
 */
app.get('/projects/:projectId/publish', async (c) => {
  const projectId = c.req.param('projectId')
  if (!projectId) return c.json({ error: 'Missing projectId' }, 400)
  if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

  try {
    const { prisma } = await import('../lib/prisma')
    const project = (await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        publishedSubdomain: true,
        publishedAt: true,
        accessLevel: true,
        sitePasswordHash: true,
        publishStatus: true,
      } as any,
    })) as Record<string, any> | null
    if (!project) return c.json({ error: 'Project not found' }, 404)

    return c.json({
      ok: true,
      published: !!project.publishedSubdomain,
      subdomain: project.publishedSubdomain ?? null,
      publishedAt: project.publishedAt ? new Date(project.publishedAt).getTime() : null,
      accessLevel: project.accessLevel ?? null,
      hasPassword: !!project.sitePasswordHash,
      publishStatus: project.publishStatus ?? null,
    })
  } catch (err: any) {
    console.error(`[Internal] publish state for ${projectId} failed:`, err.message)
    return c.json({ error: 'Failed to get publish state' }, 500)
  }
})

/**
 * POST /api/internal/projects/:projectId/publish — publish/republish a project.
 *
 * Cluster-internal mirror of POST /api/projects/:id/publish so the agent's
 * publish tool can deploy `{subdomain}.shogo.one` directly (the public route is
 * session-authenticated and unreachable from the pod). Shares the exact same
 * pipeline via `publishProject`. Auth: K8s SA token (cluster) OR
 * HMAC-signed `x-runtime-token` (metal / local).
 */
app.post('/projects/:projectId/publish', async (c) => {
  const projectId = c.req.param('projectId')
  if (!projectId) return c.json({ error: 'Missing projectId' }, 400)
  if (!(await validateAuth(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)

  let body: { subdomain?: string; accessLevel?: any; password?: string; siteTitle?: string; siteDescription?: string }
  try {
    body = (await c.req.json()) as typeof body
  } catch {
    return c.json({ error: { code: 'invalid_body', message: 'Invalid JSON body' } }, 400)
  }
  if (!body.subdomain || typeof body.subdomain !== 'string') {
    return c.json({ error: { code: 'subdomain_required', message: 'subdomain is required' } }, 400)
  }

  try {
    const { publishProject } = await import('./publish')
    const result = await publishProject(projectId, {
      subdomain: body.subdomain,
      accessLevel: body.accessLevel,
      password: body.password,
      siteTitle: body.siteTitle,
      siteDescription: body.siteDescription,
    })
    if (!result.ok) {
      return c.json({ error: { code: result.code, message: result.message } }, result.status as any)
    }
    return c.json({
      ok: true,
      url: result.url,
      subdomain: result.subdomain,
      publishedAt: result.publishedAt,
      accessLevel: result.accessLevel,
      hasPassword: result.hasPassword,
    })
  } catch (err: any) {
    console.error(`[Internal] publish for ${projectId} failed:`, err.message)
    return c.json({ error: { code: 'publish_failed', message: 'Failed to publish' } }, 500)
  }
})

/**
 * POST /api/internal/chat-sessions/:chatSessionId/worktree
 *   body: { worktreeBranch?, worktreeStatus?, worktreePath? }
 *
 * BETA: per-chat git worktrees. Called by the agent-runtime pod to mirror a
 * chat's worktree lifecycle (active / merging / merged) into the product DB so
 * the UI can render the branch chip and merge state across reloads. Auth is
 * validated against the chat session's owning project.
 *
 * Auth: K8s SA token (cluster) OR `x-runtime-token` (local desktop).
 */
app.post('/chat-sessions/:chatSessionId/worktree', async (c) => {
  const chatSessionId = c.req.param('chatSessionId')
  if (!chatSessionId) return c.json({ error: 'Missing chatSessionId' }, 400)

  const { prisma } = await import('../lib/prisma')
  const session = await prisma.chatSession.findUnique({
    where: { id: chatSessionId },
    select: { id: true, contextId: true, contextType: true },
  })
  if (!session) return c.json({ error: 'Chat session not found' }, 404)

  // Project-scoped chats carry the project id on contextId; validate against it.
  const projectId = session.contextType === 'project' ? session.contextId ?? undefined : undefined
  if (!(await validateAuth(c, projectId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const data: Record<string, string | null> = {}
  if ('worktreeBranch' in body) data.worktreeBranch = typeof body.worktreeBranch === 'string' ? body.worktreeBranch : null
  if ('worktreePath' in body) data.worktreePath = typeof body.worktreePath === 'string' ? body.worktreePath : null
  if ('worktreeStatus' in body) {
    const s = body.worktreeStatus
    data.worktreeStatus = (s === 'active' || s === 'merging' || s === 'merged') ? s : null
  }

  try {
    await prisma.chatSession.update({ where: { id: chatSessionId }, data: data as any })
    return c.json({ ok: true })
  } catch (err: any) {
    console.error(`[Internal] Failed to update worktree status for ${chatSessionId}:`, err.message)
    return c.json({ error: 'Failed to update worktree status' }, 500)
  }
})

/**
 * POST /api/internal/billing/consume
 *
 * Single-writer wallet debit. Called by a sibling region's `consumeUsage` when
 * the serving region is NOT the workspace's `homeRegion`: the debit is routed
 * here so the wallet has exactly one writer (this region owns the row) and the
 * resulting `usage_events` replicate the ledger back to every region.
 *
 * Authenticated by the shared `SHOGO_INTERNAL_SECRET` (works cross-cluster,
 * unlike a K8s ServiceAccount token). Body is `ConsumeUsageParams`; the reply
 * is the `ConsumeUsageResult`.
 */
app.post('/billing/consume', async (c) => {
  const expected = process.env.SHOGO_INTERNAL_SECRET
  const provided = c.req.header('x-shogo-internal-secret') || ''
  if (!expected || provided !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (
    !body ||
    typeof body.workspaceId !== 'string' ||
    typeof body.memberId !== 'string' ||
    typeof body.actionType !== 'string' ||
    typeof body.billedUsd !== 'number'
  ) {
    return c.json({ error: 'Invalid consume params' }, 400)
  }

  const { consumeUsageLocal } = await import('../services/billing.service')
  try {
    const result = await consumeUsageLocal(body as any)
    return c.json(result)
  } catch (err: any) {
    console.error('[Internal] billing/consume failed:', err?.message ?? err)
    return c.json({ error: 'consume failed' }, 500)
  }
})

/**
 * POST /api/internal/billing/provision
 *
 * Single-writer wallet provisioning. Called by a sibling region's provisioning
 * path (Stripe webhook, admin, grant redeem) when the serving region is NOT the
 * workspace's `homeRegion`: the wallet write is routed here so subscription
 * setup lands in the region the app reads. Dispatches to the local `*Local`
 * provisioning functions. Authenticated by the shared `SHOGO_INTERNAL_SECRET`.
 */
app.post('/billing/provision', async (c) => {
  const expected = process.env.SHOGO_INTERNAL_SECRET
  const provided = c.req.header('x-shogo-internal-secret') || ''
  if (!expected || provided !== expected) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, any> | null
  if (!body || typeof body.workspaceId !== 'string' || typeof body.op !== 'string') {
    return c.json({ error: 'Invalid provision params' }, 400)
  }

  const svc = await import('../services/billing.service')
  try {
    let wallet: unknown
    switch (body.op) {
      case 'allocateFreeWallet':
        wallet = await svc.allocateFreeWalletLocal(body.workspaceId)
        break
      case 'allocateMonthlyIncluded':
        if (typeof body.planId !== 'string') return c.json({ error: 'planId required' }, 400)
        wallet = await svc.allocateMonthlyIncludedLocal(
          body.workspaceId,
          body.planId,
          typeof body.seats === 'number' ? body.seats : 1,
        )
        break
      case 'applyGrantMonthlyAllocation':
        wallet = await svc.applyGrantMonthlyAllocationLocal(body.workspaceId)
        break
      case 'setUsageBasedPricing':
        if (typeof body.overageEnabled !== 'boolean') {
          return c.json({ error: 'overageEnabled required' }, 400)
        }
        wallet = await svc.setUsageBasedPricingLocal(body.workspaceId, {
          overageEnabled: body.overageEnabled,
          overageHardLimitUsd: body.overageHardLimitUsd ?? null,
        })
        break
      default:
        return c.json({ error: `Unknown provision op: ${body.op}` }, 400)
    }
    return c.json(wallet)
  } catch (err: any) {
    console.error('[Internal] billing/provision failed:', err?.message ?? err)
    return c.json({ error: 'provision failed' }, 500)
  }
})

// ---------------------------------------------------------------------------
// Project lifecycle — create / attach / configure / call
//
// Backs the agent runtime's `project_*` and `system_apply` tools
// (packages/agent-runtime/src/project-tools.ts). A runtime token is a
// project- or workspace-scoped capability, so every route below resolves the
// caller's workspace from its identity and refuses to touch projects outside
// it. Cluster SA callers are unrestricted but must name the acting user.
// ---------------------------------------------------------------------------

/** Workspace the authenticated identity is allowed to act in (null for SA). */
async function identityWorkspaceId(identity: InternalIdentity): Promise<string | null> {
  if (identity.kind === 'workspace') return identity.workspaceId
  if (identity.kind === 'project') {
    const { resolveProjectWorkspaceId } = await import('../lib/project-runtime-token')
    return (await resolveProjectWorkspaceId(identity.projectId)) ?? null
  }
  return null
}

/**
 * Authorize a project-scoped lifecycle call: SA passes; a runtime token must
 * belong to the same workspace as `projectId`. Returns the project's
 * workspace id so the handler can reuse it.
 */
async function authorizeLifecycleProject(
  c: Context,
  projectId: string,
): Promise<{ identity: InternalIdentity; workspaceId: string } | null> {
  const identity = await authenticate(c)
  if (!identity) return null
  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  })) as { workspaceId: string } | null
  if (!project) return null
  if (identity.kind === 'sa') return { identity, workspaceId: project.workspaceId }
  const scope = await identityWorkspaceId(identity)
  if (scope !== project.workspaceId) {
    logAuthReject(`lifecycle_workspace_mismatch tokenWorkspace=${scope ?? 'none'}`, projectId)
    return null
  }
  return { identity, workspaceId: project.workspaceId }
}

/**
 * Resolve the user a lifecycle write is attributed to. Prefer the explicit
 * `userId` the runtime forwards from the chat request; fall back to the
 * calling project's creator for heartbeat-triggered turns that have no user.
 *
 * A merged-root (universal workspace) runtime authenticates with a workspace
 * token, so there is no calling project to inherit from — attribute the write
 * to the workspace's owner instead. Without this every `system_apply` /
 * `project_create` from such a runtime 400s with `userId is required`, which
 * breaks the `harness` anchor and any other multi-project assembly.
 */
async function resolveActingUserId(identity: InternalIdentity, requested: unknown): Promise<string | null> {
  if (typeof requested === 'string' && requested.length > 0) return requested
  if (identity.kind === 'project') {
    const row = (await prisma.project.findUnique({
      where: { id: identity.projectId },
      select: { createdBy: true },
    })) as { createdBy: string | null } | null
    return row?.createdBy ?? null
  }
  if (identity.kind === 'workspace') {
    const owner = await prisma.member.findFirst({
      where: { workspaceId: identity.workspaceId, role: 'owner' },
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    })
    return owner?.userId ?? null
  }
  return null
}

function lifecycleErrorResponse(c: Context, err: unknown): Response {
  const anyErr = err as { name?: string; code?: string; message?: string }
  if (anyErr?.name === 'ProjectLifecycleError') {
    const status =
      anyErr.code === 'unauthorized' ? 401
      : anyErr.code === 'forbidden' ? 403
      : anyErr.code === 'not_found' ? 404
      : anyErr.code === 'instance_too_small' ? 402
      : anyErr.code === 'paywall' ? 402
      : 400
    return c.json({ error: { code: anyErr.code, message: anyErr.message } }, status)
  }
  if (anyErr?.name === 'ProjectAttachmentError') {
    const status =
      anyErr.code === 'project_not_found' ? 404 : anyErr.code === 'self_attach' ? 400 : 409
    return c.json({ error: { code: anyErr.code, message: anyErr.message } }, status)
  }
  console.error('[Internal] project lifecycle error:', anyErr?.message ?? err)
  return c.json({ error: { code: 'internal_error', message: 'Project lifecycle operation failed' } }, 500)
}

/**
 * GET /api/internal/workspaces/:workspaceId/projects/graph
 *
 * Every project in the workspace with its attachment edges and agent config —
 * the live state `system_apply` diffs a manifest against.
 */
app.get('/workspaces/:workspaceId/projects/graph', async (c) => {
  const workspaceId = c.req.param('workspaceId')
  if (!(await authorizeWorkspaceScope(c, workspaceId))) return c.json({ error: 'Unauthorized' }, 401)
  const { listWorkspaceProjectsWithAttachments } = await import('../services/project-lifecycle.service')
  return c.json({ workspaceId, projects: await listWorkspaceProjectsWithAttachments(workspaceId) })
})

/**
 * POST /api/internal/workspaces/:workspaceId/projects
 *   body: { name, description?, techStackId?, workingMode?, templateId?, settings?, hidden?, userId? }
 *
 * Create a project on behalf of a user. Goes through the same hooks as the
 * public generated route, so membership, tier normalization and AgentConfig
 * seeding are identical.
 */
app.post('/workspaces/:workspaceId/projects', async (c) => {
  const workspaceId = c.req.param('workspaceId')
  const identity = await authenticate(c)
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  if (identity.kind !== 'sa') {
    const scope = await identityWorkspaceId(identity)
    if (scope !== workspaceId) {
      logAuthReject(`lifecycle_workspace_mismatch tokenWorkspace=${scope ?? 'none'} path=${workspaceId}`)
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.name !== 'string') {
    return c.json({ error: { code: 'bad_request', message: 'name is required' } }, 400)
  }
  const actingUserId = await resolveActingUserId(identity, body.userId)
  if (!actingUserId) {
    return c.json({ error: { code: 'bad_request', message: 'userId is required' } }, 400)
  }

  try {
    const { createProjectInWorkspace } = await import('../services/project-lifecycle.service')
    const project = await createProjectInWorkspace({
      workspaceId,
      actingUserId,
      name: body.name,
      description: typeof body.description === 'string' ? body.description : undefined,
      techStackId: typeof body.techStackId === 'string' ? body.techStackId : undefined,
      workingMode: body.workingMode === 'external' ? 'external' : body.workingMode === 'managed' ? 'managed' : undefined,
      templateId: typeof body.templateId === 'string' ? body.templateId : undefined,
      hidden: body.hidden === true,
      settings: body.settings && typeof body.settings === 'object' ? (body.settings as Record<string, unknown>) : undefined,
    })
    return c.json({ ok: true, project }, 201)
  } catch (err) {
    return lifecycleErrorResponse(c, err)
  }
})

/** GET /api/internal/projects/:projectId/attachments — durable anchor → attached edges. */
app.get('/projects/:projectId/attachments', async (c) => {
  const projectId = c.req.param('projectId')
  if (!(await authorizeLifecycleProject(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
  const { listAttachments } = await import('../services/project-attachment.service')
  return c.json({ projectId, attachments: await listAttachments(projectId) })
})

/**
 * POST /api/internal/projects/:projectId/attachments
 *   body: { attachedProjectId, attachMode?: 'readwrite' | 'readonly' }
 *
 * Record a durable `ProjectAttachment` and re-sync the anchor's pinned
 * workspace session. Unlike the public route this never restarts the anchor
 * runtime — the caller usually IS the anchor runtime. It attempts a live
 * mount through the workspace-runtime member path and reports `mounted`;
 * when that isn't possible the attachment takes effect on the next start.
 */
app.post('/projects/:projectId/attachments', async (c) => {
  const projectId = c.req.param('projectId')
  const authz = await authorizeLifecycleProject(c, projectId)
  if (!authz) return c.json({ error: 'Unauthorized' }, 401)

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.attachedProjectId !== 'string') {
    return c.json({ error: { code: 'bad_request', message: 'attachedProjectId is required' } }, 400)
  }
  const attachMode = body.attachMode === 'readonly' ? 'readonly' : 'readwrite'

  try {
    const svc = await import('../services/project-attachment.service')
    const attachment = await svc.attachProjectToProject(projectId, body.attachedProjectId, attachMode)

    let mounted = false
    try {
      const pinned = await svc.getOrCreatePinnedWorkspaceSession(projectId)
      const attached = await getAttachedProjects(pinned.id)
      const attachedIds = attached.map((row) => row.projectId)
      const readonlyIds = attached.filter((row) => row.attachMode === 'readonly').map((row) => row.projectId)
      const target = (await prisma.project.findUnique({
        where: { id: body.attachedProjectId },
        select: { id: true, name: true, description: true },
      })) as { id: string; name: string; description: string | null } | null
      if (target) {
        await workspaceRuntimeMemberCall(
          authz.workspaceId,
          attachedIds,
          '/internal/workspace/members',
          {
            method: 'POST',
            body: JSON.stringify({
              id: target.id,
              name: target.name,
              description: target.description ?? undefined,
              readonly: attachMode === 'readonly',
            }),
          },
          {
            readonlyProjectIds: readonlyIds,
            hostRealPath: resolvePath(process.env.WORKSPACES_DIR || resolvePath(process.cwd(), 'workspaces'), target.id),
          },
        )
        mounted = true
      }
    } catch (mountErr: any) {
      console.warn(`[Internal] live mount of ${body.attachedProjectId} into ${projectId} skipped: ${mountErr?.message ?? mountErr}`)
    }

    return c.json({ ok: true, attachment, mounted }, 201)
  } catch (err) {
    return lifecycleErrorResponse(c, err)
  }
})

/** DELETE /api/internal/projects/:projectId/attachments/:attachedProjectId */
app.delete('/projects/:projectId/attachments/:attachedProjectId', async (c) => {
  const projectId = c.req.param('projectId')
  const attachedProjectId = c.req.param('attachedProjectId')
  if (!(await authorizeLifecycleProject(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const { detachProjectFromProject } = await import('../services/project-attachment.service')
    const removed = await detachProjectFromProject(projectId, attachedProjectId)
    return c.json({ ok: true, removed })
  } catch (err) {
    return lifecycleErrorResponse(c, err)
  }
})

/** GET /api/internal/projects/:projectId/config — agent-facing config snapshot. */
app.get('/projects/:projectId/config', async (c) => {
  const projectId = c.req.param('projectId')
  if (!(await authorizeLifecycleProject(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const { readProjectConfig } = await import('../services/project-lifecycle.service')
    return c.json({ ok: true, project: await readProjectConfig(projectId) })
  } catch (err) {
    return lifecycleErrorResponse(c, err)
  }
})

/**
 * PATCH /api/internal/projects/:projectId/config
 *   body: { name?, description?, settings?, slackEnabled?, agent?: { heartbeat*, model*, quietHours* } }
 */
app.patch('/projects/:projectId/config', async (c) => {
  const projectId = c.req.param('projectId')
  if (!(await authorizeLifecycleProject(c, projectId))) return c.json({ error: 'Unauthorized' }, 401)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return c.json({ error: { code: 'bad_request', message: 'Invalid JSON body' } }, 400)
  try {
    const { configureProject } = await import('../services/project-lifecycle.service')
    const project = await configureProject(projectId, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' || body.description === null ? (body.description as string | null) : undefined,
      settings: body.settings && typeof body.settings === 'object' ? (body.settings as Record<string, unknown>) : undefined,
      slackEnabled: typeof body.slackEnabled === 'boolean' ? body.slackEnabled : undefined,
      agent: body.agent && typeof body.agent === 'object' ? (body.agent as any) : undefined,
    })
    return c.json({ ok: true, project })
  } catch (err) {
    return lifecycleErrorResponse(c, err)
  }
})

/**
 * POST /api/internal/projects/:projectId/agent-call
 *   body: { message, runId?, sessionId?, wait?, timeoutMs?, callerProjectId? }
 *
 * Invoke another project's agent from a runtime. Resolves the target the same
 * way the public agent-proxy does (pinned Instance tunnel first, then cloud
 * pod / host runtime) and forwards to the runtime's `/agent/pipeline/call`,
 * which is guarded by the runtime token alone — workspace runtimes are never
 * given a `WEBHOOK_TOKEN`, so the external `/agent/hooks/*` path can't be
 * reused here. `wait=true` blocks for the reply (bounded by `timeoutMs`,
 * default 5 min, max 20 min); otherwise the runtime acks with 202.
 */
app.post('/projects/:projectId/agent-call', async (c) => {
  const projectId = c.req.param('projectId')
  const authz = await authorizeLifecycleProject(c, projectId)
  if (!authz) return c.json({ error: 'Unauthorized' }, 401)

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return c.json({ error: { code: 'bad_request', message: 'message is required' } }, 400)
  }
  const callerProjectId =
    typeof body.callerProjectId === 'string'
      ? body.callerProjectId
      : authz.identity.kind === 'project' ? authz.identity.projectId : undefined

  const { callProjectAgent } = await import('../services/agent-call.service')
  const outcome = await callProjectAgent(c, projectId, authz.workspaceId, {
    message: body.message,
    runId: typeof body.runId === 'string' ? body.runId : undefined,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    wait: body.wait !== false,
    timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    callerProjectId,
  })
  return c.json(outcome.body, outcome.status as any)
})

export default app
