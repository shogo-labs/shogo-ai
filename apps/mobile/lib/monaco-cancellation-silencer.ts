// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Swallows Monaco's known-benign `Canceled` errors at the `window` event
 * boundary so they stop popping the Expo / RN-Web dev "Uncaught Error:
 * Canceled" overlay.
 *
 * Background — upstream Monaco bug microsoft/monaco-editor#4702 / #4859 /
 * #5135 (only partially fixed by microsoft/vscode PR #285887, not yet
 * released in `monaco-editor@0.55.1`). Monaco's internal
 * `Delayer`/`CancellationTokenSource` chain throws a `CancellationError`
 * with `name === 'Canceled'` and `message === 'Canceled'` during dispose,
 * and that throw escapes Monaco's own `onUnexpectedError` boundary as an
 * unhandled promise rejection. Monaco's own `onUnexpectedError` already
 * filters these out internally; we mirror that filter at the
 * window-event level for the throws that leak past it. The "Canceled"
 * itself is harmless internal control flow — Monaco aborts in-flight
 * async work (hover, completion, decorations) when an editor is being
 * disposed.
 *
 * The most reliable in-app trigger today is the `ask_user` auto-switch
 * in `apps/mobile/app/(app)/projects/[id]/_layout.tsx` (force-flips
 * `previewTab` to `chat-fullscreen`, which makes IDEPanel's container
 * `display:none`, which makes Monaco's `automaticLayout` see a 0x0
 * resize and dispose widgets mid-flight). The silencer covers the whole
 * class of "Canceled" leaks though, not just that path.
 *
 * Idempotent: the module-level `installed` flag guards against
 * double-registration under HMR / split bundles / re-imports.
 *
 * Web-only: native (`Platform.OS !== 'web'`) and SSR (no `window`) are
 * no-ops. RN's LogBox handles unhandled rejections on native through a
 * different channel; this file is irrelevant there.
 */

import { Platform } from 'react-native'

let installed = false

/**
 * Mirrors Monaco's `isCancellationError` in `vs/base/common/errors.ts`:
 * either the error is named `Canceled` (the `CancellationError` class
 * sets `name = 'Canceled'`), or its message is the literal `Canceled` /
 * `Canceled: Canceled` string that the same class uses. We intentionally
 * keep this narrow so a real error that happens to mention "Canceled" in
 * its message (e.g. a user-thrown "Operation Canceled by user") is not
 * accidentally swallowed.
 */
function isMonacoCancellation(err: unknown): boolean {
  if (!err) return false
  if (typeof err !== 'object') return false
  const e = err as { name?: unknown; message?: unknown }
  if (typeof e.name === 'string' && e.name === 'Canceled') return true
  if (
    typeof e.message === 'string' &&
    (e.message === 'Canceled' || e.message === 'Canceled: Canceled')
  ) {
    return true
  }
  return false
}

/**
 * Install the listeners. Exported for the unit test; production callers
 * just rely on the side-effect at module-load below.
 */
export function installMonacoCancellationSilencer(): void {
  if (installed) return
  if (Platform.OS !== 'web') return
  if (typeof window === 'undefined') return

  installed = true

  // `capture: true` so we run before listeners attached on the bubble
  // phase (Expo / RN-Web's LogBox attaches without `capture`, so a
  // capture-phase listener fires first). `stopImmediatePropagation`
  // prevents the bubble-phase listeners from also seeing the event and
  // logging it. `preventDefault` suppresses the browser's default
  // "Uncaught (in promise)" console noise on top of that.
  window.addEventListener(
    'unhandledrejection',
    (event) => {
      if (isMonacoCancellation((event as PromiseRejectionEvent).reason)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    },
    { capture: true },
  )

  window.addEventListener(
    'error',
    (event) => {
      if (isMonacoCancellation((event as ErrorEvent).error)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    },
    { capture: true },
  )
}

/** Test hook — drops the install guard so a follow-up call re-registers. */
export function __resetForTest(): void {
  installed = false
}

/** Test hook — exposes the matcher in isolation. */
export const __test = { isMonacoCancellation }

installMonacoCancellationSilencer()
