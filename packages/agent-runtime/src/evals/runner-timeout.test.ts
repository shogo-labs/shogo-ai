// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Eval runner timeout/abort policy tests.
 *
 * Locks in the contract that:
 * 1. A self-imposed `timeoutMs` cap aborts the in-flight `/agent/chat` fetch
 *    and posts to `/agent/stop` so the in-VM agent stops iterating (instead
 *    of letting the eval suite retry the request 8 times and burn 40 min on
 *    one stuck turn — see notes in `runner.ts::sendTurn`).
 * 2. After a timeout we return a synthetic empty `ParsedAgentResponse`
 *    rather than throwing — scoring + workspace runtime checks should still
 *    run so the eval reports a partial signal instead of disappearing.
 * 3. Transient HTTP 5xx / 429 errors retry up to a small bound (3) — they
 *    do NOT inherit the timeout's "fail fast" path.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { sendTurn, type EvalRunnerConfig } from './runner'

interface FakeServer {
  url: string
  stopHits: number
  chatHits: number
  close: () => void
  setHandler: (h: (req: Request) => Response | Promise<Response>) => void
}

function startFakeServer(): FakeServer {
  const state: FakeServer = {
    url: '',
    stopHits: 0,
    chatHits: 0,
    close: () => {},
    setHandler: () => {},
  }
  let handler: (req: Request) => Response | Promise<Response> = () =>
    new Response('not configured', { status: 500 })
  state.setHandler = (h) => { handler = h }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname.endsWith('/agent/stop')) {
        state.stopHits++
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (u.pathname.endsWith('/agent/chat')) {
        state.chatHits++
        return handler(req)
      }
      return new Response('not found', { status: 404 })
    },
  })
  state.url = `http://localhost:${server.port}`
  state.close = () => server.stop(true)
  return state
}

const baseConfig = (server: FakeServer, overrides: Partial<EvalRunnerConfig> = {}): EvalRunnerConfig => ({
  agentEndpoint: `${server.url}/agent/chat`,
  timeoutMs: 200,
  verbose: false,
  workspaceDir: '/tmp/runner-timeout-test',
  ...overrides,
})

describe('sendTurn timeout/abort policy', () => {
  let server: FakeServer

  beforeAll(() => {
    server = startFakeServer()
  })

  afterAll(() => {
    server.close()
  })

  test('self-imposed timeout calls /agent/stop and returns partial (no retry)', async () => {
    server.stopHits = 0
    server.chatHits = 0
    // Server holds the request open past the per-turn cap; the sentinel that
    // the cap fired is "we hit /agent/stop exactly once and only attempted
    // /agent/chat once".
    server.setHandler(() => new Promise<Response>(() => { /* never resolves */ }))

    const start = Date.now()
    const result = await sendTurn(
      [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      baseConfig(server, { timeoutMs: 150 }),
    )
    const elapsed = Date.now() - start

    expect(server.chatHits).toBe(1)
    expect(server.stopHits).toBe(1)
    expect(result.text).toContain('150ms cap')
    expect(result.toolCalls).toEqual([])
    // Old code retried 8× → ≥ 8 × 150ms. Cap budget at 4× to catch regressions.
    expect(elapsed).toBeLessThan(150 * 4)
  })

  test('transient 502 retries then succeeds without calling /agent/stop', async () => {
    server.chatHits = 0
    server.stopHits = 0
    let calls = 0
    server.setHandler(() => {
      calls++
      if (calls < 3) return new Response('bad gateway', { status: 502 })
      // Minimal SSE the parser tolerates: one finish frame then [DONE].
      return new Response('data: {}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const result = await sendTurn(
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      baseConfig(server, { timeoutMs: 30_000 }),
    )

    expect(server.chatHits).toBe(3)
    expect(server.stopHits).toBe(0)
    expect(result.toolCalls).toEqual([])
    // No partial-cap sentinel — this was a clean success after retries.
    expect(result.text).not.toContain('cap]')
  }, 30_000)

  test('persistent 502 stops at the small retry bound (≤ 3 attempts)', async () => {
    server.chatHits = 0
    server.stopHits = 0
    server.setHandler(() => new Response('still bad', { status: 502 }))

    await expect(
      sendTurn(
        [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        baseConfig(server, { timeoutMs: 30_000 }),
      ),
    ).rejects.toThrow(/502/)

    // The previous 8-retry policy would have hit the server 8 times here.
    expect(server.chatHits).toBeLessThanOrEqual(3)
    expect(server.stopHits).toBe(0)
  }, 30_000)
})
