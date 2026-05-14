// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for the dual-singleton bug in
 * `apps/api/src/lib/runtime`.
 *
 * Before the fix, two RuntimeManager instances would lazy-initialise
 * independently:
 *
 *   1. `apps/api/src/server.ts` owns env-var parsing
 *      (`RUNTIME_MAX_COUNT`, `RUNTIME_DOMAIN_SUFFIX`, `WORKSPACES_DIR`)
 *      and stored its instance in a module-local variable.
 *   2. `apps/api/src/lib/runtime/index.ts` exported `getRuntimeManager`
 *      which lazy-created its OWN `defaultManager`.
 *
 * `resolve-pod-url.ts` falls back to (2). The first chat request
 * triggered a second `new RuntimeManager(...)` whose constructor's
 * `cleanupStaleProcesses()` SIGKILLed the still-starting Vite child
 * the first manager had just spawned.
 *
 * The fix adds `setRuntimeManager()` to `manager.ts` so the server can
 * install its configured instance as the canonical singleton. This
 * test pins:
 *
 *   - `setRuntimeManager(rm)` followed by `getRuntimeManager()` returns
 *     the same instance.
 *   - No second `new RuntimeManager(...)` is constructed once a
 *     singleton has been installed (which is what guarantees the
 *     `cleanupStaleProcesses()` call only runs once).
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  RuntimeManager,
  getRuntimeManager,
  setRuntimeManager,
  createRuntimeManager,
} from '../lib/runtime'

describe('RuntimeManager singleton', () => {
  beforeEach(() => {
    // Reset by overwriting the singleton with a fresh manager. This is
    // the same mechanism real code uses — the module never exposes a
    // "clear" API on purpose, since the canonical lifecycle is
    // construct-once-per-process.
    setRuntimeManager(new RuntimeManager())
  })

  test('setRuntimeManager + getRuntimeManager round-trip the same instance', () => {
    const rm = new RuntimeManager()
    setRuntimeManager(rm)
    expect(getRuntimeManager()).toBe(rm)
    expect(getRuntimeManager()).toBe(rm)
  })

  test('createRuntimeManager() always returns a NEW instance (not a singleton)', () => {
    const a = createRuntimeManager()
    const b = createRuntimeManager()
    expect(a).not.toBe(b)
  })

  test('after setRuntimeManager(server-configured), getRuntimeManager returns it (no second construction)', () => {
    // Simulates apps/api/src/server.ts: build the manager with env-var
    // overrides, then install it. Any later `getRuntimeManager()` call
    // — whether from server.ts itself or resolve-pod-url.ts's fallback
    // path — must resolve to this exact instance, not lazy-create a
    // second one (which would re-trigger cleanupStaleProcesses and
    // SIGKILL the first manager's Vite children).
    const serverConfigured = createRuntimeManager({
      maxRuntimes: 5,
      domainSuffix: 'example.test',
    })
    setRuntimeManager(serverConfigured)

    const resolved = getRuntimeManager()
    expect(resolved).toBe(serverConfigured)
  })
})
