// SPDX-License-Identifier: AGPL-3.0-or-later
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
