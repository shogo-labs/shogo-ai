// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drafts sync across devices through `draft.changed`, which the server also
 * echoes back to the device that saved. A late echo of an earlier save must
 * not overwrite a newer local draft — most visibly, the clear on send.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

const puts: Array<{ conversationId: string; text: string }> = []
let emit: (event: any) => void = () => {}

const realApi = await import('../../lib/team-chat-api')
const realConnection = await import('../../lib/team-chat-connection')

mock.module('../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({
    drafts: async () => [],
    putDraft: async (conversationId: string, text: string) => {
      puts.push({ conversationId, text })
    },
  }),
}))
mock.module('../../lib/team-chat-connection', () => ({
  ...realConnection,
  useTeamChatEvents: (_workspaceId: string, onEvent: (event: any) => void) => {
    emit = onEvent
    return 'open'
  },
}))

const { _resetDraftsForTests, useDraft, useDraftsFeed } = await import('../useChatItems')

const echo = (text: string, conversationId = 'c-1') =>
  act(() => emit({ type: 'draft.changed', draft: { conversationId, threadRootId: null, text } }))

function renderDraft() {
  return renderHook(() => {
    useDraftsFeed('ws-1')
    return useDraft('c-1')
  })
}

beforeEach(() => {
  _resetDraftsForTests()
  puts.length = 0
})
afterEach(cleanup)

describe('draft sync', () => {
  test('a late echo of the typed text does not undo the clear on send', async () => {
    const { result } = renderDraft()
    act(() => result.current.save('hello world', { immediate: true }))
    act(() => result.current.save('', { immediate: true }))
    expect(result.current.stored).toBe('')

    echo('hello world')
    expect(result.current.stored).toBe('')

    echo('')
    expect(result.current.stored).toBe('')
    expect(puts.map((p) => p.text)).toEqual(['hello world', ''])
  })

  test('an echo older than the latest keystroke is ignored while typing', async () => {
    const { result } = renderDraft()
    act(() => result.current.save('hel'))
    act(() => result.current.save('hello'))
    echo('hel')
    // The echo was rejected: the store never adopts the older text.
    expect(result.current.stored).toBe('')
    // The store is told once the debounced write goes out, not per keystroke
    // (SHO-314) — then it holds the latest text.
    await act(async () => {
      await Bun.sleep(900)
    })
    expect(result.current.stored).toBe('hello')
  })

  test('typing does not publish to the shared store on every keystroke', async () => {
    const { result } = renderDraft()
    act(() => {
      for (const text of ['h', 'he', 'hel', 'hell', 'hello']) result.current.save(text)
    })
    // Nothing published yet: a per-key publish is what re-rendered every
    // `useSyncExternalStore` subscriber (the conversation screen) per character.
    expect(result.current.stored).toBe('')
    await act(async () => {
      await Bun.sleep(900)
    })
    expect(result.current.stored).toBe('hello')
    expect(puts.map((p) => p.text)).toEqual(['hello'])
  })

  test('drafts from other devices still apply when nothing was saved locally', () => {
    const { result } = renderDraft()
    echo('from my laptop')
    expect(result.current.stored).toBe('from my laptop')
  })

  test('a local save only guards its own conversation', () => {
    const { result } = renderHook(() => {
      useDraftsFeed('ws-1')
      return { mine: useDraft('c-1'), other: useDraft('c-2') }
    })
    act(() => result.current.mine.save('', { immediate: true }))
    echo('typed elsewhere', 'c-2')
    expect(result.current.other.stored).toBe('typed elsewhere')
  })
})
