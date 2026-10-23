// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-125 acceptance — §4b/AC5, what a remote tool call does when the target
 * pod resolved but is not (yet) listening.
 *
 * The report had remote `exec` answering a hard 502. `wakeRemoteTarget` returns
 * as soon as it has a URL, which on metal can be before the guest accepts
 * connections, so the very first `fetch` throws `ECONNREFUSED` — and on `main`
 * that became `502 agent_call_failed` with no retry.
 *
 * The contract this file pins:
 *   - a read-only tool is retried exactly once and returns the result;
 *   - a write is never replayed, and answers 503 `target_not_ready` with a
 *     `Retry-After` because the work may not have run;
 *   - a chat/pipeline hop keeps its 502 `agent_call_failed` (unchanged
 *     contract, which `agent-call.service.test.ts` also relies on).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  callProjectRemoteTool,
  forwardToProjectRuntime,
  setProjectRuntimeUrlResolver,
} from '../services/agent-call.service'

const realFetch = globalThis.fetch
const TARGET = 'http://10.8.0.2:8080/ws%3Aproj%3Ap1'

let attempts: Array<{ url: string; token: string | null }> = []

/** First `failTimes` calls reject like a socket that is not listening yet. */
function podThatIsWarming(failTimes: number, result: unknown = { ok: true, result: { content: 'hello' } }) {
  let calls = 0
  globalThis.fetch = (async (url: string, init: any) => {
    calls += 1
    attempts.push({ url: String(url), token: new Headers(init?.headers).get('x-runtime-token') })
    if (calls <= failTimes) {
      throw Object.assign(new Error('connect ECONNREFUSED 10.8.0.2:8080'), { code: 'ECONNREFUSED' })
    }
    return new Response(JSON.stringify(result), { status: 200 })
  }) as unknown as typeof fetch
  return () => calls
}

beforeEach(() => {
  attempts = []
  setProjectRuntimeUrlResolver(async () => 'http://10.8.0.2:8080/ws%3Aproj%3Ap1')
})

afterEach(() => {
  globalThis.fetch = realFetch
  setProjectRuntimeUrlResolver(null)
})

describe('SHO-125 AC5 — a cold target is retried once for reads, never for writes', () => {
  test('read_file survives one ECONNREFUSED and returns the read result', async () => {
    const calls = podThatIsWarming(1)

    const outcome = await callProjectRemoteTool({} as any, 'p1', 'ws-1', {
      tool: 'read_file',
      args: { path: 'MEMORY.md' },
      callerProjectId: 'p0',
    })

    expect(outcome.status).toBe(200)
    expect(outcome.body).toEqual({ ok: true, result: { content: 'hello' } })
    // Exactly one replay: no tool is retried twice.
    expect(calls()).toBe(2)
  })

  test('a write is NOT replayed and answers 503 target_not_ready + Retry-After', async () => {
    const calls = podThatIsWarming(1)

    const outcome = await callProjectRemoteTool({} as any, 'p1', 'ws-1', {
      tool: 'write_file',
      args: { path: 'notes.txt', content: 'x' },
      callerProjectId: 'p0',
    })

    expect(calls()).toBe(1)
    expect(outcome.status).toBe(503)
    expect(outcome.body.error.code).toBe('target_not_ready')
    expect(outcome.body.error.retryAfterSeconds).toBe(2)
    // In the body as well as the header: a keepalive response has already sent
    // its status line, so a header alone cannot reach those callers.
    expect(outcome.headers?.['Retry-After']).toBe('2')
    // The agent must be told the write may not have run.
    expect(outcome.body.error.message).toContain('may not have run')
  })

  test('exec is treated as a write (never replayed)', async () => {
    const calls = podThatIsWarming(1)

    const outcome = await callProjectRemoteTool({} as any, 'p1', 'ws-1', {
      tool: 'exec',
      args: { command: 'ls' },
      callerProjectId: 'p0',
    })

    expect(calls()).toBe(1)
    expect(outcome.status).toBe(503)
  })

  test('a chat/pipeline hop keeps its 502 agent_call_failed', async () => {
    podThatIsWarming(1)

    const outcome = await forwardToProjectRuntime({} as any, 'p1', 'ws-1', '/agent/call', '{}', {
      timeoutMs: 5_000,
    })

    expect(outcome.status).toBe(502)
    expect(outcome.body.error.code).toBe('agent_call_failed')
  })

  test('a timeout stays a 504 with the tool-specific message', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })
    }) as unknown as typeof fetch

    const outcome = await callProjectRemoteTool({} as any, 'p1', 'ws-1', {
      tool: 'exec',
      args: { command: 'sleep 999' },
      callerProjectId: 'p0',
    })

    expect(outcome.status).toBe(504)
    expect(outcome.body.error.code).toBe('agent_call_timeout')
    expect(outcome.body.error.message).toContain('did not finish exec')
  })
})

describe('SHO-125 §4b — the hop presents the workspace token, not the project token', () => {
  test('the remote call carries wrt_v1_<workspaceId>, the token a project pod now holds', async () => {
    podThatIsWarming(0)

    await callProjectRemoteTool({} as any, 'p1', 'ws-1', {
      tool: 'read_file',
      args: { path: 'MEMORY.md' },
      callerProjectId: 'p0',
    })

    const { deriveWorkspaceRuntimeToken } = await import('../lib/workspace-runtime-token')
    expect(attempts).toHaveLength(1)
    expect(attempts[0].url).toBe(`${TARGET}/agent/remote/tool`)
    expect(attempts[0].token).toBe(deriveWorkspaceRuntimeToken('ws-1'))
    expect(attempts[0].token?.startsWith('wrt_v1_')).toBe(true)
  })
})
