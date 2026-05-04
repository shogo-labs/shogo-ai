// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `/agent/runtime-logs` and `/agent/runtime-logs/stream` route factory.
 *
 * Pulled out of `server.ts` so tests can mount the routes against a tiny
 * Hono app and avoid spinning up the full agent-gateway. The behavior
 * lives here; `server.ts` just composes it into the main app.
 */

import { Hono } from 'hono'
import {
  getRuntimeLogsSnapshot,
  subscribeRuntimeLogs,
  type RuntimeLogEntry,
  type RuntimeLogSource,
} from './runtime-log-dispatcher'

const ALLOWED_SOURCES: ReadonlyArray<RuntimeLogSource> = [
  'console',
  'build',
  'canvas-error',
  'exec',
  'terminal',
]

export function parseSources(
  value: string | null | undefined,
): RuntimeLogSource[] | undefined {
  if (!value) return undefined
  const filtered: RuntimeLogSource[] = []
  for (const raw of value.split(',')) {
    const t = raw.trim() as RuntimeLogSource
    if (ALLOWED_SOURCES.includes(t)) filtered.push(t)
  }
  return filtered.length > 0 ? filtered : undefined
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function runtimeLogsRoutes(): Hono {
  const app = new Hono()

  app.get('/agent/runtime-logs', (c) => {
    const since = parsePositiveInt(c.req.query('since'))
    const sources = parseSources(c.req.query('sources'))
    const limit = parsePositiveInt(c.req.query('limit'))
    const entries = getRuntimeLogsSnapshot({ since, sources, limit })
    return c.json({ entries })
  })

  app.get('/agent/runtime-logs/stream', (c) => {
    const sources = parseSources(c.req.query('sources'))
    const sinceParam = parsePositiveInt(c.req.query('since'))

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        let closed = false

        const send = (entry: RuntimeLogEntry): void => {
          if (closed) return
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(entry)}\n\n`),
            )
          } catch {
            // Client disconnected before we could flush.
          }
        }

        // Replay recent backlog so a fresh subscriber gets context.
        for (const entry of getRuntimeLogsSnapshot({
          since: sinceParam,
          sources,
          limit: 200,
        })) {
          send(entry)
        }

        const unsubscribe = subscribeRuntimeLogs((entry) => {
          if (sources && !sources.includes(entry.source)) return
          send(entry)
        })

        const onAbort = (): void => {
          if (closed) return
          closed = true
          unsubscribe()
          try {
            controller.close()
          } catch {
            // Stream already torn down; nothing to do.
          }
        }

        c.req.raw.signal.addEventListener('abort', onAbort)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  return app
}
