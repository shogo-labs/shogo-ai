// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for Sentry REACT-3Q: "ShogoError: Super admin access
 * required" surfacing as an UNHANDLED promise rejection
 * (`onunhandledrejection`, culprit `_ShogoError.fromStatus` →
 * `HttpClient#executeRequest`).
 *
 * Root cause: the admin settings screen (`app/(admin)/settings.tsx`) loads the
 * agent-model defaults on mount:
 *
 *     platform.getAgentModelDefaults().then(...).finally(...)   // no .catch!
 *
 * `GET /api/admin/settings/agent-models` is super-admin-only. A user who
 * reaches the screen without the `super_admin` role (or whose session lost it)
 * gets a 403 → the SDK rejects with `ShogoError('Super admin access required')`.
 * Because the effect discards the returned promise and never attaches a
 * `.catch`, that rejection is unhandled and reaches Sentry. (The two other
 * `getAgentModelDefaults()` call sites in the same file already `.catch`.)
 *
 * We reproduce the mechanism deterministically: the buggy chain's promise stays
 * rejected (an unawaited/undiscarded rejecting promise === an unhandled
 * rejection in the browser), while the fixed chain resolves and still flips the
 * loading flag off.
 */
import { describe, test, expect } from 'bun:test'
import { PlatformApi } from '@shogo-ai/sdk'

/** Minimal fake HttpClient whose admin GET rejects like the SDK does on 403. */
function makePlatformReturning403(): PlatformApi {
  const http = {
    async get(path: string) {
      if (path === '/api/admin/settings/agent-models') {
        // Mirrors `_ShogoError.fromStatus(403, ...)`.
        throw new Error('Super admin access required')
      }
      return { data: undefined }
    },
    async post() { return { data: undefined } },
    async put() { return { data: undefined } },
    async delete() { return { data: undefined } },
    async request() { return { data: undefined } },
  }
  return new PlatformApi(http as never)
}

describe('admin settings — agent-model defaults load (REACT-3Q)', () => {
  test('the raw admin call rejects with "Super admin access required" on 403', async () => {
    const platform = makePlatformReturning403()
    await expect(platform.getAgentModelDefaults()).rejects.toThrow('Super admin access required')
  })

  test('BUGGY chain (no .catch) leaves a rejecting promise → unhandled rejection', async () => {
    const platform = makePlatformReturning403()
    let loading = true

    // Exact shape of the pre-fix effect body in settings.tsx.
    const chain = platform
      .getAgentModelDefaults()
      .then((data) => {
        void data
      })
      .finally(() => {
        loading = false
      })

    // The discarded promise rejects — in the browser this is exactly what fires
    // `onunhandledrejection` and lands in Sentry.
    await expect(chain).rejects.toThrow('Super admin access required')
    expect(loading).toBe(false) // .finally still ran
  })

  test('FIXED chain (.catch) resolves cleanly and still clears the loading flag', async () => {
    const platform = makePlatformReturning403()
    let loading = true
    let caught: unknown = null

    // Post-fix effect body: swallow the expected authz failure.
    const chain = platform
      .getAgentModelDefaults()
      .then((data) => {
        void data
      })
      .catch((err) => {
        caught = err
      })
      .finally(() => {
        loading = false
      })

    await expect(chain).resolves.toBeUndefined()
    expect(loading).toBe(false)
    expect((caught as Error)?.message).toBe('Super admin access required')
  })
})
