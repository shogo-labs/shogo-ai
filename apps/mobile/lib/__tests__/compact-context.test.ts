// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-230: "Summarize now" has to reach the runtime that owns the session.
 *
 * A workspace-scoped chat lives on the workspace runtime, so its compact call
 * goes to `/api/workspaces/:workspaceId/chat/compact`. The project route used
 * to be the only one the dock could call, which on a workspace chat hit a
 * runtime that had never held the session and fell into an unbounded DB
 * re-summarize — the button spun with no result (Russell, staging).
 *
 *   bun test apps/mobile/lib/__tests__/compact-context.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildCompactUrl,
  COMPACT_REQUEST_TIMEOUT_MS,
  requestContextCompaction,
} from '../compact-context'
import { API_URL } from '../api-url'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

describe('buildCompactUrl', () => {
  test('a workspace chat targets the workspace route, even when pinned to a project', () => {
    expect(
      buildCompactUrl({ workspaceId: 'ws-1', projectId: 'proj-1', chatSessionId: 'chat-9' }),
    ).toBe(`${API_URL}/api/workspaces/ws-1/chat/compact`)
  })

  test('a landing/home workspace chat with no projectId still has a route', () => {
    expect(buildCompactUrl({ workspaceId: 'ws-1', chatSessionId: 'chat-9' })).toBe(
      `${API_URL}/api/workspaces/ws-1/chat/compact`,
    )
  })

  test('a project chat keeps the project route', () => {
    expect(buildCompactUrl({ projectId: 'proj-1', chatSessionId: 'chat-9' })).toBe(
      `${API_URL}/api/projects/proj-1/chat/compact`,
    )
  })

  test('ids are encoded', () => {
    expect(buildCompactUrl({ workspaceId: 'ws 1/x', chatSessionId: 'chat-9' })).toBe(
      `${API_URL}/api/workspaces/ws%201%2Fx/chat/compact`,
    )
  })

  test('no session, or no scope, is not addressable', () => {
    expect(buildCompactUrl({ workspaceId: 'ws-1' })).toBeNull()
    expect(buildCompactUrl({ chatSessionId: 'chat-9' })).toBeNull()
  })
})

describe('requestContextCompaction', () => {
  test('posts to the workspace route with the session header', async () => {
    const calls = stubFetch(200, { compacted: true, tokensBefore: 1000, tokensAfter: 200 })
    const result = await requestContextCompaction({ workspaceId: 'ws-1', chatSessionId: 'chat-9' })

    expect(calls[0]!.url).toBe(`${API_URL}/api/workspaces/ws-1/chat/compact`)
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>)['X-Chat-Session-Id']).toBe('chat-9')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ chatSessionId: 'chat-9' })
    expect(result.compacted).toBe(true)
    expect(result.tokensAfter).toBe(200)
  })

  test('a live turn answers queued, and the reason is surfaced', async () => {
    stubFetch(202, {
      compacted: false,
      queued: true,
      status: 'summarizing',
      reason: 'turn in progress',
    })
    const result = await requestContextCompaction({ workspaceId: 'ws-1', chatSessionId: 'chat-9' })
    expect(result.compacted).toBe(false)
    expect(result.queued).toBe(true)
    expect(result.reason).toBe('turn in progress')
  })

  test('an unanswered request times out instead of spinning forever', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch

    const result = await requestContextCompaction(
      { workspaceId: 'ws-1', chatSessionId: 'chat-9' },
      { timeoutMs: 10 },
    )
    expect(result.compacted).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.queued).toBe(true)
    expect(result.reason).toContain('Still summarizing')
  })

  test('the default budget is bounded', () => {
    expect(COMPACT_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})
