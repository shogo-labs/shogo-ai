// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'

const projectIdPattern = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Small IDE-only compatibility routes that are independent of the cloud
 * composer. Diagnostics themselves come from shared-runtime; this route keeps
 * terminal-reported diagnostics in the same response shape.
 */
export function localIdeRoutes(): Hono {
  const router = new Hono()
  const terminalDiagnostics = new Map<string, unknown[]>()

  router.post('/projects/:projectId/diagnostics/terminal', async (c) => {
    const projectId = c.req.param('projectId')
    if (!projectIdPattern.test(projectId)) {
      return c.json({ error: { code: 'invalid_project_id', message: 'Invalid project id' } }, 400)
    }
    let body: { diagnostics?: unknown[]; clear?: boolean } = {}
    try {
      body = await c.req.json()
    } catch {}
    if (body.clear) terminalDiagnostics.delete(projectId)
    else terminalDiagnostics.set(projectId, Array.isArray(body.diagnostics) ? body.diagnostics : [])
    return c.json({ ok: true })
  })

  router.get('/types-proxy', async (c) => {
    const rawUrl = c.req.query('url')
    if (!rawUrl) {
      return c.json({ error: { code: 'missing_url', message: 'URL query parameter is required' } }, 400)
    }

    let target: URL
    try {
      target = new URL(rawUrl)
    } catch {
      return c.json({ error: { code: 'invalid_url', message: 'Invalid URL format' } }, 400)
    }
    if (!['cdn.jsdelivr.net', 'unpkg.com', 'esm.sh'].includes(target.hostname)) {
      return c.json({ error: { code: 'forbidden_host', message: `Host ${target.hostname} is not allowed` } }, 403)
    }

    try {
      const response = await fetch(target, {
        headers: { 'user-agent': 'Shogo-Studio-TypesProxy/1.0' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        return c.json({
          error: { code: 'upstream_error', message: `Upstream returned ${response.status}` },
        }, response.status as any)
      }
      return c.text(await response.text(), 200, {
        'content-type': response.headers.get('content-type') || 'text/plain',
        'cache-control': 'public, max-age=86400',
      })
    } catch (error: any) {
      return c.json({
        error: { code: 'fetch_error', message: error?.message || 'Failed to fetch from CDN' },
      }, 502)
    }
  })

  return router
}
