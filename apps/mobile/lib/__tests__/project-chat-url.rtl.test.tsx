// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project page keeps the open chat's id in `?chatSessionId=` so a chat
 * link is shareable and survives a reload. These tests drive the same wiring
 * the layout uses — the sidebar's `chatSessionEvents.requestSelect` subscriber
 * feeding chat state into the mirror hook — and assert what reaches
 * `router.setParams`, plus that a param the mirror wrote is not treated as a
 * deep link (the pinned/last-chat guards still get to run).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { chatSessionEvents } from '../chat-session-events'
import {
  CHAT_URL_ONE_SHOT_PARAMS,
  useProjectChatUrlMirror,
  type ChatUrlParams,
  type ChatUrlScope,
} from '../project-chat-url'

const PROJECT_ID = 'proj-1'

afterEach(() => {
  cleanup()
})

interface HarnessOptions {
  initialChatSessionId?: string | null
  initialParam?: string
  oneShotPresent?: boolean
  chatScope?: ChatUrlScope
  initialPropsSessionId?: string | null
  enabled?: boolean
}

function useLayoutHarness(options: HarnessOptions = {}) {
  const [chatSessionId, setChatSessionId] = useState<string | null>(
    options.initialChatSessionId ?? options.initialParam ?? null
  )
  const [currentParam, setCurrentParam] = useState<string | undefined>(
    options.initialParam
  )
  const [oneShotPresent, setOneShotPresent] = useState(
    options.oneShotPresent ?? false
  )
  const writes = useRef<ChatUrlParams[]>([])

  // Stand-in for `router.setParams`: replaces the current route params (no
  // history entry) exactly as React Navigation does.
  const setParams = useCallback((next: ChatUrlParams) => {
    writes.current.push(next)
    setCurrentParam(next.chatSessionId)
    if (CHAT_URL_ONE_SHOT_PARAMS.some((key) => key in next)) {
      setOneShotPresent(false)
    }
  }, [])

  const { deepLinkedChatSessionId } = useProjectChatUrlMirror({
    chatSessionId,
    currentParam,
    chatScope: options.chatScope ?? 'project',
    initialPropsSessionId: options.initialPropsSessionId ?? null,
    oneShotPresent,
    enabled: options.enabled ?? true,
    setParams,
  })

  // The layout's sidebar subscriber: switch chats in place.
  useEffect(
    () =>
      chatSessionEvents.subscribeSelect(({ projectId, sessionId }) => {
        if (projectId !== PROJECT_ID) return
        setChatSessionId(sessionId)
      }),
    []
  )

  return {
    chatSessionId,
    currentParam,
    writes: writes.current,
    deepLinkedChatSessionId,
    setChatSessionId,
  }
}

describe('useProjectChatUrlMirror', () => {
  test('names the chat in the URL when the sidebar switches chats', () => {
    const { result } = renderHook(() => useLayoutHarness())
    expect(result.current.writes).toHaveLength(0)

    act(() => {
      chatSessionEvents.requestSelect({
        projectId: PROJECT_ID,
        sessionId: 'chat-b',
      })
    })

    expect(result.current.writes.at(-1)?.chatSessionId).toBe('chat-b')
    expect(result.current.currentParam).toBe('chat-b')
    // Our own write is not a deep link.
    expect(result.current.deepLinkedChatSessionId).toBeUndefined()
  })

  test('"+ new chat" names the new chat and drops the arrival-only params', () => {
    const { result } = renderHook(() =>
      useLayoutHarness({ oneShotPresent: true })
    )
    // Nothing to mirror while the arrival has no chat yet, and nothing is
    // written over the pending `newChat` request.
    expect(result.current.writes).toHaveLength(0)

    act(() => {
      result.current.setChatSessionId('chat-new')
    })

    const write = result.current.writes.at(-1)
    expect(write?.chatSessionId).toBe('chat-new')
    expect(write?.newChat).toBeUndefined()
    expect(write?.newChatNonce).toBeUndefined()
    expect(write?.initialMessage).toBeUndefined()
    expect(result.current.currentParam).toBe('chat-new')
  })

  test('closing the last tab drops the param', () => {
    const { result } = renderHook(() =>
      useLayoutHarness({ initialParam: 'chat-a' })
    )

    act(() => {
      result.current.setChatSessionId(null)
    })

    expect(result.current.writes.at(-1)).toEqual({
      chatSessionId: undefined,
      chatScope: undefined,
    })
    expect(result.current.currentParam).toBeUndefined()
  })

  test('a real deep link stays a deep link until the viewer switches chats', () => {
    const { result } = renderHook(() =>
      useLayoutHarness({ initialParam: 'chat-a' })
    )

    // Never re-written, so the pinned/last-chat guards keep deferring to it.
    expect(result.current.writes).toHaveLength(0)
    expect(result.current.deepLinkedChatSessionId).toBe('chat-a')

    act(() => {
      chatSessionEvents.requestSelect({
        projectId: PROJECT_ID,
        sessionId: 'chat-b',
      })
    })

    expect(result.current.currentParam).toBe('chat-b')
    expect(result.current.deepLinkedChatSessionId).toBeUndefined()
  })

  test('a mirrored id does not block the pinned promotion', () => {
    // The stale last-session cache is mirrored before the pinned resolve
    // returns; the promotion still has to see "no deep link" and correct it.
    const { result } = renderHook(() => useLayoutHarness())

    act(() => {
      result.current.setChatSessionId('stale-cached-chat')
    })

    expect(result.current.currentParam).toBe('stale-cached-chat')
    expect(result.current.deepLinkedChatSessionId).toBeUndefined()

    act(() => {
      result.current.setChatSessionId('pinned-chat')
    })

    expect(result.current.currentParam).toBe('pinned-chat')
    expect(result.current.deepLinkedChatSessionId).toBeUndefined()
  })

  test('keeps workspace scope for the hand-off chat only', () => {
    const { result } = renderHook(() =>
      useLayoutHarness({
        initialParam: 'chat-a',
        chatScope: 'workspace',
        initialPropsSessionId: 'chat-a',
      })
    )
    expect(result.current.writes).toHaveLength(0)

    act(() => {
      chatSessionEvents.requestSelect({
        projectId: PROJECT_ID,
        sessionId: 'chat-b',
      })
    })

    expect(result.current.writes.at(-1)?.chatScope).toBeUndefined()
  })

  test('never writes for the IDE embed or a native screen', () => {
    const { result } = renderHook(() =>
      useLayoutHarness({ enabled: false })
    )

    act(() => {
      chatSessionEvents.requestSelect({
        projectId: PROJECT_ID,
        sessionId: 'chat-b',
      })
    })

    expect(result.current.chatSessionId).toBe('chat-b')
    expect(result.current.writes).toHaveLength(0)
  })
})
