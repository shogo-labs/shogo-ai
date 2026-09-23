// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { join } from 'path'
import type { IRuntimeManager } from '../lib/runtime'
import { auth } from '../auth'
import { prisma } from '../lib/prisma'
import { proxyTerminalSessionsToPod } from '../lib/pty-pod-rest-proxy'
import {
  buildPtyPodBridgeData,
  createPtyPodBridgeHandlers,
  isPtyPodBridgeData,
  type PtyPodBridgeData,
} from '../lib/pty-pod-bridge'
import { deriveProjectRuntimeToken } from '../lib/project-runtime-token'
import { resolveProjectPodUrl } from '../lib/resolve-pod-url'

const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const PTY_WS_PATH_RE = /^\/api\/projects\/([^/]+)\/terminal\/sessions\/([^/]+)\/ws$/

function isSafeProjectId(projectId: string): boolean {
  return PROJECT_ID_RE.test(projectId)
}

function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_RE.test(sessionId)
}

async function authenticateUpgrade(req: Request, projectId: string): Promise<boolean> {
  try {
    const session = await auth.api.getSession({ headers: req.headers })
    const userId = session?.user?.id
    if (!userId) return false
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    })
    if (!project) return false
    const membership = await prisma.member.findFirst({
      where: { userId, workspaceId: project.workspaceId },
      select: { id: true },
    })
    return !!membership
  } catch {
    return false
  }
}

async function resolveTerminalPodUrl(projectId: string, runtimeManager: IRuntimeManager): Promise<string> {
  const resolved = await resolveProjectPodUrl(projectId, {
    logTag: 'LocalTerminal',
    runtimeManager,
  })
  return resolved.url
}

export function localTerminalRoutes(config: {
  runtimeManager: IRuntimeManager
  workspacesDir: string
}): Hono {
  const router = new Hono()
  const deps = {
    resolvePodUrl: (projectId: string) => resolveTerminalPodUrl(projectId, config.runtimeManager),
    deriveRuntimeToken: (projectId: string) => deriveProjectRuntimeToken(projectId),
    isSafeProjectId,
  }

  router.post('/projects/:projectId/terminal/sessions', async (c) => {
    return proxyTerminalSessionsToPod(deps, {
      projectId: c.req.param('projectId'),
      method: 'POST',
      pathSuffix: '',
      body: await c.req.text(),
      contentType: c.req.header('content-type'),
    })
  })

  router.get('/projects/:projectId/terminal/sessions', async (c) => {
    return proxyTerminalSessionsToPod(deps, {
      projectId: c.req.param('projectId'),
      method: 'GET',
      pathSuffix: '',
      body: undefined,
      contentType: undefined,
    })
  })

  router.delete('/projects/:projectId/terminal/sessions/:id', async (c) => {
    const id = c.req.param('id')
    if (!isSafeSessionId(id)) {
      return c.json({ error: { code: 'invalid_session_id', message: 'Invalid session id' } }, 400)
    }
    return proxyTerminalSessionsToPod(deps, {
      projectId: c.req.param('projectId'),
      method: 'DELETE',
      pathSuffix: `/${encodeURIComponent(id)}`,
      body: undefined,
      contentType: undefined,
    })
  })

  router.get('/projects/:projectId/terminal/commands', async (c) => {
    const projectId = c.req.param('projectId')
    if (!isSafeProjectId(projectId)) {
      return c.json({ error: { code: 'invalid_project_id', message: 'Invalid project id' } }, 400)
    }
    try {
      const { buildQuickCommands, groupQuickCommandsByCategory } = await import(
        '@shogo/agent-runtime/src/quick-commands'
      )
      const commands = groupQuickCommandsByCategory(
        buildQuickCommands(join(config.workspacesDir, projectId)),
      )
      return c.json({ commands })
    } catch (error: any) {
      return c.json({
        error: { code: 'commands_unavailable', message: error?.message || 'Unable to load commands' },
      }, 503)
    }
  })

  return router
}

export function createLocalPtyBridgeHandlers() {
  return createPtyPodBridgeHandlers()
}

/**
 * Resolve and upgrade a local PTY socket before Hono sees the request.
 *
 * Returns `null` when the request is unrelated, `undefined` after a successful
 * Bun upgrade, or an HTTP response when validation/runtime resolution fails.
 */
export async function upgradeLocalPtySocket(
  req: Request,
  server: any,
  runtimeManager: IRuntimeManager,
): Promise<Response | undefined | null> {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null
  const match = PTY_WS_PATH_RE.exec(new URL(req.url).pathname)
  if (!match) return null

  const [, projectId, sessionId] = match
  const since = Number(new URL(req.url).searchParams.get('since')) || 0
  if (!isSafeProjectId(projectId) || !isSafeSessionId(sessionId)) {
    return new Response('Invalid id', { status: 400 })
  }
  if (!await authenticateUpgrade(req, projectId)) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    const podUrl = await resolveTerminalPodUrl(projectId, runtimeManager)
    const data: PtyPodBridgeData = buildPtyPodBridgeData({
      podUrl,
      sessionId,
      since,
      runtimeToken: await deriveProjectRuntimeToken(projectId),
    })
    if (server.upgrade(req, { data })) return undefined
    return new Response('PTY WebSocket upgrade failed', { status: 500 })
  } catch (error: any) {
    console.error('[LocalTerminal] WS runtime resolution failed:', error?.message ?? error)
    return new Response('Runtime unavailable', { status: 503 })
  }
}

export function isLocalPtyBridgeData(data: unknown): data is PtyPodBridgeData {
  return isPtyPodBridgeData(data)
}
