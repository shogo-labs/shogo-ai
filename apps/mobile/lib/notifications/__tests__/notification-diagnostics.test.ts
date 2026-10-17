// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the drop-reason diagnostics behind the notifier path.
 *
 * The module is process-global, so every test resets it and stubs
 * `console.warn` to assert the once-per-reason warning without noise.
 *
 * Run: bun test apps/mobile/lib/notifications/__tests__/notification-diagnostics.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import {
  getNotificationDiagnostics,
  recordNotificationDropped,
  recordNotificationShown,
  resetNotificationDiagnostics,
} from '../notification-diagnostics'

describe('notification-diagnostics', () => {
  let originalWarn: typeof console.warn
  let warnings: string[]

  beforeEach(() => {
    resetNotificationDiagnostics()
    originalWarn = console.warn
    warnings = []
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.join(' '))
    }) as typeof console.warn
  })

  afterEach(() => {
    console.warn = originalWarn
    resetNotificationDiagnostics()
  })

  test('starts empty', () => {
    expect(getNotificationDiagnostics()).toEqual({ shown: 0, dropped: 0, lastDrop: null })
  })

  test('counts shown alerts', () => {
    recordNotificationShown()
    recordNotificationShown()
    expect(getNotificationDiagnostics().shown).toBe(2)
    expect(getNotificationDiagnostics().dropped).toBe(0)
    expect(warnings).toHaveLength(0)
  })

  test('records the reason and an actionable message', () => {
    recordNotificationDropped('permission-prompt')
    const diag = getNotificationDiagnostics()
    expect(diag.dropped).toBe(1)
    expect(diag.lastDrop?.reason).toBe('permission-prompt')
    // The message has to say how to fix it, not just that it failed.
    expect(diag.lastDrop?.message).toContain('Turn on')
    expect(diag.lastDrop?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('includes the underlying detail when the browser supplies one', () => {
    recordNotificationDropped('show-threw', 'Illegal constructor')
    expect(getNotificationDiagnostics().lastDrop?.message).toContain('Illegal constructor')
  })

  test('warns once per reason but keeps counting', () => {
    recordNotificationDropped('permission-denied')
    recordNotificationDropped('permission-denied')
    recordNotificationDropped('permission-denied')

    expect(getNotificationDiagnostics().dropped).toBe(3)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('blocked in this browser')
  })

  test('a distinct reason warns again', () => {
    recordNotificationDropped('permission-prompt')
    recordNotificationDropped('unsupported')
    expect(warnings).toHaveLength(2)
    expect(getNotificationDiagnostics().dropped).toBe(2)
  })

  test('keeps the most recent drop as lastDrop', () => {
    recordNotificationDropped('unsupported')
    recordNotificationDropped('permission-denied')
    expect(getNotificationDiagnostics().lastDrop?.reason).toBe('permission-denied')
  })

  test('a drop after a show reports both counts', () => {
    recordNotificationShown()
    recordNotificationDropped('permission-prompt')
    recordNotificationShown()
    expect(getNotificationDiagnostics()).toMatchObject({ shown: 2, dropped: 1 })
  })
})
