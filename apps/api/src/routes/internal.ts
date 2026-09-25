// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Internal API Routes
 *
 * Endpoints for cluster-internal communication between the API and runtime pods.
 * These are NOT exposed via external ingress — only reachable within the K8s cluster.
 */

import { Hono } from 'hono'
import { validatePodToken } from '../lib/k8s-auth'
import { getMetalWarmPoolController } from '../lib/metal-warm-pool-controller'
import { saveAgentAvatar } from '../services/workspace-agent-cloud-storage'
import { authenticate, authorizeWorkspaceScope, validateAuth } from './internal-auth'
import { numberOr, runtimeInternalRoutes } from './internal-runtime-routes'

const app = new Hono()

// Everything an agent-runtime calls back into (trust, checkpoints, plans,
// workspace agent/members, project lifecycle, ...). Shared with the desktop
// composer; the cluster-only capabilities are wired in here.
app.route(
  '/',
  runtimeInternalRoutes({
    authenticate,
    saveAgentAvatar,
    metalWorkspaceMember: (workspaceId, op, projectId, realPath) =>
      getMetalWarmPoolController().workspaceMember(workspaceId, op, projectId, realPath),
    loadProjectLifecycle: () => import('../services/project-lifecycle.service'),
    loadAgentCall: () => import('../services/agent-call.service'),
  }),
)

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

export default app
