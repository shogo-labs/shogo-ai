// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression test for a TOCTOU race between `/pool/assign`'s rollback path
 * (`packages/shared-runtime/src/server-framework.ts`) and `server.ts`'s
 * fire-and-forget `startGateway()` call.
 *
 * Background
 * ==========
 * `onAssign` (server.ts) does:
 *
 *   await initializeEssentials()
 *   startGateway(projectId).catch(...)   // NOT awaited — last statement
 *
 * `startGateway()` runs synchronously up to its first real await:
 *
 *   const { AgentGateway } = await import('./gateway')
 *   agentGateway = new AgentGateway(WORKSPACE_DIR, state.currentProjectId!)
 *
 * Because `startGateway()` isn't awaited, `onAssign`'s returned promise
 * resolves (one microtask hop) essentially as soon as `startGateway()`
 * hits that `await import(...)` — which, even for an already-cached
 * module, reliably takes more microtask hops than a single `await` on an
 * already-settled promise. So the `/pool/assign` HTTP handler's own
 * `await config.onAssign(...)` continuation is very likely to run BEFORE
 * `startGateway()` resumes.
 *
 * If anything in that continuation throws — the handler's catch block
 * calls `rollbackToPool()`, which resets BOTH `state.currentProjectId` and
 * `process.env.PROJECT_ID` back to the warm-pool placeholder (`__POOL__`)
 * — then when `startGateway()` finally resumes and reads
 * `state.currentProjectId` fresh, it would (pre-fix) silently construct
 * `AgentGateway` for `__POOL__` instead of the project `onAssign` actually
 * ran for. That gateway then self-identifies as `__POOL__` in every
 * outbound call for the rest of the process's life (or, worse, until the
 * next suspend/resume — Firecracker snapshots preserve in-memory JS state
 * verbatim, so a poisoned gateway stays poisoned across resumes too; see
 * `gateway-stale-pool-projectid.test.ts` for that half of the incident).
 *
 * `server.ts` is a large, side-effecting, non-modular file (it binds a
 * port and kicks off pool-mode bootstrap as soon as it's imported), so
 * — consistent with how the rest of this suite exercises it only via a
 * spawned subprocess hitting real HTTP endpoints (see
 * `__tests__/integration/warm-pool.test.ts`) rather than unit-importing
 * its internals — this test isolates the exact guard *pattern* now used
 * by `startGateway()` (capture the target project id via closure before
 * the await, then re-verify live state matches it immediately after) and
 * proves both halves:
 *
 *   1. Without the guard (the old behavior — read shared state fresh,
 *      post-await), the race silently produces a gateway build for the
 *      WRONG (rolled-back) project id.
 *   2. With the guard (the current `startGateway()` behavior — snapshot
 *      the id pre-await, verify post-await, abort on mismatch), the race
 *      is caught and no gateway is built for the wrong project.
 */
import { describe, test, expect } from 'bun:test'

const POOL_PROJECT_ID = '__POOL__' // mirrors server-framework.ts's POOL_PROJECT_ID

interface FakeState {
  currentProjectId: string
  poolAssigned: boolean
}

/** `rollbackToPool()`'s effect on the two fields `startGateway()` cares about. */
function rollbackToPool(state: FakeState): void {
  state.poolAssigned = false
  state.currentProjectId = POOL_PROJECT_ID
}

/**
 * Stand-in for the pre-fix `startGateway()`: reads `state.currentProjectId`
 * fresh, AFTER the same kind of unbounded await `await import('./gateway')`
 * introduces, with no re-verification.
 */
async function startGatewayOld(
  state: FakeState,
  afterImport: () => Promise<void>,
): Promise<{ builtForProjectId: string } | { aborted: true }> {
  await afterImport() // stand-in for `await import('./gateway')`
  return { builtForProjectId: state.currentProjectId }
}

/**
 * The actual pattern now in `server.ts`'s `startGateway(expectedProjectId)`:
 * snapshot the target id BEFORE the await (closure-captured, immune to a
 * later `rollbackToPool()`), then re-verify live state matches it
 * immediately after resuming — abort instead of building on a mismatch.
 */
async function startGatewayFixed(
  state: FakeState,
  expectedProjectId: string,
  afterImport: () => Promise<void>,
): Promise<{ builtForProjectId: string } | { aborted: true }> {
  const targetProjectId = expectedProjectId
  await afterImport() // stand-in for `await import('./gateway')`
  if (state.currentProjectId !== targetProjectId || !state.poolAssigned) {
    return { aborted: true }
  }
  return { builtForProjectId: targetProjectId }
}

describe('startGateway() vs. a concurrent rollbackToPool() (regression)', () => {
  const REAL_PROJECT_ID = '2945c130-6774-4409-8239-f29ee1ffa299'

  test('pre-fix pattern: a rollback landing during the await silently builds the gateway for __POOL__', async () => {
    const state: FakeState = { currentProjectId: REAL_PROJECT_ID, poolAssigned: true }

    // Fire startGateway "in the background" (not awaited) — matches
    // `startGateway(projectId).catch(...)` in onAssign.
    const pending = startGatewayOld(state, async () => {
      // Simulates the assign handler's own continuation (after
      // `await config.onAssign(...)` resolves) running to completion,
      // including a throw that triggers rollbackToPool(), all before
      // startGateway's `await import(...)` resumes.
      rollbackToPool(state)
    })

    const result = await pending
    // This is the bug: the "gateway" gets built, but for the wrong project.
    expect('builtForProjectId' in result && result.builtForProjectId).toBe(POOL_PROJECT_ID)
  })

  test('fixed pattern: the same interleaving is detected and construction is aborted', async () => {
    const state: FakeState = { currentProjectId: REAL_PROJECT_ID, poolAssigned: true }

    const pending = startGatewayFixed(state, REAL_PROJECT_ID, async () => {
      rollbackToPool(state)
    })

    const result = await pending
    expect('aborted' in result && result.aborted).toBe(true)
  })

  test('fixed pattern: an interleaving with NO rollback still builds the gateway normally', async () => {
    const state: FakeState = { currentProjectId: REAL_PROJECT_ID, poolAssigned: true }

    const pending = startGatewayFixed(state, REAL_PROJECT_ID, async () => {
      // Nothing races us this time — state is untouched.
    })

    const result = await pending
    expect('builtForProjectId' in result && result.builtForProjectId).toBe(REAL_PROJECT_ID)
  })

  test('fixed pattern: a legitimate re-assignment to a DIFFERENT project during the await is also treated as a mismatch, not silently adopted', async () => {
    const state: FakeState = { currentProjectId: REAL_PROJECT_ID, poolAssigned: true }
    const OTHER_PROJECT_ID = 'some-other-project-id'

    const pending = startGatewayFixed(state, REAL_PROJECT_ID, async () => {
      // Whatever changed it, this startGateway() call was closure-bound to
      // REAL_PROJECT_ID and must not adopt a different live value either.
      state.currentProjectId = OTHER_PROJECT_ID
    })

    const result = await pending
    expect('aborted' in result && result.aborted).toBe(true)
  })
})
