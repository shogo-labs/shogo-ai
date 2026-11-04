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
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import {
  EDGE_PROXY_HEADER,
  allowUserAppProxyRequest,
  isNonEdgeUserAppProxyRequest,
  isPublicPreviewRenderPath,
  isPublishedApiProxyPath,
  isUserAppProxyPath,
} from '../middleware/api-auth-gate'
import { publishedProxyRequestHeaders, publishedProxyResponseHeaders } from '../lib/preview-proxy-headers'

const STUDIO = 'https://studio.shogo.ai'
const PID = '580b192d-e6bd-410e-833b-f0c473ef6890'
const PREVIEW_ORIGIN = `https://${PID}.preview.shogo.ai`

const EDGE_SECRET = 'edge-proxy-test-secret'

function withEdgeSecret<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.SHOGO_EDGE_PROXY_SECRET
  if (value === undefined) delete process.env.SHOGO_EDGE_PROXY_SECRET
  else process.env.SHOGO_EDGE_PROXY_SECRET = value
  const restore = () => {
    if (previous === undefined) delete process.env.SHOGO_EDGE_PROXY_SECRET
    else process.env.SHOGO_EDGE_PROXY_SECRET = previous
  }
  return Promise.resolve()
    .then(fn)
    .finally(restore)
}

function buildApp(): Hono {
  const app = new Hono()
  app.onError((err) => (err instanceof HTTPException ? err.getResponse() : new Response('boom', { status: 500 })))
  const apiCors = cors({
    origin: (origin, c) => {
      const p = new URL(c.req.url).pathname
      if (isPublicPreviewRenderPath(p) && !isNonEdgeUserAppProxyRequest(c.req.raw.headers)) return origin || '*'
      return origin === STUDIO ? origin : STUDIO
    },
    credentials: true,
  })
  app.use('/*', (c, next) => {
    const p = new URL(c.req.url).pathname
    if (isPublishedApiProxyPath(p) && !isNonEdgeUserAppProxyRequest(c.req.raw.headers)) return next()
    return apiCors(c, next)
  })
  const csrfMw = csrf({ origin: (origin) => origin === STUDIO })
  app.use('/api/*', async (c, next) => {
    const p = new URL(c.req.url).pathname
    if (isUserAppProxyPath(p) && !isNonEdgeUserAppProxyRequest(c.req.raw.headers)) return next()
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
  // These are the answers the proxies give while `SHOGO_EDGE_PROXY_SECRET` is
  // not configured — the deploy window in which the Workers do not send the
  // edge header yet. Pinned regardless of the developer's environment.
  const savedSecret = process.env.SHOGO_EDGE_PROXY_SECRET
  beforeEach(() => {
    delete process.env.SHOGO_EDGE_PROXY_SECRET
  })
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.SHOGO_EDGE_PROXY_SECRET
    else process.env.SHOGO_EDGE_PROXY_SECRET = savedSecret
  })

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

// -----------------------------------------------------------------------------
// The three user-app proxies are for the edge Workers only. A browser on a
// Studio/API host must not be able to reach them directly; the edge sends
// `x-shogo-edge-auth` carrying SHOGO_EDGE_PROXY_SECRET.
// -----------------------------------------------------------------------------
const PROXY_PATHS = [
  `/api/preview/${PID}/render/`,
  `/api/preview/${PID}/ports/3000/render/api/signup`,
  '/api/published/samsara-api/api/signup',
]

function buildGatedApp(): Hono {
  const app = new Hono()
  app.onError((err) => (err instanceof HTTPException ? err.getResponse() : new Response('boom', { status: 500 })))
  app.use('/api/*', async (c, next) => {
    const p = new URL(c.req.url).pathname
    if (!allowUserAppProxyRequest(p, c.req.raw.headers)) return c.text('404 Not Found', 404)
    return next()
  })
  const appResponse = (c: any) => c.html('<html>app</html>')
  app.all('/api/preview/:projectId/render/*', appResponse)
  app.all('/api/preview/:projectId/ports/:port/render/*', appResponse)
  app.all('/api/published/:subdomain/api/*', appResponse)
  return app
}

function get(app: Hono, path: string, headers: Record<string, string>) {
  return app.fetch(new Request(`http://api.test${path}`, { method: 'GET', headers }))
}

describe('user-app proxies only answer for the edge Worker', () => {
  test('on a Studio host with no edge header, every proxy path is a plain 404 — never app HTML', async () => {
    await withEdgeSecret(EDGE_SECRET, async () => {
      const app = buildGatedApp()
      for (const path of PROXY_PATHS) {
        const res = await get(app, path, { host: 'studio.shogo.ai' })
        expect(res.status).toBe(404)
        expect(res.headers.get('content-type') || '').not.toContain('text/html')
        expect(await res.text()).toBe('404 Not Found')
      }
    })
  })

  test('on an api host too, and with a wrong header value', async () => {
    await withEdgeSecret(EDGE_SECRET, async () => {
      const app = buildGatedApp()
      const host = await get(app, PROXY_PATHS[0], { host: 'api.shogo.ai' })
      expect(host.status).toBe(404)
      const forged = await get(app, PROXY_PATHS[0], { host: 'studio.shogo.ai', [EDGE_PROXY_HEADER]: 'nope' })
      expect(forged.status).toBe(404)
    })
  })

  test('with the edge header the request reaches the handler', async () => {
    await withEdgeSecret(EDGE_SECRET, async () => {
      const app = buildGatedApp()
      for (const path of PROXY_PATHS) {
        const res = await get(app, path, { host: 'studio.shogo.ai', [EDGE_PROXY_HEADER]: EDGE_SECRET })
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('<html>app</html>')
      }
    })
  })

  test('a non-Studio host (local desktop mode) is served rather than refused', async () => {
    await withEdgeSecret(EDGE_SECRET, async () => {
      const app = buildGatedApp()
      const res = await get(app, PROXY_PATHS[0], { host: 'localhost:37301' })
      expect(res.status).toBe(200)
    })
  })

  test('nothing is enforced until the edge secret is configured, so the Workers can ship first', async () => {
    await withEdgeSecret(undefined, async () => {
      const app = buildGatedApp()
      for (const path of PROXY_PATHS) {
        expect((await get(app, path, { host: 'studio.shogo.ai' })).status).toBe(200)
      }
    })
  })
})

describe('published api proxy keeps the visitor session at the edge', () => {
  const browserRequest = () => new Headers({
    cookie: 'better-auth.session_token=abc',
    authorization: 'Bearer studio-token',
    accept: 'application/json',
    'x-forwarded-host': 'samsara-api.shogo.one',
  })

  test('without the edge header no cookie or authorization is forwarded', () => {
    const headers = publishedProxyRequestHeaders(browserRequest(), { trustVisitor: false })
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('x-forwarded-host')).toBe('samsara-api.shogo.one')
  })

  test('with the edge header the app still gets the visitor session', () => {
    const headers = publishedProxyRequestHeaders(browserRequest(), { trustVisitor: true })
    expect(headers.get('cookie')).toBe('better-auth.session_token=abc')
    expect(headers.get('authorization')).toBe('Bearer studio-token')
  })

  test('a non-edge response drops set-cookie and is sandboxed; an edge one passes both through', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'set-cookie': 'app_session=1; Path=/',
    })
    const nonEdge = publishedProxyResponseHeaders(upstream, { trustVisitor: false })
    expect(nonEdge.get('set-cookie')).toBeNull()
    expect(nonEdge.get('content-security-policy')).toContain('sandbox')
    expect(nonEdge.get('content-type')).toBe('application/json')

    const edge = publishedProxyResponseHeaders(upstream, { trustVisitor: true })
    expect(edge.get('set-cookie')).toBe('app_session=1; Path=/')
    expect(edge.get('content-security-policy')).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// The switch itself: `isNonEdgeUserAppProxyRequest` is what every behaviour
// below keys off, so pin its two halves directly.
// -----------------------------------------------------------------------------
describe('isNonEdgeUserAppProxyRequest', () => {
  test('is false while no secret is configured, whatever the header says', async () => {
    await withEdgeSecret(undefined, () => {
      expect(isNonEdgeUserAppProxyRequest(new Headers())).toBe(false)
      expect(isNonEdgeUserAppProxyRequest(new Headers({ [EDGE_PROXY_HEADER]: 'anything' }))).toBe(false)
    })
  })

  test('is true once the secret exists and the request did not carry it', async () => {
    await withEdgeSecret(EDGE_SECRET, () => {
      expect(isNonEdgeUserAppProxyRequest(new Headers())).toBe(true)
      expect(isNonEdgeUserAppProxyRequest(new Headers({ [EDGE_PROXY_HEADER]: 'wrong' }))).toBe(true)
      expect(isNonEdgeUserAppProxyRequest(new Headers({ [EDGE_PROXY_HEADER]: EDGE_SECRET }))).toBe(false)
    })
  })
})

// -----------------------------------------------------------------------------
// With the secret configured, a direct (non-edge) caller loses the exceptions
// the proxies hand the Worker.
// -----------------------------------------------------------------------------
describe('with the edge secret configured, a direct caller gets the Studio answers', () => {
  test('a preview form POST from the app\'s own origin is refused without the edge header', async () => {
    await withEdgeSecret(EDGE_SECRET, async () => {
      const app = buildApp()
      expect((await post(app, `/api/preview/${PID}/render/api/signup`, PREVIEW_ORIGIN)).status).toBe(403)
      expect((await post(app, '/api/published/samsara-api/api/signup', 'https://samsara-api.shogo.one')).status).toBe(403)
    })
  })

  test('and the request that carries it keeps them', async () => {
    await withEdgeSecret(EDGE_SECRET, async () => {
      const app = buildApp()
      const res = await app.fetch(new Request(`http://api.test/api/preview/${PID}/render/api/signup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: PREVIEW_ORIGIN,
          [EDGE_PROXY_HEADER]: EDGE_SECRET,
        },
        body: 'email=a%40b.c',
      }))
      expect(res.status).toBe(200)
    })
  })

  test('preflight stops echoing a foreign origin without the edge header', async () => {
    await withEdgeSecret(EDGE_SECRET, async () => {
      const app = buildApp()
      const res = await app.fetch(new Request(`http://api.test/api/preview/${PID}/render/api/signup`, {
        method: 'OPTIONS',
        headers: { origin: 'https://playsamsara.com', 'access-control-request-method': 'POST' },
      }))
      expect(res.headers.get('access-control-allow-origin')).toBe(STUDIO)
    })
  })
})

describe('published proxy header policy for a trusted vs untrusted caller', () => {
  test('an untrusted caller forwards no visitor session and gets a sandboxed response', () => {
    const request = publishedProxyRequestHeaders(
      new Headers({ cookie: 'better-auth.session_token=abc', authorization: 'Bearer t' }),
      { trustVisitor: false },
    )
    expect(request.get('cookie')).toBeNull()
    expect(request.get('authorization')).toBeNull()
    const response = publishedProxyResponseHeaders(
      new Headers({ 'set-cookie': 'app_session=1; Path=/' }),
      { trustVisitor: false },
    )
    expect(response.get('set-cookie')).toBeNull()
    expect(response.get('content-security-policy')).toContain('sandbox')
  })

  test('a trusted caller keeps the previous behaviour unchanged', () => {
    const request = publishedProxyRequestHeaders(
      new Headers({ cookie: 'better-auth.session_token=abc', authorization: 'Bearer t' }),
      { trustVisitor: true },
    )
    expect(request.get('cookie')).toBe('better-auth.session_token=abc')
    expect(request.get('authorization')).toBe('Bearer t')
    const response = publishedProxyResponseHeaders(
      new Headers({ 'set-cookie': 'app_session=1; Path=/' }),
      { trustVisitor: true },
    )
    expect(response.get('set-cookie')).toBe('app_session=1; Path=/')
    expect(response.get('content-security-policy')).toBeNull()
  })
})
