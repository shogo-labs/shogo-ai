// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import type { IRuntimeManager } from '../lib/runtime'
import { resolveProjectPodUrl } from '../lib/resolve-pod-url'

function copyPreviewHeaders(source: Headers): Headers {
  const headers = new Headers()
  source.forEach((value, key) => {
    if (!['connection', 'set-cookie', 'transfer-encoding'].includes(key.toLowerCase())) {
      headers.set(key, value)
    }
  })
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
  headers.set('access-control-allow-headers', '*')
  return headers
}

export function localPreviewRoutes(config: { runtimeManager: IRuntimeManager }): Hono {
  const router = new Hono()

  router.get('/preview/:projectId/wake', async (c) => {
    const projectId = c.req.param('projectId')
    try {
      const resolved = await resolveProjectPodUrl(projectId, {
        logTag: 'LocalPreviewWake',
        runtimeManager: config.runtimeManager,
        openAttemptId: c.req.header('x-shogo-open-id')?.slice(0, 128),
      })
      return c.json({
        ok: true,
        ready: resolved.mode === 'host' ? resolved.runtime.status === 'running' : true,
        url: resolved.url,
      })
    } catch (error: any) {
      return c.json({
        ok: false,
        ready: false,
        error: { code: 'runtime_unavailable', message: error?.message || 'Runtime unavailable' },
      }, 503)
    }
  })

  router.get('/preview/:projectId/open', async (c) => {
    const projectId = c.req.param('projectId')
    const runtime = config.runtimeManager.status(projectId)
    if (!runtime?.url) {
      return c.redirect(`/api/preview/${encodeURIComponent(projectId)}/wake`, 307)
    }
    return c.redirect(`${runtime.url}/`, 307)
  })

  const proxyPreview = async (c: any) => {
    const projectId = c.req.param('projectId')
    const runtime = config.runtimeManager.status(projectId)
    if (!runtime?.url) {
      return c.json({
        error: { code: 'not_running', message: 'Project runtime not running' },
      }, 404)
    }

    const path = c.req.path.replace(`/api/projects/${projectId}/preview`, '') || '/'
    const target = `${runtime.url.replace(/\/$/, '')}/preview${path}${new URL(c.req.url).search}`
    const headers = new Headers()
    for (const name of ['accept', 'content-type', 'accept-encoding', 'x-proxy-base-path']) {
      const value = c.req.header(name)
      if (value) headers.set(name, value)
    }
    const body = c.req.method === 'GET' || c.req.method === 'HEAD'
      ? undefined
      : await c.req.arrayBuffer()
    try {
      const upstream = await fetch(target, {
        method: c.req.method,
        headers,
        body,
        signal: c.req.raw.signal,
      })
      return new Response(upstream.body, {
        status: upstream.status,
        headers: copyPreviewHeaders(upstream.headers),
      })
    } catch (error: any) {
      return c.json({
        error: { code: 'proxy_error', message: error?.message || 'Preview unavailable' },
      }, 502)
    }
  }

  router.get('/projects/:projectId/preview/metro', async (c) => {
    const projectId = c.req.param('projectId')
    const runtime = config.runtimeManager.status(projectId)
    if (!runtime?.url) {
      return c.json({ error: 'Project runtime not running' }, 404)
    }
    try {
      const response = await fetch(`${runtime.url.replace(/\/$/, '')}/preview/metro`, {
        signal: c.req.raw.signal,
      })
      return new Response(response.body, {
        status: response.status,
        headers: copyPreviewHeaders(response.headers),
      })
    } catch (error: any) {
      return c.json({ error: 'Metro metadata fetch failed', detail: error?.message }, 502)
    }
  })

  router.all('/projects/:projectId/preview', (c) => {
    const projectId = c.req.param('projectId')
    return c.redirect(`/api/projects/${encodeURIComponent(projectId)}/preview/`, 307)
  })
  router.all('/projects/:projectId/preview/*', proxyPreview)

  return router
}
