// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-96 acceptance, app side: the summarization the runtime performed has to
 * be *visible* and *actionable* in the app.
 *
 * Locks:
 *   - a persisted `data-context-summarized` part survives part extraction and
 *     renders in its place among the text parts (that is what makes it show in
 *     the chat history after a reload, not just live),
 *   - the divider states the numbers the runtime reported (412k → 38k, folded
 *     count, trigger),
 *   - the dock's manual trigger reports the API's honest answer instead of
 *     pretending a no-op succeeded ("nothing to compact", queued, failure).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import * as React from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { extractOrderedParts } from '../messageParts'
import { ContextCompactionDivider } from '../ContextCompactionDivider'

mock.module('lucide-react-native', () => ({
  Scissors: (props: Record<string, unknown>) => React.createElement('span', { 'data-icon': 'scissors', ...props }),
}))

function asMessage(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as unknown as UIMessage
}

const SUMMARY_PART = {
  type: 'data-context-summarized',
  id: 'ctx-1',
  data: { trigger: 'auto', tokensBefore: 412_000, tokensAfter: 38_000, messagesBefore: 121, messagesAfter: 6 },
}

describe('SHO-96 app: the compaction is visible in the transcript', () => {
  test('a persisted summary part is kept, in order, among the text parts', () => {
    const parts = extractOrderedParts(
      asMessage([
        { type: 'text', text: 'before the rewrite', state: 'done' },
        SUMMARY_PART,
        { type: 'text', text: 'after the rewrite', state: 'done' },
      ]),
    )
    expect(parts.map((p) => p.type)).toEqual(['text', 'compaction', 'text'])
    expect(parts[1]).toMatchObject({
      type: 'compaction',
      trigger: 'auto',
      tokensBefore: 412_000,
      tokensAfter: 38_000,
      messagesBefore: 121,
      messagesAfter: 6,
    })
  })

  test('the divider states what happened', () => {
    render(<ContextCompactionDivider part={SUMMARY_PART.data as never} />)
    expect(screen.getByText(/Context summarized/)).toBeTruthy()
    expect(screen.getByText(/412k/)).toBeTruthy()
    expect(screen.getByText(/38k/)).toBeTruthy()
    expect(screen.getByText(/115 messages folded/)).toBeTruthy()
    expect(screen.getByText(/\(auto\)/)).toBeTruthy()
  })
})

describe('SHO-96 app: the dock can trigger it manually', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  function stubFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return calls
  }

  test('an idle compaction reports the numbers the ring needs', async () => {
    const calls = stubFetch(200, { compacted: true, tokensBefore: 412_000, tokensAfter: 38_000 })
    const { requestContextCompaction } = await import('../../../../lib/compact-context')
    const result = await requestContextCompaction('proj-1', 'chat-9')
    expect(result).toEqual({ compacted: true, queued: false, reason: undefined, tokensBefore: 412_000, tokensAfter: 38_000 })
    expect(calls[0].url).toContain('/api/projects/proj-1/chat/compact')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>)['X-Chat-Session-Id']).toBe('chat-9')
  })

  test('a live turn reports queued, not compacted', async () => {
    stubFetch(202, { compacted: false, queued: true, reason: 'turn in progress' })
    const { requestContextCompaction } = await import('../../../../lib/compact-context')
    const result = await requestContextCompaction('proj-1', 'chat-9')
    expect(result.compacted).toBe(false)
    expect(result.queued).toBe(true)
    expect(result.reason).toBe('turn in progress')
  })

  test('"nothing to compact" is surfaced, never swallowed', async () => {
    stubFetch(200, { compacted: false, reason: 'nothing to compact' })
    const { requestContextCompaction } = await import('../../../../lib/compact-context')
    const result = await requestContextCompaction('proj-1', 'chat-9')
    expect(result.compacted).toBe(false)
    expect(result.reason).toBe('nothing to compact')
  })

  test('a failure reads the API error rather than a generic message', async () => {
    stubFetch(500, { error: 'runtime unreachable' })
    const { requestContextCompaction } = await import('../../../../lib/compact-context')
    const result = await requestContextCompaction('proj-1', 'chat-9')
    expect(result.compacted).toBe(false)
    expect(result.reason).toBe('runtime unreachable')
  })
})
