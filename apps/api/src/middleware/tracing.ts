// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { trace, SpanKind, SpanStatusCode, context } from '@opentelemetry/api'
import type { MiddlewareHandler } from 'hono'

const tracer = trace.getTracer('shogo-api')

const IGNORED_PATHS = new Set(['/api/health', '/healthz', '/ready'])

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const CUID_RE = /\/[a-z0-9]{20,30}(?=\/|$)/g

/**
 * Normalize a concrete path into a route-like pattern for span grouping.
 * Replaces UUIDs and cuid-style IDs with `:id` so traces group properly
 * even when Hono's routePath is unavailable (e.g. middleware short-circuits).
 */
function normalizePath(path: string): string {
  return path
    .replace(UUID_RE, ':id')
    .replace(CUID_RE, '/:id')
}

export const tracingMiddleware: MiddlewareHandler = async (c, next) => {
  const path = c.req.path
  if (IGNORED_PATHS.has(path)) {
    return next()
  }

  const method = c.req.method
  const normalizedPath = normalizePath(path)
  const spanName = `${method} ${normalizedPath}`

  return tracer.startActiveSpan(spanName, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.method': method,
      'http.target': path,
      'http.url': c.req.url,
      'http.route': normalizedPath,
      'http.user_agent': c.req.header('user-agent') || '',
    },
  }, async (span) => {
    try {
      await next()

      const status = c.res.status
      span.setAttribute('http.status_code', status)

      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` })
      } else if (status >= 400) {
        span.setStatus({ code: SpanStatusCode.UNSET })
        span.setAttribute('http.error_type', `${status}`)
      }
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
      span.recordException(err)
      throw err
    } finally {
      const matched = c.req.routePath
      if (matched && matched !== '/api/*' && matched !== '/*' && matched !== '*') {
        span.setAttribute('http.route', matched)
        span.updateName(`${method} ${matched}`)
      }

      span.end()
    }
  })
}
