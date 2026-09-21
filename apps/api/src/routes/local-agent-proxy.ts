// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import type { IRuntimeManager } from '../lib/runtime'
import { prisma } from '../lib/prisma'
import { resolveProjectPodUrl } from '../lib/resolve-pod-url'
import { deriveProjectRuntimeToken } from '../lib/project-runtime-token'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function authUserId(c: any): string | null {
  const auth = c.get('auth') as { userId?: string; isAuthenticated?: boolean } | undefined
  return auth?.isAuthenticated && auth.userId ? auth.userId : null
}

function copyResponseHeaders(source: Headers, origin: string | undefined): Headers {
  const headers = new Headers()
  source.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') {
      headers.set(key, value)
    }
  })
  headers.set('access-control-allow-origin', origin || '*')
  headers.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  headers.set('access-control-allow-headers', '*')
  if (origin) headers.set('access-control-allow-credentials', 'true')
  headers.set('cross-origin-resource-policy', 'cross-origin')
  const contentType = source.get('content-type') || ''
  if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
    headers.set('cache-control', 'no-cache, no-transform')
    headers.set('x-accel-buffering', 'no')
  }
  return headers
}

/**
 * Local agent-runtime proxy.
 *
 * The cloud composer has additional billing, region pinning, tunnel, and
 * retry behavior around this route. Desktop only needs the direct
 * workspace-runtime path; keeping that path here avoids loading those cloud
 * integrations into the local bundle.
 */
export function localAgentProxyRoutes(config: { runtimeManager: IRuntimeManager }): Hono {
  const router = new Hono()

  const handler = async (c: any) => {
    const projectId = c.req.param('projectId')
    const userId = authUserId(c)
    if (!userId) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, workspaceId: true },
    })
    if (!project) {
      return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404)
    }

    try {
      const resolved = await resolveProjectPodUrl(projectId, {
        logTag: 'LocalAgentProxy',
        runtimeManager: config.runtimeManager,
      })
      const path = c.req.path.replace(`/api/projects/${projectId}/agent-proxy`, '') || '/'
      const target = `${resolved.url.replace(/\/$/, '')}${path}${new URL(c.req.url).search}`
      const headers = new Headers()
      for (const name of ['content-type', 'accept', 'x-chat-session-id']) {
        const value = c.req.header(name)
        if (value) headers.set(name, value)
      }
      headers.set('x-runtime-token', await deriveProjectRuntimeToken(projectId, {
        workspaceId: project.workspaceId,
      }))

      const body = c.req.method === 'GET' || c.req.method === 'HEAD'
        ? undefined
        : await c.req.arrayBuffer()
      const upstream = await fetch(target, {
        method: c.req.method,
        headers,
        body,
        signal: c.req.raw.signal,
      })

      return new Response(upstream.body, {
        status: upstream.status,
        headers: copyResponseHeaders(upstream.headers, c.req.header('origin')),
      })
    } catch (error: any) {
      const message = error?.message || 'Project runtime is unavailable'
      console.warn(`[LocalAgentProxy] ${projectId}: ${message}`)
      return c.json({
        error: { code: 'runtime_unavailable', message, retryable: true },
      }, 503)
    }
  }

  router.all('/projects/:projectId/agent-proxy', handler)
  router.all('/projects/:projectId/agent-proxy/*', handler)
  return router
}
