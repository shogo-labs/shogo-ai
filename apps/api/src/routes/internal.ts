/**
 * Internal API Routes
 *
 * Endpoints for cluster-internal communication between the API and runtime pods.
 * These are NOT exposed via external ingress — only reachable within the K8s cluster.
 */

import { Hono } from 'hono'
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

export default app
