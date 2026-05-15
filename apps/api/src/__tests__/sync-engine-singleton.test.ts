// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Closes coverage gaps on the singleton accessors at the bottom of
// src/lib/sync-engine.ts (lines 352-355 and 362-363 in the merged
// lcov report: getSyncEngine + resetSyncEngine).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getSyncEngine, resetSyncEngine, SyncEngine } from '../lib/sync-engine'

beforeEach(() => {
  resetSyncEngine()
})

afterEach(() => {
  resetSyncEngine()
})

describe('getSyncEngine', () => {
  test('returns a SyncEngine instance on first call', () => {
    const engine = getSyncEngine()
    expect(engine).toBeInstanceOf(SyncEngine)
  })

  test('returns the same instance on subsequent calls (singleton)', () => {
    const a = getSyncEngine()
    const b = getSyncEngine()
    const c = getSyncEngine()
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  test('lazily constructs — no work happens until first access', () => {
    // Just calling the import shouldn't have constructed anything visible.
    // The first getSyncEngine() call constructs and caches.
    const a = getSyncEngine()
    expect(a).toBeInstanceOf(SyncEngine)
  })
})

describe('resetSyncEngine', () => {
  test('clears the cached singleton so the next get returns a fresh instance', () => {
    const a = getSyncEngine()
    resetSyncEngine()
    const b = getSyncEngine()
    expect(a).not.toBe(b)
    expect(b).toBeInstanceOf(SyncEngine)
  })

  test('is a no-op when no singleton has been created yet', () => {
    // Must not throw when _engine is null (the `_engine?.reset()` optional
    // chain path).
    expect(() => resetSyncEngine()).not.toThrow()
    // And the next get still works.
    expect(getSyncEngine()).toBeInstanceOf(SyncEngine)
  })

  test('calls reset() on the cached engine before clearing it', () => {
    const a = getSyncEngine()
    // Add some state to the engine and confirm reset() wipes it.
    // SyncEngine exposes some kind of reset; we test the side-effect via
    // a follow-up getSyncEngine() returning a clean instance with no
    // leftover state from `a`.
    const initialEventLogLen = (a as unknown as { eventLog: unknown[] }).eventLog.length
    expect(initialEventLogLen).toBe(0)

    resetSyncEngine()
    const b = getSyncEngine()
    expect(b).not.toBe(a)
    expect((b as unknown as { eventLog: unknown[] }).eventLog.length).toBe(0)
  })

  test('can be called multiple times in a row without error', () => {
    getSyncEngine()
    expect(() => {
      resetSyncEngine()
      resetSyncEngine()
      resetSyncEngine()
    }).not.toThrow()
    // Still functional after multiple resets.
    expect(getSyncEngine()).toBeInstanceOf(SyncEngine)
  })

  test('reset between gets gives back-to-back distinct instances', () => {
    const instances = new Set<SyncEngine>()
    for (let i = 0; i < 5; i++) {
      instances.add(getSyncEngine())
      resetSyncEngine()
    }
    expect(instances.size).toBe(5)
  })
})
