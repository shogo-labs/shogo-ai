// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * happy-dom global registrator preload.
 *
 * MUST be a separate file from the testing-library setup. ES module imports
 * are hoisted: if `@testing-library/react` is imported in the same preload
 * that calls `GlobalRegistrator.register()`, RTL evaluates first and binds
 * its `screen` to a missing `document`. Bun runs preload files sequentially,
 * so splitting these guarantees the DOM is registered before RTL imports.
 *
 * See https://github.com/testing-library/react-testing-library/issues/1348.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Pin a real base URL so tests that exercise `window.location` /
// `window.history.replaceState` aren't blocked by happy-dom's
// `about:blank` origin guard. Tests can still rewrite via `replaceState`.
GlobalRegistrator.register({ url: 'http://localhost/' })

// Globals expected by Expo / RN-web modules at evaluation time. These
// are set on `globalThis` so they're visible inside both ESM and CJS
// module factories, and BEFORE any user code runs (preload time).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).__DEV__ = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).process = (globalThis as any).process ?? { env: {} }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).process.env = (globalThis as any).process.env ?? {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).process.env.NODE_ENV =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).process.env.NODE_ENV ?? 'test'

// Neutralise the global WebSocket. The IDE terminal dials a PTY socket from a
// mount effect, so any suite rendering a tree that contains it (bottom panel,
// drawer host, editor tab strip) opened a real connection to a port with
// nothing behind it; `ws` then raised an unhandled ErrorEvent that failed the
// whole file, even though none of those suites assert on terminal behaviour.
//
// This is the one seam that stubs no module: `PtyClient` only reaches for the
// global as a default, and its own suite injects a fake `wsFactory`, so real
// transport logic stays under test. Suites needing live socket behaviour should
// pass their own factory rather than relying on this global.
class InertWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = InertWebSocket.CONNECTING
  readonly OPEN = InertWebSocket.OPEN
  readonly CLOSING = InertWebSocket.CLOSING
  readonly CLOSED = InertWebSocket.CLOSED

  readonly url: string
  readonly protocol = ''
  readonly extensions = ''
  readyState: number = InertWebSocket.CONNECTING
  binaryType: 'blob' | 'arraybuffer' = 'blob'
  bufferedAmount = 0

  onopen: ((ev: Event) => unknown) | null = null
  onclose: ((ev: Event) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: Event) => unknown) | null = null

  constructor(url: string | URL) {
    super()
    this.url = String(url)
  }

  send(): void {}

  close(): void {
    this.readyState = InertWebSocket.CLOSED
  }
}

Object.defineProperty(globalThis, 'WebSocket', {
  value: InertWebSocket,
  configurable: true,
  writable: true,
})
