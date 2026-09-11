// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A2A (Agent2Agent) protocol routes — the shogo equivalent of Odin's
 * `routes/a2a.py`.
 *
 * Two route groups, mounted separately (see `apps/api/src/server.ts`):
 *
 *   - `a2aProtocolRoutes()` → mounted at `/a2a` (deliberately OUTSIDE
 *     `/api/*`, so the global `authMiddleware` doesn't apply — this
 *     router self-authenticates with `shogo_a2a_*` bearer keys, same
 *     posture as Odin's `require_a2a_key`):
 *       - `GET  /a2a/projects/:projectId/.well-known/agent-card.json`
 *       - `POST /a2a/projects/:projectId/rpc`
 *
 *   - `a2aKeyRoutes()` → mounted at `/api` (inherits session auth for
 *     free, matching Odin's key-CRUD-under-normal-JWT posture):
 *       - `POST   /api/projects/:projectId/a2a/keys`
 *       - `GET    /api/projects/:projectId/a2a/keys`
 *       - `DELETE /api/projects/:projectId/a2a/keys/:keyId`
 *
 * One `DefaultRequestHandler` (+ its `ShogoAgentExecutor` and
 * `PrismaA2ATaskStore`) is cached per `projectId` in a bounded LRU —
 * `DefaultExecutionEventBusManager` holds in-flight task event buses
 * in-process, so a fresh handler per request would break `message/stream`
 * and `tasks/resubscribe` (the resubscribing request would attach to a
 * brand-new, empty bus manager). See `A2AHandlerCache` below for the
 * eviction policy.
 */

import { Hono } from 'hono'
import { AgentCard } from '@a2a-js/sdk'
import { DefaultRequestHandler, type A2ARequestHandler } from '@a2a-js/sdk/server'
import { authorizeProject } from '../middleware/auth'
import { buildAgentCard, getA2aBaseUrl } from '../lib/a2a/card'
import { PrismaA2ATaskStore } from '../lib/a2a/task-store'
import { ShogoAgentExecutor } from '../lib/a2a/executor'
import { buildA2AServerCallContext, handleA2AJsonRpc } from '../lib/a2a/hono-transport'
import {
  listA2aApiKeys,
  mintA2aApiKey,
  revokeA2aApiKey,
  verifyA2aApiKey,
  type VerifiedA2aKey,
} from '../lib/a2a/auth'

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by the `/a2a/projects/:projectId/*` self-auth middleware. */
    a2aKey?: VerifiedA2aKey
  }
}

// -----------------------------------------------------------------------------
// Cached DefaultRequestHandler per project
// -----------------------------------------------------------------------------

interface CachedHandler {
  handler: A2ARequestHandler
  executor: ShogoAgentExecutor
  lastAccess: number
}

const MAX_CACHED_HANDLERS = parseInt(process.env.A2A_HANDLER_CACHE_MAX || '200', 10)
const HANDLER_IDLE_TTL_MS = parseInt(process.env.A2A_HANDLER_IDLE_TTL_MS || String(30 * 60 * 1000), 10)
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * Bounded LRU keyed by `projectId`. Unlike Odin's unbounded dict cache
 * (`routes/a2a.py:46`, one entry per `(agent_id, project_id)`, never
 * evicted), a per-project cache across a whole workspace fleet needs a
 * ceiling. Entries with `executor.hasActiveWork` are never evicted —
 * doing so would orphan a running turn and any live `message/stream`
 * subscriber attached to its event bus.
 */
class A2AHandlerCache {
  private readonly entries = new Map<string, CachedHandler>()

  get(projectId: string): CachedHandler | undefined {
    const entry = this.entries.get(projectId)
    if (!entry) return undefined
    entry.lastAccess = Date.now()
    // Re-insert to move to the MRU end (Map iteration order == insertion order).
    this.entries.delete(projectId)
    this.entries.set(projectId, entry)
    return entry
  }

  set(projectId: string, entry: CachedHandler): void {
    this.entries.set(projectId, entry)
    this.evictOverCapacity()
  }

  private evictOverCapacity(): void {
    if (this.entries.size <= MAX_CACHED_HANDLERS) return
    for (const [projectId, entry] of this.entries) {
      if (this.entries.size <= MAX_CACHED_HANDLERS) break
      if (entry.executor.hasActiveWork) continue
      this.entries.delete(projectId)
    }
  }

  sweepIdle(): void {
    const now = Date.now()
    for (const [projectId, entry] of this.entries) {
      if (entry.executor.hasActiveWork) continue
      if (now - entry.lastAccess > HANDLER_IDLE_TTL_MS) this.entries.delete(projectId)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

const handlerCache = new A2AHandlerCache()

const sweepTimer = setInterval(() => handlerCache.sweepIdle(), SWEEP_INTERVAL_MS)
if (sweepTimer && typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
  ;(sweepTimer as { unref: () => void }).unref()
}

class A2AProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found`)
  }
}

async function getOrCreateHandler(projectId: string, workspaceId: string): Promise<CachedHandler> {
  const cached = handlerCache.get(projectId)
  if (cached) return cached

  // The card baked into the cached `DefaultRequestHandler` is used
  // internally (protocol-version validation, `getAuthenticatedExtendedAgentCard`)
  // — it is NOT what `.well-known/agent-card.json` serves. That route
  // calls `buildAgentCard()` directly on every request so project edits
  // (name, description, tools) show up immediately, matching Odin. The
  // handler's copy going slightly stale between cache refreshes is fine:
  // the fields it actually consumes (`supportedInterfaces`, `tenant`,
  // `protocolVersion`) never change for a project's lifetime.
  const card = await buildAgentCard({ projectId })
  if (!card) throw new A2AProjectNotFoundError(projectId)

  const taskStore = new PrismaA2ATaskStore()
  const executor = new ShogoAgentExecutor({ projectId, workspaceId, taskStore })
  const handler = new DefaultRequestHandler(card, taskStore, executor)

  const entry: CachedHandler = { handler, executor, lastAccess: Date.now() }
  handlerCache.set(projectId, entry)
  return entry
}

// -----------------------------------------------------------------------------
// Protocol routes — mounted at /a2a, self-authenticating
// -----------------------------------------------------------------------------

export function a2aProtocolRoutes() {
  const router = new Hono()

  // Self-auth: every request under /a2a/projects/:projectId/* must carry
  // a valid `shogo_a2a_<keyId>.<secret>` bearer key scoped to that exact
  // project. This deliberately covers the agent-card route too (matches
  // Odin's `require_a2a_key` on the card endpoint) — clients must send
  // the bearer token when *fetching the card*, not just when calling
  // RPC. Every rejection reason collapses to the same 401 so a probing
  // caller can't use response shape to enumerate valid projects/keys.
  router.use('/projects/:projectId/*', async (c, next) => {
    const projectId = c.req.param('projectId')
    const authHeader = c.req.header('authorization') ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const result = token ? await verifyA2aApiKey(token, projectId) : { ok: false as const }
    if (!result.ok) {
      c.header('WWW-Authenticate', 'Bearer')
      return c.json(
        { error: { code: 'unauthorized', message: 'A valid shogo_a2a_<keyId>.<secret> bearer key for this project is required' } },
        401,
      )
    }
    c.set('a2aKey', result.key)
    await next()
  })

  router.get('/projects/:projectId/.well-known/agent-card.json', async (c) => {
    const projectId = c.req.param('projectId')
    const card = await buildAgentCard({ projectId, baseUrl: getA2aBaseUrl() })
    if (!card) {
      return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)
    }
    return c.json(AgentCard.toJSON(card))
  })

  router.post('/projects/:projectId/rpc', async (c) => {
    const projectId = c.req.param('projectId')
    const key = c.get('a2aKey')

    let entry: CachedHandler
    try {
      entry = await getOrCreateHandler(projectId, key!.workspaceId)
    } catch (err) {
      if (err instanceof A2AProjectNotFoundError) {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Project not found' } }, 404)
      }
      throw err
    }

    const context = buildA2AServerCallContext({ projectId })
    return handleA2AJsonRpc(c, entry.handler, context)
  })

  return router
}

/** Test/ops hook — number of cached handlers currently held in memory. */
export function getA2AHandlerCacheSize(): number {
  return handlerCache.size
}

// -----------------------------------------------------------------------------
// Key management routes — mounted at /api, session-authed via authorizeProject
// -----------------------------------------------------------------------------

export function a2aKeyRoutes() {
  const router = new Hono()

  router.post('/projects/:projectId/a2a/keys', async (c) => {
    const projectId = c.req.param('projectId')
    const authResult = await authorizeProject(c, projectId)
    if (!authResult.ok) {
      return c.json({ error: { code: authResult.code, message: authResult.message } }, authResult.status)
    }

    const body = await c.req
      .json<{ name?: string; expiresInDays?: number }>()
      .catch((): { name?: string; expiresInDays?: number } => ({}))
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : null

    const authCtx = c.get('auth')
    const minted = await mintA2aApiKey({
      projectId: authResult.projectId,
      workspaceId: authResult.workspaceId,
      createdBy: authCtx?.userId ?? 'unknown',
      name: body.name,
      expiresAt,
    })

    return c.json(
      {
        id: minted.id,
        keyId: minted.keyId,
        name: minted.name,
        // One-time reveal — never returned again after this response.
        key: minted.fullKey,
        projectId: minted.projectId,
        createdAt: minted.createdAt,
        expiresAt: minted.expiresAt,
      },
      201,
    )
  })

  router.get('/projects/:projectId/a2a/keys', async (c) => {
    const projectId = c.req.param('projectId')
    const authResult = await authorizeProject(c, projectId)
    if (!authResult.ok) {
      return c.json({ error: { code: authResult.code, message: authResult.message } }, authResult.status)
    }
    const keys = await listA2aApiKeys(authResult.projectId)
    return c.json({ keys })
  })

  router.delete('/projects/:projectId/a2a/keys/:keyId', async (c) => {
    const projectId = c.req.param('projectId')
    const authResult = await authorizeProject(c, projectId)
    if (!authResult.ok) {
      return c.json({ error: { code: authResult.code, message: authResult.message } }, authResult.status)
    }
    const keyId = c.req.param('keyId')
    const revoked = await revokeA2aApiKey({ id: keyId, projectId: authResult.projectId })
    if (!revoked) {
      return c.json({ error: { code: 'not_found', message: 'Key not found' } }, 404)
    }
    return c.json({ ok: true })
  })

  return router
}
