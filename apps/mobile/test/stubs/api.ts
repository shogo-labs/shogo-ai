// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Test-only stub for `apps/mobile/lib/api`.
 *
 * Two problems this solves, both caused by `mock.module` being process-global
 * and outliving the file that registers it:
 *
 *  1. A mock that omits an export strips it for every later test file, which
 *     surfaces as `SyntaxError: Export named 'X' not found in module …` in a
 *     suite that never mocked anything. Spreading this stub keeps the module's
 *     shape complete no matter which file's mock happens to win.
 *
 *  2. Building a partial mock by importing the real module is not an option
 *     here: `lib/api` pulls in `expo-constants` and `react-native` at module
 *     scope, so importing it from a test file drags the native module graph in
 *     early and destabilises unrelated suites (the IDE Terminal tests start
 *     opening real sockets).
 *
 * Override individual exports at the call site; keep the spread.
 */

export const API_URL = 'http://test.local'

export function createHttpClient(): unknown {
  return {}
}

export function isInvitationExpired(): boolean {
  return false
}

export function getOnboardingMessage(listingTitle: string): string {
  return listingTitle
}

/**
 * Every endpoint resolves to `undefined`. Suites that assert on a response
 * override `api` (or the single method they exercise) on top of the spread.
 */
export const api: Record<string, unknown> = new Proxy(
  {},
  { get: () => async () => undefined },
)
