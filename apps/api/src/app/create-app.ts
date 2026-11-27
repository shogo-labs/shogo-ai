// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { bodyLimit } from 'hono/body-limit'
import { auth } from '../auth'
import { authMiddleware, requireAuth, requireProjectAccess, isProjectReservedTopLevelPath } from '../middleware/auth'
import { rateLimiter } from '../middleware/rate-limit'
import { deployedAppVersionOrUnknown } from '../lib/app-version'
import { toNativeAuthHandback } from '../lib/auth-handback'
import type { ApiProfile } from './profile'

export interface CreateAppOptions {
  profile: ApiProfile
  vitePort?: number
  health?: (c: any) => Response
  publicPrefixes?: string[]
}

export function createApp(options: CreateAppOptions): Hono {
  const app = new Hono()
  const vitePort = options.vitePort ?? 8081
  const publicPrefixes = options.publicPrefixes ?? [
    '/api/auth/',
    '/api/health',
    '/api/version',
    '/api/config',
    '/api/local/',
    '/api/ai/',
    '/api/tools/',
    '/api/f/',
    '/api/marketplace',
    '/api/tech-stacks',
    '/api/platform/visible-models',
    // The slides viewer is a static, sandboxed page (no tenant data, no
    // network) that every file host frames to render a deck (SHO-426).
    '/api/viewers/slides',
    // The document viewer is the same, for Word files (SHO-467).
    '/api/viewers/document',
  ]

  // Both office viewers are framed by every file host, and locally the app and
  // the API are different origins (app :8081, API :8002), so SAMEORIGIN below
  // would block the frame. Registered before secureHeaders so it wraps it and
  // can remove the header on the way back out of the middleware onion
  // (SHO-426, SHO-467).
  for (const viewerPath of ['/api/viewers/slides', '/api/viewers/document']) {
    app.use(viewerPath, async (c, next) => {
      await next()
      c.res.headers.delete('X-Frame-Options')
      c.res.headers.delete('Cross-Origin-Opener-Policy')
    })
  }
  app.use('*', secureHeaders({
    xFrameOptions: 'SAMEORIGIN',
    xContentTypeOptions: 'nosniff',
    crossOriginOpenerPolicy: 'same-origin-allow-popups',
    crossOriginResourcePolicy: 'cross-origin',
  }))
  app.use('*', bodyLimit({ maxSize: 500 * 1024 * 1024 }))
  app.use('/*', cors({
    origin: (origin) => {
      if (!origin) return `http://localhost:${vitePort}`
      if (
        origin === 'null' ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('shogo://') ||
        /^http:\/\/192\.168\.\d+\.\d+/.test(origin)
      ) return origin
      return `http://localhost:${vitePort}`
    },
    credentials: true,
    exposeHeaders: ['Content-Disposition'],
  }))
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error(`[${options.profile} API] ${c.req.method} ${c.req.path}:`, err)
    return c.json({
      error: {
        code: 'internal_error',
        message: process.env.NODE_ENV === 'production' ? 'An internal error occurred' : (err as Error).message,
      },
    }, 500)
  })

  // The IP limiters guard a shared, internet-facing server from abuse. The
  // desktop API is single-user on loopback ("Local mode is unlimited", SHO-43)
  // and nothing on it sets x-forwarded-for, so `getClientIp` keys every request
  // on the machine as 'unknown': the UI, the agent runtimes and the
  // runtime→API internal calls would share one 600/min bucket and the API would
  // answer its own user and agents 429 (SHO-603). The local profile therefore
  // mounts neither limiter. Per-user/per-agent limits in `lib/chat-limits.ts`
  // (keyed by user, not IP) still guard loops.
  if (options.profile !== 'local') {
    app.use('/api/auth/*', rateLimiter('auth', {
      max: Number(process.env.RATE_LIMIT_AUTH_MAX) || 60,
      windowMs: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS) || 60_000,
    }))
    app.use('/api/*', rateLimiter('global', {
      max: Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 600,
      windowMs: Number(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS) || 60_000,
      skipPrefixes: ['/api/ai/', '/api/health', '/api/local/'],
    }))
  }
  app.use('/api/*', authMiddleware)
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => toNativeAuthHandback(await auth.handler(c.req.raw)))
  app.use('/api/*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (publicPrefixes.some((prefix) => path.startsWith(prefix))) return next()
    if (!c.req.header('origin') && !c.req.header('referer')) return next()
    return requireAuth(c, next)
  })
  app.use('/api/projects/:projectId/*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (isProjectReservedTopLevelPath(path)) return next()
    return requireProjectAccess(c, next)
  })

  const health = options.health ?? ((c: any) => c.json({ ok: true }))
  app.get('/health', health)
  app.get('/api/health', health)
  app.get('/api/version', (c) => c.json({
    version: deployedAppVersionOrUnknown(),
    buildHash: process.env.BUILD_HASH || 'dev',
  }))
  return app
}
