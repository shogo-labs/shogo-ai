// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared Runtime Server Framework
 *
 * Provides createRuntimeApp() — a factory that builds a Hono server with all
 * the boilerplate shared between agent-runtime and project-runtime:
 *
 *   - OpenTelemetry instrumentation
 *   - Structured logger + startup timing
 *   - CORS middleware
 *   - Runtime auth middleware (RUNTIME_AUTH_SECRET)
 *   - /health, /ready, /pool/activity, /pool/assign endpoints
 *   - Warm pool mode detection + self-assign
 *   - AI proxy configuration + reconfiguration on assign
 *   - External-request activity tracking for idle detection
 *
 * Each runtime calls createRuntimeApp() and then registers its own
 * feature-specific routes on the returned Hono app.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initInstrumentation, traceOperation } from './instrumentation'
import { createLogger } from './logger'
import { configureAIProxy } from './ai-proxy'
import { checkSelfAssign } from './self-assign'

export interface RuntimeAppConfig {
  /** Display name used in logs (e.g. 'agent-runtime', 'project-runtime') */
  name: string
  /** Workspace directory (WORKSPACE_DIR) */
  workDir: string
  /** Runtime type identifier */
  runtimeType: string
  /** Paths excluded from external activity tracking (health probes, etc.) */
  internalPaths?: string[]
  /** Auth-protected path prefixes (e.g. ['/agent', '/pool']) */
  authPrefixes?: string[]
  /**
   * Called when a warm pool pod is assigned to a project.
   * The framework handles env injection, project identity update, and AI proxy
   * reconfiguration. This callback runs the runtime-specific init (e.g. S3 sync,
   * gateway start, workspace seeding).
   */
  onAssign: (projectId: string, env: Record<string, string>) => Promise<void>
  /**
   * Returns activity stats for the /pool/activity endpoint.
   * If not provided, only HTTP request tracking is used.
   */
  getActivityStats?: () => { activeSessions: number; lastActivityAt: number | null }
  /**
   * Extra data to include in the /health response.
   */
  getHealthExtra?: () => Record<string, unknown>
}

export interface RuntimeState {
  /** Current project ID (changes on pool assignment) */
  currentProjectId: string | undefined
  /** Whether this pod is in warm pool mode */
  isPoolMode: boolean
  /** Whether a pool assignment has completed */
  poolAssigned: boolean
  /** Timestamp of pool assignment completion */
  poolAssignedAt: number | null
  /** Timestamp of last external HTTP request */
  lastRequestAt: number
  /** AI proxy configuration (reconfigured on assign) */
  aiProxy: ReturnType<typeof configureAIProxy>
  /** Server start time */
  serverStartTime: number
  /** Entrypoint start time (from STARTUP_TIME env) */
  entrypointStartTime: number
}

export interface RuntimeApp {
  app: Hono
  state: RuntimeState
  logTiming: (message: string) => void
}

const POOL_PROJECT_ID = '__POOL__'

export async function createRuntimeApp(config: RuntimeAppConfig): Promise<RuntimeApp> {
  // ---------------------------------------------------------------------------
  // OpenTelemetry
  // ---------------------------------------------------------------------------
  initInstrumentation({ serviceName: `shogo-${config.name}` })

  const log = createLogger(config.name, {
    projectId: process.env.PROJECT_ID,
    poolMode: process.env.WARM_POOL_MODE === 'true' || process.env.PROJECT_ID === POOL_PROJECT_ID,
  })

  // ---------------------------------------------------------------------------
  // Timing
  // ---------------------------------------------------------------------------
  const SERVER_START_TIME = Date.now()
  const ENTRYPOINT_START_TIME = process.env.STARTUP_TIME
    ? parseInt(process.env.STARTUP_TIME, 10)
    : SERVER_START_TIME

  function logTiming(message: string): void {
    const now = Date.now()
    const fromEntrypoint = ENTRYPOINT_START_TIME ? now - ENTRYPOINT_START_TIME : 0
    const fromServer = now - SERVER_START_TIME
    console.log(
      `[${config.name}] [+${fromEntrypoint}ms total, +${fromServer}ms server] ${message}`
    )
  }

  logTiming('Server module loading...')

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  let currentProjectId = process.env.PROJECT_ID
  const IS_POOL_MODE = currentProjectId === POOL_PROJECT_ID || process.env.WARM_POOL_MODE === 'true'
  let poolAssigned = false
  let poolAssignedAt: number | null = null
  let lastRequestAt: number = Date.now()

  const internalPaths = new Set([
    '/health', '/ready', '/pool/activity', '/pool/assign',
    ...(config.internalPaths ?? []),
  ])

  if (!currentProjectId) {
    console.error(`[${config.name}] ERROR: PROJECT_ID environment variable is required`)
    process.exit(1)
  }

  // ---------------------------------------------------------------------------
  // Warm Pool Self-Assign
  // ---------------------------------------------------------------------------
  if (IS_POOL_MODE) {
    logTiming('Starting in WARM POOL mode (awaiting project assignment)')

    const selfAssignConfig = await checkSelfAssign()
    if (selfAssignConfig) {
      logTiming(`[self-assign] Applying config for project ${selfAssignConfig.projectId}`)
      currentProjectId = selfAssignConfig.projectId
      process.env.PROJECT_ID = selfAssignConfig.projectId
      for (const [key, value] of Object.entries(selfAssignConfig.env)) {
        if (typeof value === 'string') process.env[key] = value
      }
      poolAssigned = true
      poolAssignedAt = Date.now()
      logTiming(`[self-assign] Self-assigned to ${selfAssignConfig.projectId}`)
    }
  } else {
    logTiming(`Configuration loaded for ${config.runtimeType}: ${currentProjectId}`)
  }

  console.log(`[${config.name}] Work directory: ${config.workDir}`)

  // ---------------------------------------------------------------------------
  // AI Proxy
  // ---------------------------------------------------------------------------
  let aiProxy: ReturnType<typeof configureAIProxy>
  if (IS_POOL_MODE && !poolAssigned) {
    aiProxy = { useProxy: false, env: {} }
    logTiming('Pool mode: deferring AI proxy configuration until assignment')
  } else {
    try {
      aiProxy = configureAIProxy({ logPrefix: config.name })
    } catch (err: any) {
      console.error(`[${config.name}] FATAL: ${err.message}`)
      process.exit(1)
    }
  }
  if (aiProxy.useProxy) {
    Object.assign(process.env, aiProxy.env)
  }

  // ---------------------------------------------------------------------------
  // Mutable state object shared with the caller
  // ---------------------------------------------------------------------------
  const state: RuntimeState = {
    currentProjectId,
    isPoolMode: IS_POOL_MODE,
    poolAssigned,
    poolAssignedAt,
    lastRequestAt,
    aiProxy,
    serverStartTime: SERVER_START_TIME,
    entrypointStartTime: ENTRYPOINT_START_TIME,
  }

  // ---------------------------------------------------------------------------
  // Graceful Shutdown — drain in-flight requests before exiting
  // ---------------------------------------------------------------------------
  let shuttingDown = false

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`[${config.name}] ${signal} received — draining for 5s before exit`)
      setTimeout(() => process.exit(0), 5_000)
    })
  }

  process.on('uncaughtException', (err) => {
    console.error(`[${config.name}] Uncaught exception, draining:`, err)
    if (shuttingDown) return
    shuttingDown = true
    setTimeout(() => process.exit(1), 5_000)
  })

  // ---------------------------------------------------------------------------
  // Hono App
  // ---------------------------------------------------------------------------
  const app = new Hono()

  app.use('*', cors({
    origin: (origin) => {
      const allowed = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || []
      if (!origin) return '*'
      if (allowed.length > 0 && allowed.includes(origin)) return origin
      if (origin.startsWith('http://localhost:') || origin.startsWith('https://localhost:')) return origin
      if (origin.startsWith('http://127.0.0.1:') || origin.startsWith('https://127.0.0.1:')) return origin
      return allowed[0] || origin
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Runtime-Token', 'X-Session-Id', 'X-User-Id', 'X-Billing-User-Id'],
    credentials: true,
  }))

  // Track last external HTTP request for idle detection
  app.use('*', async (c, next) => {
    if (!internalPaths.has(c.req.path)) {
      state.lastRequestAt = Date.now()
    }
    await next()
  })

  // ---------------------------------------------------------------------------
  // Auth Middleware
  // ---------------------------------------------------------------------------
  function checkRuntimeAuth(c: any): Response | null {
    const runtimeSecret = process.env.RUNTIME_AUTH_SECRET
    if (!runtimeSecret) {
      if (process.env.NODE_ENV !== 'production') return null
      console.error(`[${config.name}] RUNTIME_AUTH_SECRET not set — rejecting request`)
      return c.json({ error: 'Unauthorized — RUNTIME_AUTH_SECRET not configured' }, 401)
    }
    const auth = c.req.header('authorization') || ''
    const token = c.req.header('x-runtime-token') || ''
    if (auth === `Bearer ${runtimeSecret}` || token === runtimeSecret) return null
    return c.json({ error: 'Unauthorized — missing or invalid runtime token' }, 401)
  }

  const publicPaths = new Set([
    '/agent/channels/webchat/widget.js',
    '/agent/channels/webchat/config',
    '/agent/channels/webchat/health',
    '/agent/channels/webchat/session',
    '/agent/channels/webchat/message',
    '/agent/channels/webhook/incoming',
    '/agent/channels/webhook/health',
  ])

  function isPublicChannelPath(path: string): boolean {
    if (publicPaths.has(path)) return true
    if (path.startsWith('/agent/channels/webchat/events/')) return true
    if (path.startsWith('/agent/channels/whatsapp/')) return true
    if (path.startsWith('/agent/channels/teams/')) return true
    return false
  }

  const authPrefixes = config.authPrefixes ?? [`/${config.runtimeType === 'project' ? 'preview' : 'agent'}`, '/pool']
  for (const prefix of authPrefixes) {
    if (prefix === '/pool') {
      app.use(`${prefix}/*`, async (c, next) => {
        if (IS_POOL_MODE && !state.poolAssigned) {
          await next()
          return
        }
        const denied = checkRuntimeAuth(c)
        if (denied) return denied
        await next()
      })
    } else {
      app.use(`${prefix}/*`, async (c, next) => {
        if (isPublicChannelPath(c.req.path)) {
          await next()
          return
        }
        const denied = checkRuntimeAuth(c)
        if (denied) return denied
        await next()
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Health / Ready / Activity
  // ---------------------------------------------------------------------------
  app.get('/health', (c) => {
    const extra = config.getHealthExtra?.() ?? {}
    return c.json({
      status: 'ok',
      projectId: state.currentProjectId,
      runtimeType: config.runtimeType,
      poolMode: IS_POOL_MODE && !state.poolAssigned,
      uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
      ...extra,
    })
  })

  // /ready is NOT registered here — each runtime provides its own readiness check
  // (e.g. project-runtime checks build status, agent-runtime checks gateway)

  app.get('/pool/activity', (c) => {
    const activityStats = config.getActivityStats?.() ?? { activeSessions: 0, lastActivityAt: null }
    const now = Date.now()
    const lastSessionActivity = activityStats.lastActivityAt ?? (state.poolAssignedAt ?? SERVER_START_TIME)
    const lastActivity = Math.max(state.lastRequestAt, lastSessionActivity)
    return c.json({
      projectId: state.currentProjectId,
      lastActivityAt: lastActivity,
      idleSeconds: Math.floor((now - lastActivity) / 1000),
      activeSessions: activityStats.activeSessions,
      lastRequestAt: state.lastRequestAt,
      lastSessionActivityAt: lastSessionActivity,
      poolAssigned: state.poolAssigned,
    })
  })

  // ---------------------------------------------------------------------------
  // Pool Assignment
  // ---------------------------------------------------------------------------
  app.post('/pool/assign', async (c) => {
    if (!IS_POOL_MODE) {
      return c.json({ error: 'Not in pool mode' }, 400)
    }
    if (state.poolAssigned) {
      return c.json({ error: 'Already assigned', projectId: state.currentProjectId }, 400)
    }

    // Acquire the assignment lock synchronously BEFORE any await to prevent
    // TOCTOU races: two concurrent /pool/assign requests from different API
    // pods could both pass the check above if an await yields the event loop
    // between the check and the state mutation.
    state.poolAssigned = true

    const startTime = Date.now()
    let body: any
    try {
      body = await c.req.json()
    } catch (parseErr: any) {
      state.poolAssigned = false
      return c.json({ error: 'Invalid request body' }, 400)
    }
    const { projectId, env: envVars } = body

    if (!projectId || typeof projectId !== 'string') {
      state.poolAssigned = false
      return c.json({ error: 'projectId (string) is required' }, 400)
    }

    logTiming(`Pool assignment starting for project ${projectId}`)

    // 1. Update project identity
    state.currentProjectId = projectId
    currentProjectId = projectId
    process.env.PROJECT_ID = projectId

    // 2. Inject environment variables from the controller
    if (envVars && typeof envVars === 'object') {
      for (const [key, value] of Object.entries(envVars)) {
        if (typeof value === 'string') {
          process.env[key] = value
        }
      }
    }

    // 3. Reconfigure AI proxy with new env (picks up AI_PROXY_TOKEN)
    try {
      state.aiProxy = configureAIProxy({ logPrefix: config.name })
    } catch (err: any) {
      console.error(`[${config.name}] FATAL during reconfigure: ${err.message}`)
      process.exit(1)
    }
    if (state.aiProxy.useProxy) {
      Object.assign(process.env, state.aiProxy.env)
    }

    // 4. Run runtime-specific initialization
    try {
      await config.onAssign(projectId, (envVars ?? {}) as Record<string, string>)
      state.poolAssignedAt = Date.now()
      poolAssigned = true
      poolAssignedAt = state.poolAssignedAt
      const duration = Date.now() - startTime
      logTiming(`Pool assignment complete for ${projectId} (${duration}ms)`)
      return c.json({ ok: true, projectId, durationMs: duration })
    } catch (error: any) {
      state.poolAssigned = false
      state.currentProjectId = undefined
      currentProjectId = '__POOL__'
      process.env.PROJECT_ID = '__POOL__'
      console.error(`[${config.name}] Pool assignment failed for ${projectId}:`, error.message)
      return c.json({ error: `Assignment failed: ${error.message}` }, 500)
    }
  })

  logTiming('Shared framework initialized')

  return { app, state, logTiming }
}
