// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `RunPeekHover` passes `onDone` as an inline arrow, so it is a new function on
 * every render. When the hook keyed its fetch on that callback, every render
 * restarted the fetch, set `loading`, and rendered again: React stopped it with
 * "Maximum update depth exceeded" and the peek card never stayed open (the
 * SHO-466 e2e failed on every PR). The hook must fetch once per open, however
 * often its caller re-renders.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

let peekCalls = 0
let peekAnswer: unknown = null

const realApi = await import('../../lib/api')
const realDomain = await import('../../contexts/domain')

mock.module('../../lib/api', () => ({
  ...realApi,
  api: {
    ...realApi.api,
    getActiveChatPeek: async () => {
      peekCalls += 1
      return peekAnswer
    },
  },
}))

// One client for every render, as the real context provides.
const http = {}
mock.module('../../contexts/domain', () => ({
  ...realDomain,
  useDomainHttp: () => http,
}))

const { useRunPeek } = await import('../useRunPeek')

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 60)))

const READY = {
  chatSessionId: 'chat-1',
  turnId: 'turn-1',
  title: 'A run',
  agentName: 'Dev',
  startedAt: new Date().toISOString(),
  where: { kind: 'public', conversationId: 'c-1', conversationName: 'dev', threadRootId: null },
  card: null,
  trigger: null,
  reply: null,
  hidden: false,
}

beforeEach(() => {
  peekCalls = 0
  peekAnswer = READY
})
afterEach(() => cleanup())

describe('useRunPeek', () => {
  test('a new inline onDone on every render does not restart the fetch', async () => {
    let renders = 0
    const { result, rerender } = renderHook(
      ({ turnId }: { turnId: string }) => {
        renders += 1
        return useRunPeek({
          open: true,
          workspaceId: 'ws-1',
          chatSessionId: 'chat-1',
          turnId,
          onDone: () => {},
        })
      },
      { initialProps: { turnId: 'turn-stable' } },
    )
    await settle()
    rerender({ turnId: 'turn-stable' })
    rerender({ turnId: 'turn-stable' })
    await settle()

    expect(result.current.status).toBe('ready')
    expect(peekCalls).toBe(1)
    expect(renders).toBeLessThan(10)
  })

  test('the latest onDone still runs when the turn has ended', async () => {
    peekAnswer = null
    const calls: string[] = []
    const { rerender } = renderHook(
      ({ label }: { label: string }) =>
        useRunPeek({
          open: true,
          workspaceId: 'ws-1',
          chatSessionId: 'chat-ended',
          turnId: 'turn-ended',
          onDone: () => calls.push(label),
        }),
      { initialProps: { label: 'first' } },
    )
    rerender({ label: 'second' })
    await settle()

    expect(calls).toEqual(['second'])
  })
})
