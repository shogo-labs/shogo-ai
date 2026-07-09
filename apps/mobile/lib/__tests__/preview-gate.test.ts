// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the preview "wait for the API before loading the UI" gate
 * (`lib/preview-gate.ts`). These pin the policy that the project layout
 * (`projects/[id]/_layout.tsx`) uses to hold the canvas iframe until the
 * project's API sidecar is actually responding — the fix for "UI loads but
 * `/api/*` calls fail because the server isn't up yet".
 *
 * Run: bun test apps/mobile/lib/__tests__/preview-gate.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  resolveApiReady,
  shouldStopPreviewPoll,
  shouldShowCanvas,
  isPreviewFailed,
} from '../preview-gate'

describe('resolveApiReady', () => {
  test('passes through an explicit boolean', () => {
    expect(resolveApiReady({ apiReady: true })).toBe(true)
    expect(resolveApiReady({ apiReady: false })).toBe(false)
  })

  test('defaults to true when the field is absent (older runtime)', () => {
    // Backwards-compat: a runtime whose /preview/status predates apiReady
    // must not permanently block the UI.
    expect(resolveApiReady({})).toBe(true)
    expect(resolveApiReady({ running: true })).toBe(true)
  })
})

describe('shouldStopPreviewPoll', () => {
  test('keeps polling while running but the API is not ready yet', () => {
    // The prebuilt-dist path reports running=true before the sidecar binds,
    // so we must NOT stop polling until apiReady flips true.
    expect(shouldStopPreviewPoll({ running: true, apiReady: false })).toBe(false)
  })

  test('keeps polling while the API is ready but the preview is not running', () => {
    expect(shouldStopPreviewPoll({ running: false, apiReady: true })).toBe(false)
  })

  test('stops once running AND the API is ready', () => {
    expect(shouldStopPreviewPoll({ running: true, apiReady: true })).toBe(true)
  })

  test('stops on an older runtime once running (absent apiReady → ready)', () => {
    expect(shouldStopPreviewPoll({ running: true })).toBe(true)
  })

  test('does not stop before the preview is running', () => {
    expect(shouldStopPreviewPoll({})).toBe(false)
    expect(shouldStopPreviewPoll({ apiReady: true })).toBe(false)
  })

  test('stops immediately when setup terminally failed (no infinite spinner)', () => {
    // phase=failed means the runtime will never come up on its own — stop
    // polling and let the UI render the error instead of spinning forever.
    expect(shouldStopPreviewPoll({ phase: 'failed' })).toBe(true)
    expect(shouldStopPreviewPoll({ phase: 'failed', running: false })).toBe(true)
  })
})

describe('isPreviewFailed', () => {
  test('true only for the terminal failed phase', () => {
    expect(isPreviewFailed({ phase: 'failed' })).toBe(true)
    expect(isPreviewFailed({ phase: 'building' })).toBe(false)
    expect(isPreviewFailed({ phase: 'ready' })).toBe(false)
    expect(isPreviewFailed({})).toBe(false)
  })
})

describe('shouldShowCanvas', () => {
  test('false until the dev server is reachable, regardless of API state', () => {
    expect(shouldShowCanvas({ baseReady: false, apiLatched: true, timedOut: false })).toBe(false)
    expect(shouldShowCanvas({ baseReady: false, apiLatched: false, timedOut: true })).toBe(false)
  })

  test('false while base is ready but the API has never been healthy', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: false, timedOut: false })).toBe(false)
  })

  test('true once base is ready and the API has been healthy (latched)', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: true, timedOut: false })).toBe(true)
  })

  test('timeout is a safety valve: loads even if the API never went healthy', () => {
    expect(shouldShowCanvas({ baseReady: true, apiLatched: false, timedOut: true })).toBe(true)
  })
})
