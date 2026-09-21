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
    '/api/marketplace',
    '/api/tech-stacks',
    '/api/platform/visible-models',
  ]

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

  app.use('/api/auth/*', rateLimiter('auth', { max: 60, windowMs: 60_000 }))
  app.use('/api/*', rateLimiter('global', {
    max: Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 600,
    windowMs: Number(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS) || 60_000,
    skipPrefixes: ['/api/ai/', '/api/health', '/api/local/'],
  }))
  app.use('/api/*', authMiddleware)
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
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
    version: process.env.APP_VERSION || '0.0.0',
    buildHash: process.env.BUILD_HASH || 'dev',
  }))
  return app
}
