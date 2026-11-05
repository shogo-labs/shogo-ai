// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The shared SSE-with-poll-bridge policy, exercised without React or a
 * network: fake timers drive the retry ladder and the poll cadence, and the
 * test's `connect` decides whether the stream comes up.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import {
  createStreamFallback,
  POLL_AFTER_FAILURES,
  POLL_INTERVAL_CAPPED_MS,
  POLL_INTERVAL_MS,
  SSE_RETRY_DELAYS_MS,
  type StreamTransport,
} from '../stream-fallback'

function harness(opts: {
  /** Per-connect outcome: 'open' behaves like a healthy stream. */
  outcome?: (attempt: number) => 'open' | 'fail'
  visible?: boolean
} = {}) {
  const connections: Array<{ open(): void; fail(): void; closed: boolean }> = []
  const transports: StreamTransport[] = []
  let polls = 0
  let visible = opts.visible ?? true
  let visibilityListener: (() => void) | null = null
  let attempt = 0

  const fallback = createStreamFallback({
    isVisible: () => visible,
    subscribeVisibility: (cb) => {
      visibilityListener = cb
      return () => {
        visibilityListener = null
      }
    },
    onTransportChange: (t) => transports.push(t),
    connect: (hooks) => {
      attempt += 1
      const mode = opts.outcome?.(attempt) ?? 'open'
      const conn = {
        closed: false,
        open: () => hooks.onOpen(),
        fail: () => hooks.onError(),
        close: () => {
          conn.closed = true
        },
      }
      connections.push(conn)
      if (mode === 'open') conn.open()
      else conn.fail()
      return () => {
        conn.closed = true
      }
    },
    poll: () => {
      polls += 1
    },
  })

  return {
    fallback,
    connections,
    transports,
    polls: () => polls,
    setVisible(next: boolean) {
      visible = next
      visibilityListener?.()
    },
  }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe('createStreamFallback', () => {
  test('a healthy stream costs no polls over ten minutes', () => {
    const h = harness()
    h.fallback.start()
    expect(h.fallback.transport()).toBe('sse')

    jest.advanceTimersByTime(10 * 60_000)

    expect(h.polls()).toBe(0)
    expect(h.connections).toHaveLength(1)
    expect(h.fallback.transport()).toBe('sse')
  })

  test('one cut retries SSE and does not start polling', () => {
    const h = harness({ outcome: (n) => (n === 1 ? 'fail' : 'open') })
    h.fallback.start()
    expect(h.polls()).toBe(0)
    expect(h.fallback.transport()).toBe('poll')

    jest.advanceTimersByTime(SSE_RETRY_DELAYS_MS[0]!)
    expect(h.connections).toHaveLength(2)
    // The retry opened: back on SSE, no requests made meanwhile.
    expect(h.fallback.transport()).toBe('sse')
    expect(h.polls()).toBe(0)
  })

  test('polling starts only after the quick retry also fails, at 15 s', () => {
    const h = harness({ outcome: () => 'fail' })
    h.fallback.start()
    expect(POLL_AFTER_FAILURES).toBe(2)

    jest.advanceTimersByTime(SSE_RETRY_DELAYS_MS[0]!)
    expect(h.connections).toHaveLength(2)
    expect(h.polls()).toBe(0) // the second failure just happened

    jest.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(h.polls()).toBe(1)
  })

  test('follows the 2 → 4 → 8 → 16 → 30 s ladder, then stays capped', () => {
    const h = harness({ outcome: () => 'fail' })
    h.fallback.start()
    expect(h.connections).toHaveLength(1)

    const widths: number[] = []
    for (const delay of SSE_RETRY_DELAYS_MS) {
      const before = h.connections.length
      jest.advanceTimersByTime(delay)
      expect(h.connections.length).toBe(before + 1)
      widths.push(delay)
    }
    expect(widths).toEqual([2_000, 4_000, 8_000, 16_000, 30_000])

    // Capped: the next two retries are still 30 s apart, and polling has
    // slowed to its capped cadence.
    const before = h.connections.length
    jest.advanceTimersByTime(30_000)
    expect(h.connections.length).toBe(before + 1)
    expect(SSE_RETRY_DELAYS_MS[SSE_RETRY_DELAYS_MS.length - 1]).toBe(30_000)
    expect(POLL_INTERVAL_CAPPED_MS).toBe(30_000)
  })

  test('an open stops the poller and resets the ladder', () => {
    let mode: 'fail' | 'open' = 'fail'
    const h = harness({ outcome: () => mode })
    h.fallback.start()
    jest.advanceTimersByTime(SSE_RETRY_DELAYS_MS[0]!)
    jest.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(h.polls()).toBeGreaterThan(0)

    mode = 'open'
    jest.advanceTimersByTime(SSE_RETRY_DELAYS_MS[SSE_RETRY_DELAYS_MS.length - 1]!)
    expect(h.fallback.transport()).toBe('sse')

    const pollsAtOpen = h.polls()
    jest.advanceTimersByTime(10 * 60_000)
    expect(h.polls()).toBe(pollsAtOpen)
  })

  test('a hidden tab schedules neither polls nor retries', () => {
    const h = harness({ outcome: () => 'fail', visible: false })
    h.fallback.start()

    expect(h.connections).toHaveLength(0)
    jest.advanceTimersByTime(10 * 60_000)
    expect(h.connections).toHaveLength(0)
    expect(h.polls()).toBe(0)
  })

  test('hiding a broken stream parks it; showing it retries immediately with the ladder reset', () => {
    const h = harness({ outcome: () => 'fail' })
    h.fallback.start()
    jest.advanceTimersByTime(SSE_RETRY_DELAYS_MS[0]!)
    jest.advanceTimersByTime(POLL_INTERVAL_MS)
    const pollsBeforeHide = h.polls()
    expect(pollsBeforeHide).toBeGreaterThan(0)

    h.setVisible(false)
    const connectionsAtHide = h.connections.length
    jest.advanceTimersByTime(10 * 60_000)
    expect(h.connections.length).toBe(connectionsAtHide)
    expect(h.polls()).toBe(pollsBeforeHide)

    // Back on screen: retry now, not after the ladder's current delay.
    h.setVisible(true)
    expect(h.connections.length).toBe(connectionsAtHide + 1)
  })

  test('stop() tears down the stream and the timers', () => {
    const h = harness({ outcome: () => 'fail' })
    h.fallback.start()
    h.fallback.stop()
    expect(h.fallback.transport()).toBe('idle')

    const connections = h.connections.length
    jest.advanceTimersByTime(10 * 60_000)
    expect(h.connections).toHaveLength(connections)
    expect(h.polls()).toBe(0)
    expect(h.connections[0]!.closed).toBe(true)
  })
})
