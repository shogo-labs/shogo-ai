// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `monaco-cancellation-silencer` — the global `unhandledrejection`
 * + `error` listener pair that suppresses Monaco's known-benign "Canceled"
 * leak (upstream microsoft/monaco-editor#4702 etc.).
 *
 * Coverage:
 *   - Monaco-shaped `CancellationError` is silenced (preventDefault +
 *     stopImmediatePropagation called on the event).
 *   - Real, unrelated errors are left alone (no propagation interference).
 *   - Repeated install calls are a no-op (module-level guard).
 *
 * Run: bun test apps/mobile/lib/__tests__/monaco-cancellation-silencer.test.ts
 */

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test'

mock.module('react-native', () => ({
  Platform: { OS: 'web' },
}))

type CapturedListener = {
  type: string
  fn: EventListener
  options: AddEventListenerOptions | boolean | undefined
}

const captured: CapturedListener[] = []
const addEventListenerSpy = spyOn(window, 'addEventListener').mockImplementation(
  (type: string, fn: any, options?: AddEventListenerOptions | boolean) => {
    captured.push({ type, fn, options })
  },
)

const {
  installMonacoCancellationSilencer,
  __resetForTest,
  __test,
} = await import('../monaco-cancellation-silencer')

function getListener(type: 'unhandledrejection' | 'error'): EventListener {
  const entry = captured.find((c) => c.type === type)
  if (!entry) throw new Error(`No listener registered for ${type}`)
  return entry.fn
}

function makeMockEvent(props: Record<string, unknown>) {
  const calls = { preventDefault: 0, stopImmediatePropagation: 0 }
  const event = {
    ...props,
    preventDefault() {
      calls.preventDefault++
    },
    stopImmediatePropagation() {
      calls.stopImmediatePropagation++
    },
  }
  return { event, calls }
}

beforeEach(() => {
  // Each test starts from a clean install + listener registration so the
  // module-load side effect plus the explicit re-install path are both
  // covered without bleed-over.
  captured.length = 0
  __resetForTest()
  addEventListenerSpy.mockClear()
  installMonacoCancellationSilencer()
})

describe('isMonacoCancellation matcher', () => {
  test('matches errors with name === "Canceled"', () => {
    const err = Object.assign(new Error('whatever'), { name: 'Canceled' })
    expect(__test.isMonacoCancellation(err)).toBe(true)
  })

  test('matches errors whose message is exactly "Canceled"', () => {
    expect(__test.isMonacoCancellation(new Error('Canceled'))).toBe(true)
  })

  test('matches errors whose message is "Canceled: Canceled"', () => {
    // The Chrome devtools console formats Monaco's CancellationError as
    // "Canceled: Canceled" (constructor name + message); some unhandled-
    // rejection paths surface it pre-formatted as the message.
    expect(__test.isMonacoCancellation(new Error('Canceled: Canceled'))).toBe(true)
  })

  test('does NOT match an unrelated Error', () => {
    expect(__test.isMonacoCancellation(new Error('boom'))).toBe(false)
  })

  test('does NOT match an error that merely mentions "Canceled" in a longer message', () => {
    // Narrow matching matters: a real "Operation was Canceled by user"
    // should still surface to the dev overlay.
    expect(__test.isMonacoCancellation(new Error('Operation was Canceled by user'))).toBe(false)
  })

  test('does NOT match null / undefined / primitives', () => {
    expect(__test.isMonacoCancellation(null)).toBe(false)
    expect(__test.isMonacoCancellation(undefined)).toBe(false)
    expect(__test.isMonacoCancellation('Canceled')).toBe(false)
    expect(__test.isMonacoCancellation(42)).toBe(false)
  })
})

describe('unhandledrejection listener', () => {
  test('swallows a Monaco-shaped Canceled rejection', () => {
    const fn = getListener('unhandledrejection')
    const { event, calls } = makeMockEvent({
      reason: Object.assign(new Error('Canceled'), { name: 'Canceled' }),
    })
    fn(event as unknown as Event)
    expect(calls.preventDefault).toBe(1)
    expect(calls.stopImmediatePropagation).toBe(1)
  })

  test('leaves a real rejection alone', () => {
    const fn = getListener('unhandledrejection')
    const { event, calls } = makeMockEvent({
      reason: new Error('Database connection failed'),
    })
    fn(event as unknown as Event)
    expect(calls.preventDefault).toBe(0)
    expect(calls.stopImmediatePropagation).toBe(0)
  })

  test('tolerates a rejection with no reason', () => {
    const fn = getListener('unhandledrejection')
    const { event, calls } = makeMockEvent({ reason: undefined })
    fn(event as unknown as Event)
    expect(calls.preventDefault).toBe(0)
    expect(calls.stopImmediatePropagation).toBe(0)
  })
})

describe('error listener', () => {
  test('swallows a Monaco-shaped synchronous Canceled throw', () => {
    const fn = getListener('error')
    const { event, calls } = makeMockEvent({
      error: Object.assign(new Error('Canceled'), { name: 'Canceled' }),
    })
    fn(event as unknown as Event)
    expect(calls.preventDefault).toBe(1)
    expect(calls.stopImmediatePropagation).toBe(1)
  })

  test('leaves a real synchronous error alone', () => {
    const fn = getListener('error')
    const { event, calls } = makeMockEvent({
      error: new TypeError("Cannot read properties of undefined (reading 'foo')"),
    })
    fn(event as unknown as Event)
    expect(calls.preventDefault).toBe(0)
    expect(calls.stopImmediatePropagation).toBe(0)
  })
})

describe('idempotency', () => {
  test('a second install call does not re-register listeners', () => {
    // beforeEach already called install once; capturing how many listeners
    // are registered after that is the baseline.
    const baseline = captured.length
    installMonacoCancellationSilencer()
    installMonacoCancellationSilencer()
    expect(captured.length).toBe(baseline)
  })

  test('listeners are registered in capture phase', () => {
    for (const entry of captured) {
      const opts = entry.options
      const capture =
        typeof opts === 'boolean' ? opts : (opts?.capture ?? false)
      expect(capture).toBe(true)
    }
  })
})
