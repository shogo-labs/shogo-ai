// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hono glue around `@a2a-js/sdk/server`'s framework-agnostic
 * `JsonRpcTransportHandler`. No Odin equivalent — `alignment-project-server`
 * gets this for free from the Python SDK's FastAPI integration
 * (`a2a-sdk[http-server]`); the JS SDK's transport adapters
 * (`@a2a-js/sdk/server/express`) need Express, which shogo doesn't use,
 * so this is the ~80-line Hono-specific adapter the plan called for.
 *
 * `JsonRpcTransportHandler.handle()` returns either:
 *   - a single `JSONRPCResponse` for `message/send`, `tasks/get`,
 *     `tasks/cancel`, `tasks/list`, push-notification-config methods →
 *     rendered as one `c.json(...)`.
 *   - an `AsyncGenerator<JSONRPCResponse>` for `message/stream` and
 *     `tasks/resubscribe` → rendered as an SSE `ReadableStream`, one
 *     `formatSSEEvent(response)` frame per yielded item, with periodic
 *     keep-alive comment frames (mirrors the pod's own
 *     `wrapStreamWithKeepalive` / the API's `proxy-keep-alive` pattern in
 *     `routes/project-chat.ts`) so intermediate proxies/load balancers
 *     don't time out an idle long-running task.
 */

import type { Context } from 'hono'
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type A2ARequestHandler,
} from '@a2a-js/sdk/server'
import { formatSSEErrorEvent, formatSSEEvent, SSE_HEADERS } from '@a2a-js/sdk'

/** How often to write an SSE keep-alive comment frame during a long-running stream. */
const KEEPALIVE_INTERVAL_MS = 15_000

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, void, undefined> {
  return !!value && typeof value === 'object' && typeof (value as any)[Symbol.asyncIterator] === 'function'
}

/**
 * Builds a `ServerCallContext` for one A2A request from the verified
 * caller identity and project (tenant) scope. `tenant` is what makes
 * `PrismaA2ATaskStore` (and the SDK's own `InMemoryTaskStore` /
 * `InMemoryPushNotificationStore`) scope data per-project for free.
 */
export function buildA2AServerCallContext(opts: { projectId: string; requestedVersion?: string }): ServerCallContext {
  return new ServerCallContext({
    tenant: opts.projectId,
    requestedVersion: opts.requestedVersion ?? '1.0',
  })
}

/**
 * Handles one JSON-RPC POST to `/a2a/projects/:projectId/rpc`. Reads the
 * body, dispatches through `JsonRpcTransportHandler`, and renders either a
 * single JSON response or an SSE stream depending on the method.
 */
export async function handleA2AJsonRpc(
  c: Context,
  requestHandler: A2ARequestHandler,
  context: ServerCallContext,
): Promise<Response> {
  const transport = new JsonRpcTransportHandler(requestHandler)

  let body: string | Record<string, unknown>
  try {
    body = await c.req.text()
  } catch (err: any) {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Failed to read request body: ${err?.message ?? err}` } },
      400,
    )
  }

  const result = await transport.handle(body, context)

  if (isAsyncGenerator(result)) {
    return sseResponseFromGenerator(result)
  }

  // Single JSON-RPC response. The envelope itself always carries its own
  // `error`/`result` per spec — HTTP status is 200 even for JSON-RPC-level
  // errors (transport-level failures only, which `transport.handle` doesn't
  // throw for since it catches and maps internally).
  return c.json(result, 200)
}

/**
 * Renders an `AsyncGenerator<JSONRPCResponse>` (the `message/stream` /
 * `tasks/resubscribe` path) as an SSE `Response`. Draining the generator
 * to completion also drains the underlying `ExecutionEventBus` subscription
 * — cancelling the stream (client disconnect) calls the generator's
 * `.return()` so `ExecutionEventQueue` unsubscribes promptly rather than
 * leaking a listener until the task naturally finishes.
 */
function sseResponseFromGenerator(gen: AsyncGenerator<unknown, void, undefined>): Response {
  const encoder = new TextEncoder()
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const keepaliveFrame = encoder.encode(': a2a-keep-alive\n\n')
      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(keepaliveFrame)
        } catch {
          clearInterval(keepaliveTimer)
        }
      }, KEEPALIVE_INTERVAL_MS)
    },
    async pull(controller) {
      try {
        const { value, done } = await gen.next()
        if (done) {
          clearInterval(keepaliveTimer)
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(formatSSEEvent(value)))
      } catch (err) {
        clearInterval(keepaliveTimer)
        try {
          controller.enqueue(encoder.encode(formatSSEErrorEvent({ code: -32603, message: err instanceof Error ? err.message : String(err) })))
        } catch {
          /* controller already closed */
        }
        controller.close()
      }
    },
    async cancel() {
      clearInterval(keepaliveTimer)
      try {
        await gen.return(undefined)
      } catch {
        /* generator already finished */
      }
    },
  })

  return new Response(stream, { headers: { ...SSE_HEADERS, 'X-Accel-Buffering': 'no' } })
}
