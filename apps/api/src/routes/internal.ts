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
 * Authenticated like the rest of /internal: K8s SA bearer in cluster, or
 * runtime-token in local mode.
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
 * POST /api/internal/refresh-ai-proxy-token/:projectId
 *   → 200 { token: string, exp: number }   exp = unix seconds
 *
 * Called by long-lived runtime pods to rotate their AI_PROXY_TOKEN in place
 * before the JWT exp elapses.
 *
 * Why this exists
 * ---------------
 * AI_PROXY_TOKEN is a short-lived HS256 JWT (see ai-proxy-token.ts) that's
 * minted exactly once per pod, at revision-creation time, and injected as
 * a Knative env var. Knative revision env is immutable; project pods run
 * with min-scale=1 to avoid cold starts; therefore a pod kept warm by
 * heartbeat or Slack traffic outlives the credential it was issued with.
 * Around exp the proxy starts 401-ing every LLM call and the agent
 * silently no-ops while heartbeat metrics remain green.
 *
 * The fix is to give the pod a refresh path it can drive itself, using
 * the long-lived identity it already has (K8s SA token in cluster,
 * RUNTIME_AUTH_SECRET in local mode). Same shape as kubelet rotating a
 * projected SA token before expiry — the runtime-side refresher mutates
 * process.env.AI_PROXY_TOKEN in place, so every existing consumer that
 * reads from process.env naturally picks up the fresh value.
 *
 * Auth: K8s SA bearer (cluster) OR x-runtime-token (local mode), via the
 * same validateAuth() helper used by the other /internal routes. The
 * caller MUST be authenticated for the project being refreshed — a pod
 * can only refresh its own token, not someone else's.
 */
app.post('/refresh-ai-proxy-token/:projectId', async (c) => {
  const projectId = c.req.param('projectId')

  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400)
  }

  if (!checkRateLimit(`refresh-proxy:${projectId}`)) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }

  if (!(await validateAuth(c, projectId))) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    const { prisma } = await import('../lib/prisma')
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true },
    })
    if (!project) {
      return c.json({ error: 'Project not found' }, 404)
    }

    const { getProjectOwnerUserId } = await import('../lib/project-user-context')
    const ownerUserId = await getProjectOwnerUserId(projectId)

    // Match the TTL used at provisioning time (build-project-env.ts /
    // knative-project-manager.ts). The refresher schedules itself well
    // inside this window, so the effective rotation cadence is what
    // controls security, not this number. Lowering this default back to
    // the original 24h is a follow-up once the refresher has been observed
    // in staging.
    const expiryMs = 7 * 24 * 60 * 60 * 1000
    const { generateProxyToken } = await import('../lib/ai-proxy-token')
    const token = await generateProxyToken(
      project.id,
      project.workspaceId ?? 'local-dev',
      ownerUserId,
      expiryMs,
    )

    const exp = Math.floor((Date.now() + expiryMs) / 1000)
    console.log(`[Internal] Refreshed AI_PROXY_TOKEN for ${projectId} (exp=${exp})`)
    return c.json({ token, exp })
  } catch (err: any) {
    console.error(`[Internal] refresh-ai-proxy-token failed for ${projectId}:`, err?.message ?? err)
    return c.json({ error: 'Refresh failed' }, 500)
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
