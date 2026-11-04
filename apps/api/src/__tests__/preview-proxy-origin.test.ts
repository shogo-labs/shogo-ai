// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression: a browser POST to a user's app through the public preview proxy
 * (`{id}.preview.<base>` → `/api/preview/:id/render/*`) or a metal published
 * site's `/api/*` (`/api/published/:sub/api/*`) got the API's Studio-only
 * CSRF answer: plain `403 Forbidden` for any Origin that is not Studio,
 * including the app's own preview host. Forms on the preview (and on a site
 * posting to it) could never reach the app's server.
 *
 * Mirrors the /api/* csrf + cors wiring in server.ts with the real predicates.
 */
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { isPublicPreviewRenderPath, isPublishedApiProxyPath, isUserAppProxyPath } from '../middleware/api-auth-gate'

const STUDIO = 'https://studio.shogo.ai'
const PID = '580b192d-e6bd-410e-833b-f0c473ef6890'
const PREVIEW_ORIGIN = `https://${PID}.preview.shogo.ai`

function buildApp(): Hono {
  const app = new Hono()
  app.onError((err) => (err instanceof HTTPException ? err.getResponse() : new Response('boom', { status: 500 })))
  const apiCors = cors({
    origin: (origin, c) => {
      const p = new URL(c.req.url).pathname
      if (isPublicPreviewRenderPath(p)) return origin || '*'
      return origin === STUDIO ? origin : STUDIO
    },
    credentials: true,
  })
  app.use('/*', (c, next) => {
    if (isPublishedApiProxyPath(new URL(c.req.url).pathname)) return next()
    return apiCors(c, next)
  })
  const csrfMw = csrf({ origin: (origin) => origin === STUDIO })
  app.use('/api/*', async (c, next) => {
    const p = new URL(c.req.url).pathname
    if (isUserAppProxyPath(p)) return next()
    if (!c.req.header('origin') && !c.req.header('referer')) return next()
    return csrfMw(c, next)
  })
  app.all('/api/published/:sub/api/*', (c) =>
    c.req.method === 'OPTIONS' ? c.body(null, 204, { 'x-answered-by': 'app' }) : c.json({ reached: true }))
  app.all('/api/*', (c) => c.json({ reached: true }))
  return app
}

function post(app: Hono, path: string, origin?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (origin) headers.origin = origin
  return app.fetch(new Request(`http://api.test${path}`, { method: 'POST', headers, body: 'email=a%40b.c' }))
}

describe('user-app proxy paths skip the Studio CSRF allow-list', () => {
  test('preview render: same-origin and cross-site form POSTs reach the app', async () => {
    const app = buildApp()
    for (const origin of [PREVIEW_ORIGIN, 'https://playsamsara.com']) {
      const res = await post(app, `/api/preview/${PID}/render/api/signup`, origin)
      expect(res.status).toBe(200)
    }
  })

  test('per-port preview and metal published api reach the app', async () => {
    const app = buildApp()
    expect((await post(app, `/api/preview/${PID}/ports/3000/render/api/signup`, PREVIEW_ORIGIN)).status).toBe(200)
    expect((await post(app, '/api/published/samsara-api/api/signup', 'https://samsara-api.shogo.one')).status).toBe(200)
  })

  test('every other /api route still rejects a foreign Origin', async () => {
    const app = buildApp()
    for (const path of ['/api/projects/x', `/api/preview/${PID}/wake`, '/api/published/samsara-api/wake', `/api/preview/${PID}/renderx`]) {
      expect((await post(app, path, 'https://evil.example')).status).toBe(403)
    }
    expect((await post(app, '/api/projects/x', STUDIO)).status).toBe(200)
  })

  test('preflight: preview echoes the origin, published goes to the app, the rest stay Studio-only', async () => {
    const app = buildApp()
    const preflight = (path: string) => app.fetch(new Request(`http://api.test${path}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://playsamsara.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    }))
    const ok = await preflight(`/api/preview/${PID}/render/api/signup`)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://playsamsara.com')
    expect(ok.headers.get('access-control-allow-headers')).toContain('content-type')
    const port = await preflight(`/api/preview/${PID}/ports/3000/render/api/signup`)
    expect(port.headers.get('access-control-allow-origin')).toBe(STUDIO)
    const published = await preflight('/api/published/samsara-api/api/signup')
    expect(published.headers.get('x-answered-by')).toBe('app')
    expect(published.headers.get('access-control-allow-origin')).toBeNull()
    const other = await preflight('/api/projects/x')
    expect(other.headers.get('access-control-allow-origin')).toBe(STUDIO)
  })
})
