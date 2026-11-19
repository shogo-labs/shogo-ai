// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Test-only stub for `@sentry/react-native`.
 *
 * The real package cannot be evaluated under happy-dom: its module graph
 * reaches `react-native/Libraries/NativeComponent/NativeComponentRegistry`
 * (Flow syntax Bun's parser rejects) and evaluates `Easing.in(Easing.quad)` at
 * load time. `contexts/auth.tsx` reports auth failures to Sentry (SHO-414) and
 * is reachable from `hooks/useWorkspaceUser`, so an unstubbed copy failed every
 * suite whose graph touched auth.
 *
 * Every export the app touches is a no-op. A test that needs to observe a
 * report should `mock.module('@sentry/react-native', ...)` with its own spy.
 */

export function init(): void {}

export function wrap<T>(component: T): T {
  return component
}

export function captureException(): string {
  return 'stub-event-id'
}

export function captureMessage(): string {
  return 'stub-event-id'
}

export function addBreadcrumb(): void {}

export default {
  init,
  wrap,
  captureException,
  captureMessage,
  addBreadcrumb,
}
