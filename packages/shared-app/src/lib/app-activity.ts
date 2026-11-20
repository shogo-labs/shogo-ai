// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Platform-free app-activity pub/sub.
 *
 * A shell (native or web) registers its platform listener exactly once at
 * startup via `registerAppActivitySource`. Shared-app hooks subscribe via
 * `subscribeAppActivity` and are notified whenever the app comes to the
 * foreground (native `AppState → 'active'`, web `visibilitychange` visible or
 * `window.focus`).
 *
 * No `react-native` import — this module must be safe to bundle for web.
 */

/** Registered subscribers. */
const subscribers = new Set<() => void>()

/** Cleanup returned by the last registered source factory. */
let sourceCleanup: (() => void) | null = null

/** Fire every registered subscriber. */
function notify(): void {
  subscribers.forEach((cb) => cb())
}

/**
 * Register the platform listener that emits app-activity signals.
 *
 * `factory` is called immediately with a `notify` callback; it must return a
 * cleanup function. Call this once from the signed-in root layout (not per
 * screen). Returns a cleanup that removes the source, so the `useEffect`
 * return value works directly:
 *
 * ```ts
 * useEffect(() => registerAppActivitySource((cb) => { ... }), [])
 * ```
 */
export function registerAppActivitySource(
  factory: (cb: () => void) => () => void,
): () => void {
  if (sourceCleanup) sourceCleanup()
  sourceCleanup = factory(notify)
  return () => {
    if (sourceCleanup) {
      sourceCleanup()
      sourceCleanup = null
    }
  }
}

/**
 * Subscribe to app-activity signals (foreground transitions).
 * Returns an unsubscribe function; call it from an effect cleanup.
 *
 * Subscriptions placed before any source is registered are queued and start
 * working the moment a source fires its first callback — no lost signals.
 */
export function subscribeAppActivity(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}
