// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-538 — a GET that arrives while a hosted workspace's desktop is waking is
 * tried again, once the host says it is up.
 *
 * The cloud answers `503 host_connecting` / `504 host_runtime_starting` instead
 * of holding the request past Cloudflare's edge, so the retry lives here and
 * hangs off the one place every agent-proxy loader goes through (`agentFetch`).
 * Only a request that changes nothing may be sent twice, and the last response
 * is always handed back so the caller still sees the real error.
 *
 *   bun test apps/mobile/lib/__tests__/agent-retry.test.ts
 */

import { beforeEach, describe, expect, test } from 'bun:test'

// The pure module: no react-native, no session cookie, nothing the app's test
// preload swaps out (it mocks `lib/agent-fetch` wholesale).
import { fetchWithWakeRetry, agentErrorMessage, isWakeRetryable } from '../agent-retry'

const wakeRefusal = (code: string, retryAfterSeconds = 0, retryable = true) =>
  new Response(
    JSON.stringify({
      error: { code, message: 'Studio Mac is online but its connection is still opening', retryable, retryAfterSeconds },
    }),
    { status: 503, headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) } },
  )

const plans = () =>
  new Response(JSON.stringify({ plans: [{ filename: 'launch.plan.md' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

let calls: number
let answers: Array<() => Response>

function send() {
  calls += 1
  const answer = answers[Math.min(calls - 1, answers.length - 1)]
  return Promise.resolve(answer())
}

beforeEach(() => {
  calls = 0
  answers = []
})

describe('isWakeRetryable', () => {
  test('only a request that changes nothing may be sent twice', () => {
    expect(isWakeRetryable(undefined)).toBe(true)
    expect(isWakeRetryable('GET')).toBe(true)
    expect(isWakeRetryable('get')).toBe(true)
    expect(isWakeRetryable('HEAD')).toBe(true)
    expect(isWakeRetryable('POST')).toBe(false)
    expect(isWakeRetryable('PATCH')).toBe(false)
    expect(isWakeRetryable('DELETE')).toBe(false)
  })
})

describe('fetchWithWakeRetry', () => {
  test('a GET refused with host_connecting resolves with the answer on the retry', async () => {
    answers = [() => wakeRefusal('host_connecting'), plans]

    const res = await fetchWithWakeRetry(send)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ plans: [{ filename: 'launch.plan.md' }] })
    expect(calls).toBe(2)
  })

  test('a 504 host_runtime_starting is retried too', async () => {
    answers = [
      () =>
        new Response(JSON.stringify({ error: { code: 'host_runtime_starting', retryable: true, retryAfterSeconds: 0 } }), {
          status: 504,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        }),
      plans,
    ]

    const res = await fetchWithWakeRetry(send)

    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  test('a refusal that is not retryable is returned as-is, and its body is still readable', async () => {
    answers = [() => wakeRefusal('host_offline', 0, false)]

    const res = await fetchWithWakeRetry(send)

    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('host_offline')
    expect(calls).toBe(1)
  })

  test('an edge HTML page is never parsed as a refusal, and never retried', async () => {
    answers = [() => new Response('<html>error code: 524</html>', { status: 503 })]

    const res = await fetchWithWakeRetry(send)

    expect(res.status).toBe(503)
    expect(await res.text()).toContain('524')
    expect(calls).toBe(1)
  })

  test('the total cap holds: a wait longer than what is left does not start', async () => {
    // The host asks for 15s, the budget is 1s — asking again would pass the cap.
    answers = [() => wakeRefusal('host_connecting', 15)]

    const started = Date.now()
    const res = await fetchWithWakeRetry(send, { totalMs: 1_000 })

    expect(res.status).toBe(503)
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('each wait is capped, so a host asking for a minute does not stall the caller', async () => {
    answers = [() => wakeRefusal('host_connecting', 60), plans]

    const started = Date.now()
    const res = await fetchWithWakeRetry(send, { totalMs: 5_000, maxWaitMs: 10 })

    expect(res.status).toBe(200)
    expect(calls).toBe(2)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('agentErrorMessage', () => {
  test('reads the cloud refusal out of an AgentClient failure', () => {
    const err = new Error(
      'Agent API 503: {"error":{"code":"host_connecting","message":"Studio Mac is online (seen 20s ago) but its connection is still opening; try again in ~15s","retryable":true}}',
    )
    expect(agentErrorMessage(err)).toBe(
      'Studio Mac is online (seen 20s ago) but its connection is still opening; try again in ~15s',
    )
  })

  test('a raw edge page is not a message: the caller keeps its own wording', () => {
    expect(agentErrorMessage(new Error('Agent API 524: <html><body>error code: 524</body></html>'))).toBeNull()
  })

  test('a plain failure has no message to lift', () => {
    expect(agentErrorMessage(new Error('Network request failed'))).toBeNull()
  })
})
