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
import { validatePodToken } from '../lib/k8s-auth'

const app = new Hono()

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
 * Validate request auth: tries K8s SA token first, then falls back to
 * runtime-token verification in local mode.
 */
async function validateAuth(c: Context, projectId?: string): Promise<boolean> {
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const identity = await validatePodToken(authHeader.slice(7))
    if (identity) return true
  }

  if (process.env.SHOGO_LOCAL_MODE === 'true') {
    const runtimeToken = c.req.header('x-runtime-token')
    if (runtimeToken) {
      const { verifyRuntimeToken } = await import('../lib/runtime-token')
      const verified = verifyRuntimeToken(runtimeToken, projectId)
      return verified.ok && (!projectId || verified.projectId === projectId)
    }
  }

  return false
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
 * GET /api/internal/subagent-overrides/resolve
 *   ?workspaceId=...&projectId=...&agentType=...
 *
 * Called by agent-runtime spawning a sub-agent to learn whether the user has
 * overridden the built-in default model for this agent type. Authenticated
 * via K8s SA token (cluster) or runtime token (local mode).
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

  if (!(await validateAuth(c, projectId))) {
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
  if (!(await validateAuth(c, projectId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null
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
    })
    return c.json({ ok: true })
  } catch (err: any) {
    console.error('[Internal] Failed to record agent cost metric:', err.message)
    return c.json({ error: 'Failed to record metric' }, 500)
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
 * to every workspace as the default anchor.
 */
app.post('/agent-eval-results', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!(await validateAuth(c))) {
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
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : null,
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

export default app
