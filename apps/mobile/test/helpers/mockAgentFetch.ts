// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Helpers for mocking the project's `agent-fetch` shim from tests.
 *
 * The actual swap happens in `apps/mobile/test/testing-library.ts`,
 * which `mock.module()`s `lib/agent-fetch` to delegate to a global
 * handler stashed at `globalThis.__shogoAgentFetchHandler`. This avoids
 * transitively loading expo / better-auth / RN-secure-store.
 *
 *   `installAgentFetchMock(handler)` — replace the global handler.
 *   `restoreAgentFetch()`            — reset to the throwing default.
 *   `recordedAgentFetch()`           — handler that records calls and
 *                                      pulls Response objects from a queue.
 *
 * Usage:
 *   ```ts
 *   import { installAgentFetchMock, recordedAgentFetch } from '...'
 *   import { streamingResponse } from '../../../../test/helpers/streamingResponse'
 *
 *   const fetcher = recordedAgentFetch()
 *   fetcher.queue(streamingResponse(['line1\n']))
 *   installAgentFetchMock(fetcher.handler)
 *   ```
 */

type AgentFetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

const KEY = '__shogoAgentFetchHandler'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any

const defaultHandler: AgentFetchHandler = async () => {
  throw new Error('agentFetch called without a test handler installed')
}

export function installAgentFetchMock(handler: AgentFetchHandler): void {
  g[KEY] = handler
}

export function restoreAgentFetch(): void {
  g[KEY] = defaultHandler
}

export type ResponseFactory = Response | (() => Response | Promise<Response>)

export interface RecordedAgentFetch {
  handler: AgentFetchHandler
  calls: Array<{ url: string; init?: RequestInit }>
  /**
   * Queue a response for the *next* call whose URL matches `pattern`.
   * Useful when several fetches share a route (multiple exec calls).
   */
  queue: (pattern: string | RegExp, response: ResponseFactory) => void
  /**
   * Default response for a route — returned whenever the queue for that
   * route is empty. Use for endpoints that get hit repeatedly with the
   * same payload (e.g. `/terminal/commands`).
   */
  setRoute: (pattern: string | RegExp, response: ResponseFactory) => void
  /**
   * Catch-all fallback when no route matches. Throws if missing.
   */
  setCatchAll: (response: ResponseFactory) => void
}

interface Route {
  pattern: string | RegExp
  queue: ResponseFactory[]
  fallback: ResponseFactory | null
}

function matches(pattern: string | RegExp, url: string): boolean {
  return typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
}

async function resolveResponse(r: ResponseFactory): Promise<Response> {
  return typeof r === 'function' ? Promise.resolve(r()) : r.clone()
}

/**
 * Connect `init.signal` to the response body so `reader.read()` throws
 * `AbortError` when the controller aborts — matching the contract real
 * `fetch()` provides. Without this, mocked streams keep delivering
 * chunks even after the SUT cancels, and tests can't observe the
 * cancellation path.
 */
function wireAbort(res: Response, signal: AbortSignal | null | undefined): Response {
  if (!signal || !res.body) return res
  if (signal.aborted) {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
  const upstream = res.body.getReader()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        controller.error(err)
        upstream.cancel().catch(() => {})
      }
      signal.addEventListener('abort', onAbort, { once: true })
      ;(async () => {
        try {
          while (!signal.aborted) {
            const { done, value } = await upstream.read()
            if (done) {
              controller.close()
              return
            }
            controller.enqueue(value)
          }
        } catch (err) {
          controller.error(err)
        }
      })()
    },
  })
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

export function recordedAgentFetch(): RecordedAgentFetch {
  const calls: RecordedAgentFetch['calls'] = []
  const routes: Route[] = []
  let catchAll: ResponseFactory | null = null

  function findOrCreate(pattern: string | RegExp): Route {
    let r = routes.find((x) => x.pattern === pattern)
    if (!r) {
      r = { pattern, queue: [], fallback: null }
      routes.push(r)
    }
    return r
  }

  const handler: AgentFetchHandler = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    calls.push({ url, init })
    for (const route of routes) {
      if (matches(route.pattern, url)) {
        const next = route.queue.shift() ?? route.fallback
        if (next) return wireAbort(await resolveResponse(next), init?.signal)
      }
    }
    if (catchAll) return wireAbort(await resolveResponse(catchAll), init?.signal)
    throw new Error(
      `recordedAgentFetch: no route for ${init?.method ?? 'GET'} ${url}`,
    )
  }

  return {
    handler,
    calls,
    queue: (pattern, response) => {
      findOrCreate(pattern).queue.push(response)
    },
    setRoute: (pattern, response) => {
      findOrCreate(pattern).fallback = response
    },
    setCatchAll: (response) => {
      catchAll = response
    },
  }
}
