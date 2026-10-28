// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The auto-mark-read-while-visible hook must call the server with
 * `advance: true` -- it's only ever "I've read up to here", never an
 * explicit "mark unread". See fix/mark-read-monotonic: without this flag,
 * two of these calls racing over the network could silently regress the
 * read marker and resurrect a cleared unread badge.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

// Spread the real module: other imports (e.g. team-chat-connection's
// nativeCookieHeader/realtimeUrls) need the rest of it intact.
const realApi = await import('../../lib/team-chat-api')

const markRead = mock(async (_id: string, _seq?: number, _opts?: { advance?: boolean }) => ({ lastReadSeq: 0 }))

mock.module('../../lib/team-chat-api', () => ({
  ...realApi,
  teamChatApi: () => ({ markRead }),
}))

const { useMarkReadWhileVisible } = await import('../useTeamChat')

afterEach(() => {
  cleanup()
  markRead.mockClear()
})

describe('useMarkReadWhileVisible', () => {
  test('marks read with advance:true while visible', async () => {
    renderHook(() => useMarkReadWhileVisible('c1', 5, true))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450))
    })
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith('c1', 5, { advance: true })
  })

  test('does not mark read while hidden or paused', async () => {
    const { rerender } = renderHook(
      ({ visible, paused }) => useMarkReadWhileVisible('c1', 5, visible, paused),
      { initialProps: { visible: false, paused: false } },
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450))
    })
    expect(markRead).not.toHaveBeenCalled()

    rerender({ visible: true, paused: true })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450))
    })
    expect(markRead).not.toHaveBeenCalled()
  })

  test('a newer seq while visible debounces and only sends the latest', async () => {
    const { rerender } = renderHook(
      ({ seq }) => useMarkReadWhileVisible('c1', seq, true),
      { initialProps: { seq: 5 } },
    )
    rerender({ seq: 6 })
    rerender({ seq: 7 })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450))
    })
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith('c1', 7, { advance: true })
  })
})
