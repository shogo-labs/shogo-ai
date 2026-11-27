// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-600: a streamed delta re-renders its own row and nothing else.
 *
 * The channel used to hand `state.streaming` to `renderItem`, so every
 * `agent.delta` rebuilt every cell: 2 commits per delta and ~13 markdown
 * re-renders on a channel with one agent streaming, five times that with five.
 * Rows now subscribe to their own entry through `lib/team-chat-streaming`, so
 * the list's props do not change and a row that is not streaming does not
 * render.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { createElement, memo } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'
import { createStreamingStore, useStreamingEntry } from '../../../lib/team-chat-streaming'

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web', select: (s: any) => s.web ?? s.default },
    // The base shim does not walk `data`, and these tests are about which rows
    // render, so this list renders every item the way the real one mounts its
    // visible window.
    FlatList: ({ data, renderItem, keyExtractor, ListEmptyComponent, ListFooterComponent }: any) =>
      createElement(
        'div',
        null,
        (data ?? []).map((item: any, index: number) =>
          createElement(
            'div',
            { key: keyExtractor ? keyExtractor(item) : String(index) },
            renderItem({ item, index }),
          ),
        ),
        ListFooterComponent ?? null,
        (data ?? []).length === 0 ? (ListEmptyComponent ?? null) : null,
      ),
  }),
)

/** Every row render, by message id, in order. */
const rowRenders: string[] = []

mock.module('../MessageRow', () => ({
  // Memoised like the real row, and subscribed to its own live entry the same
  // way: the count must reflect a re-render React actually performed, not the
  // list's element identity.
  MessageRow: memo((props: any) => {
    rowRenders.push(props.message.id)
    const live = useStreamingEntry(props.message.id)
    return createElement('div', { 'data-message': props.message.id }, live?.text ?? props.message.text)
  }),
}))
mock.module('../AgentStatus', () => ({ StatusRunRow: () => null, ApprovalCardView: () => null, StatusCardView: () => null }))
mock.module('../DayDivider', () => ({ DayDivider: () => null }))
mock.module('@/components/ui/spinner', () => ({ Spinner: () => null }))

const { MessageList } = await import('../MessageList')

/** Derived from the clock the row labels read, so the seed cannot go stale. */
const seededAt = Date.now() - 30 * 60_000

const message = (id: string, text: string, seq: number) => ({
  id,
  conversationId: 'c1',
  seq,
  text,
  createdAt: new Date(seededAt + seq * 60_000).toISOString(),
  authorType: 'agent',
  authorUserId: null,
  authorName: 'Shogo Dev 1',
  agentStatus: 'running',
  blocks: [],
})

/** One names map for the whole file: a fresh `{}` would (rightly) re-render every row. */
const NAMES = {}
const messages = [message('m1', 'one', 1), message('m2', 'two', 2), message('m3', 'three', 3)]

const listState = (streaming: Record<string, any>) => ({ messages, hasMoreOlder: false, streaming })

function list(state: ReturnType<typeof listState>) {
  return createElement(MessageList as any, {
    state,
    loading: false,
    me: null,
    names: NAMES,
    canManage: false,
  })
}

describe('a streamed delta', () => {
  beforeEach(() => {
    rowRenders.length = 0
  })

  test("re-renders only the row it belongs to", () => {
    const first = list(listState({ m2: { text: 'tw', tool: null } }))
    const { rerender } = render(first)
    // Mounting with a live entry already present costs that one row a second
    // render, when the list publishes the map.
    expect([...new Set(rowRenders)].sort()).toEqual(['m1', 'm2', 'm3'])

    rowRenders.length = 0
    act(() => {
      rerender(list(listState({ m2: { text: 'two and more', tool: null } })))
    })

    expect([...new Set(rowRenders)]).toEqual(['m2'])
    expect(document.querySelector('[data-message="m2"]')?.textContent).toBe('two and more')
  })

  test('does not re-render any row when the list is scrolled or otherwise re-rendered', () => {
    const state = listState({ m2: { text: 'tw', tool: null } })
    const { rerender } = render(list(state))
    expect([...new Set(rowRenders)].sort()).toEqual(['m1', 'm2', 'm3'])

    rowRenders.length = 0
    act(() => {
      rerender(list(state))
    })
    expect(rowRenders).toEqual([])
  })
})

describe('the streaming store', () => {
  test('wakes only the ids whose entry changed', () => {
    const store = createStreamingStore()
    const woken: string[] = []
    store.subscribe('a', () => woken.push('a'))
    store.subscribe('b', () => woken.push('b'))

    const b = { text: '2', tool: null }
    store.set({ a: { text: '1', tool: null }, b })
    expect(woken.sort()).toEqual(['a', 'b'])

    // Same entry object for `b`, a new one for `a`: one stream, one wake.
    woken.length = 0
    store.set({ a: { text: '1 and more', tool: null }, b })
    expect(woken).toEqual(['a'])
    expect(store.get('b')).toBe(b)
  })

  test('a finished run clears its entry', () => {
    const store = createStreamingStore()
    store.set({ a: { text: '1', tool: null } })
    let woke = 0
    store.subscribe('a', () => woke++)
    store.set({})
    expect(woke).toBe(1)
    expect(store.get('a')).toBeUndefined()
  })
})
