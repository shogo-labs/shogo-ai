// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { trace, SpanKind, SpanStatusCode, context } from '@opentelemetry/api'
import type { MiddlewareHandler } from 'hono'

const tracer = trace.getTracer('shogo-api')

const IGNORED_PATHS = new Set(['/api/health', '/healthz', '/ready'])

export const tracingMiddleware: MiddlewareHandler = async (c, next) => {
  const path = c.req.path
  if (IGNORED_PATHS.has(path)) {
    return next()
  }

  const method = c.req.method
  const spanName = `${method} ${path}`

  return tracer.startActiveSpan(spanName, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.method': method,
      'http.target': path,
      'http.url': c.req.url,
      'http.user_agent': c.req.header('user-agent') || '',
    },
  }, async (span) => {
    try {
      await next()

      const status = c.res.status
      span.setAttribute('http.status_code', status)

      if (status >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` })
      }
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
      span.recordException(err)
      throw err
    } finally {
      // Attach matched route pattern when available (e.g. /api/projects/:id)
      const matched = c.req.routePath
      if (matched) {
        span.setAttribute('http.route', matched)
        span.updateName(`${method} ${matched}`)
      }

      span.end()
    }
  })
}
