// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Minimal `EventSource` stub for tests. Replaces `globalThis.EventSource`
 * with a controllable implementation so tests can:
 *
 *   - Drive `message` events with `instance.emit({ ... })` (auto-JSON-encoded).
 *   - Simulate connection failures via `instance.fail()`.
 *   - Assert the URL the SUT opened with.
 *   - Track `close()` calls.
 *
 * Why a hand-rolled stub instead of MSW: our scope is two SSE endpoints and
 * no fetch shaping. A 60-line stub is far simpler than an MSW server +
 * lifecycle hooks + ReadableStream wiring.
 */

type Listener = (event: { data: string }) => void
type ErrorListener = (event: { type: 'error' }) => void

export class MockEventSource {
  static last: MockEventSource | null = null
  static all: MockEventSource[] = []

  url: string
  withCredentials: boolean
  readyState: 0 | 1 | 2 = 0
  closed = false

  onmessage: Listener | null = null
  onerror: ErrorListener | null = null
  onopen: ((ev: Event) => void) | null = null

  private messageListeners = new Set<Listener>()
  private errorListeners = new Set<ErrorListener>()
  private namedListeners = new Map<string, Set<Listener>>()

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = init?.withCredentials ?? false
    this.readyState = 1
    MockEventSource.last = this
    MockEventSource.all.push(this)
  }

  addEventListener(type: string, listener: Listener | ErrorListener): void {
    if (type === 'message') {
      this.messageListeners.add(listener as Listener)
    } else if (type === 'error') {
      this.errorListeners.add(listener as ErrorListener)
    } else {
      let bucket = this.namedListeners.get(type)
      if (!bucket) {
        bucket = new Set()
        this.namedListeners.set(type, bucket)
      }
      bucket.add(listener as Listener)
    }
  }

  removeEventListener(type: string, listener: Listener | ErrorListener): void {
    if (type === 'message') {
      this.messageListeners.delete(listener as Listener)
    } else if (type === 'error') {
      this.errorListeners.delete(listener as ErrorListener)
    } else {
      this.namedListeners.get(type)?.delete(listener as Listener)
    }
  }

  close(): void {
    this.readyState = 2
    this.closed = true
  }

  /**
   * Test hook — push a `message` event payload. Strings pass through
   * untouched (so tests can send malformed JSON for negative cases);
   * non-string values are JSON-encoded the way real EventSource consumers
   * expect.
   */
  emit(data: unknown, type: 'message' | string = 'message'): void {
    if (this.closed) return
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    const event = { data: text }
    if (type === 'message') {
      this.onmessage?.(event)
      for (const l of this.messageListeners) l(event)
    } else {
      const bucket = this.namedListeners.get(type)
      if (bucket) for (const l of bucket) l(event)
    }
  }

  /** Test hook — simulate a network failure / disconnect. */
  fail(): void {
    if (this.closed) return
    const event = { type: 'error' as const }
    this.onerror?.(event)
    for (const l of this.errorListeners) l(event)
  }
}

export function installMockEventSource(): typeof MockEventSource {
  MockEventSource.last = null
  MockEventSource.all = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).EventSource = MockEventSource as any
  return MockEventSource
}

export function uninstallMockEventSource(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).EventSource
  MockEventSource.last = null
  MockEventSource.all = []
}
