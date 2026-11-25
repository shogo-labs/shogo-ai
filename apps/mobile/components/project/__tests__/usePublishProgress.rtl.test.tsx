// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The panel's side of "publish runs on the server" (SHO-542).
 *
 * `POST /publish` answers 202, so the popover cannot report the outcome from the
 * response any more — it subscribes instead: show the step being worked on, poll
 * `GET /projects/:id/publish`, and end on the live URL or on the mapped failure.
 * These tests drive that state machine directly (the popover itself needs the
 * whole navigation tree); the poll delays are 1 ms so nothing sleeps for real.
 */

import { describe, expect, test } from 'bun:test'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  isPublishInFlightStatus,
  publishProgressLabel,
  usePublishProgress,
  type PublishStateSnapshot,
} from '../usePublishProgress'
import { publishStatusMessage } from '../publish-errors'

/** A publish state read that answers the given statuses in order, then repeats. */
function sequence(states: PublishStateSnapshot[]) {
  let i = 0
  const calls: number[] = []
  const getState = async () => {
    calls.push(i)
    const state = states[Math.min(i, states.length - 1)]
    i += 1
    return state
  }
  return { getState, calls }
}

const timing = { startDelayMs: 1, maxDelayMs: 1 }

describe('usePublishProgress', () => {
  test('follows the steps to live and calls onLive once', async () => {
    const { getState, calls } = sequence([
      { publishStatus: 'building' },
      { publishStatus: 'uploading' },
      { publishStatus: 'configuring' },
      { publishStatus: 'live', publishError: null },
    ])
    const live: PublishStateSnapshot[] = []

    const { result } = renderHook(() =>
      usePublishProgress({
        ...timing,
        getState,
        onLive: (state) => live.push(state),
      }),
    )

    act(() => result.current.follow())
    // After an accepted POST the panel shows progress, not an idle Publish button.
    expect(result.current.progress).toBe('building')
    expect(publishProgressLabel(result.current.progress)).toBe('Building your app…')

    await waitFor(() => expect(live).toHaveLength(1))
    expect(result.current.progress).toBeNull()
    expect(result.current.error).toBeNull()

    // It followed every step rather than jumping from POST to result: one read
    // per status, four in all.
    expect(calls).toHaveLength(4)
  })

  test('surfaces a failed publish with the code’s own wording', async () => {
    const { getState } = sequence([
      { publishStatus: 'building' },
      { publishStatus: 'failed', publishError: 'configure_failed' },
    ])
    const failures: string[] = []

    const { result } = renderHook(() =>
      usePublishProgress({
        ...timing,
        getState,
        onFailed: (_state, message) => failures.push(message),
      }),
    )

    act(() => result.current.follow())

    await waitFor(() => expect(failures).toHaveLength(1))
    expect(result.current.progress).toBeNull()
    expect(result.current.error).toBe(publishStatusMessage('configure_failed'))
    expect(result.current.error).toContain('our hosting side')

    // The panel can dismiss the error without leaving the popover.
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })

  test('a publish interrupted by an API restart is explained, not spun on', async () => {
    const { getState } = sequence([
      { publishStatus: 'failed', publishError: 'publish_interrupted' },
    ])
    const { result } = renderHook(() => usePublishProgress({ ...timing, getState }))

    act(() => result.current.follow())

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toBe(publishStatusMessage('publish_interrupted'))
  })

  test('resume picks an in-flight publish back up, and ignores settled ones', () => {
    const { getState } = sequence([{ publishStatus: 'live' }])
    const { result } = renderHook(() => usePublishProgress({ ...timing, getState }))

    // Reopening the popover mid-publish shows the step it is on.
    act(() => {
      expect(result.current.resume('configuring')).toBe(true)
    })
    expect(result.current.progress).toBe('configuring')
    expect(publishProgressLabel(result.current.progress)).toBe('Taking your app live…')

    // A settled or idle row must not put the panel into a progress state.
    act(() => result.current.stop())
    for (const settled of ['live', 'failed', 'idle', null, undefined]) {
      act(() => {
        expect(result.current.resume(settled)).toBe(false)
      })
      expect(result.current.progress).toBeNull()
    }
  })

  test('closing the popover stops the polling', async () => {
    let reads = 0
    const getState = async () => {
      reads += 1
      return { publishStatus: 'building' } as PublishStateSnapshot
    }
    const { result } = renderHook(() => usePublishProgress({ ...timing, getState }))

    act(() => result.current.follow())
    await waitFor(() => expect(reads).toBeGreaterThan(1))

    act(() => result.current.stop())
    const afterStop = reads
    // Nothing scheduled by the old run may fire after stop().
    await new Promise((r) => setTimeout(r, 20))
    expect(reads).toBe(afterStop)
    expect(result.current.progress).toBeNull()
  })

  test('a poll that throws is retried, not reported as a failed publish', async () => {
    let reads = 0
    const getState = async () => {
      reads += 1
      if (reads === 1) throw new Error('network blip')
      return { publishStatus: 'live' } as PublishStateSnapshot
    }
    const live: PublishStateSnapshot[] = []
    const { result } = renderHook(() =>
      usePublishProgress({ ...timing, getState, onLive: (state) => live.push(state) }),
    )

    act(() => result.current.follow())

    await waitFor(() => expect(live).toHaveLength(1))
    expect(result.current.error).toBeNull()
    expect(result.current.progress).toBeNull()
  })

  test('isPublishInFlightStatus is the one definition of "a publish is running"', () => {
    expect(isPublishInFlightStatus('building')).toBe(true)
    expect(isPublishInFlightStatus('uploading')).toBe(true)
    expect(isPublishInFlightStatus('configuring')).toBe(true)
    expect(isPublishInFlightStatus('live')).toBe(false)
    expect(isPublishInFlightStatus('failed')).toBe(false)
    expect(isPublishInFlightStatus(null)).toBe(false)
  })
})
