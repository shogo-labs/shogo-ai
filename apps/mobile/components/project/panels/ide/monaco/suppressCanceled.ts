// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Suppress Monaco's harmless "Canceled" errors from the browser-level error
 * surface (uncaught error overlay, unhandledrejection listeners, Sentry).
 *
 * Why this is needed:
 *   Several Monaco contributions cancel in-flight async work via
 *   `CancellationTokenSource` when their host (editor / model / contribution)
 *   is disposed — e.g. during `editor.setModel`, `editor.restoreViewState`,
 *   or rapid mount/unmount cycles. Monaco's internal event delivery catches
 *   listener errors and routes them through `onUnexpectedError`, which is
 *   supposed to swallow cancellations. In practice the filter misses in
 *   a few well-known cases:
 *
 *     - microsoft/monaco-editor#5135 — `setModel` during a command action
 *     - microsoft/monaco-editor#4904 — `restoreViewState` on React remount
 *     - microsoft/monaco-editor#4312 — Linked-editing contribution
 *     - microsoft/monaco-editor#4389 — burst-paste under Cmd+V
 *     - suren-atoyan/monaco-react#575 — Strict-Mode double-effect mount
 *
 *   The result is an "Uncaught Error: Canceled" overlay during normal
 *   navigation (e.g. creating a new project — the IDE panel mounts under
 *   `display: none`, Monaco initializes, `<Editor>` calls `setModel`, and
 *   a disposing contribution's cancel cascade throws). It's cosmetic — no
 *   feature is broken — but it crosses the React error boundary and looks
 *   like a real crash in dev.
 *
 * What this does:
 *   Install one `error` and one `unhandledrejection` listener at the
 *   capture phase that call `preventDefault()` ONLY when the payload
 *   matches Monaco's cancellation signature (name === "Canceled" and
 *   message === "Canceled"). Anything else passes through untouched, so
 *   real bugs still surface normally.
 *
 *   Idempotent — a module-level flag guards against repeat installs across
 *   the Workbench mount / split-editor remounts / Fast Refresh.
 */

const CANCELED = 'Canceled'

function isMonacoCanceled(value: unknown): boolean {
  if (!value) return false
  if (value instanceof Error) {
    return value.name === CANCELED && value.message === CANCELED
  }
  if (typeof value === 'object') {
    const v = value as { name?: unknown; message?: unknown }
    return v.name === CANCELED && v.message === CANCELED
  }
  return false
}

let installed = false

export function installMonacoCanceledErrorSuppressor(): void {
  if (installed) return
  if (typeof window === 'undefined') return
  installed = true

  window.addEventListener(
    'error',
    (event) => {
      if (isMonacoCanceled(event.error)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    },
    true,
  )

  window.addEventListener(
    'unhandledrejection',
    (event) => {
      if (isMonacoCanceled(event.reason)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    },
    true,
  )
}

export const __test = { isMonacoCanceled }
