// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression test for SHOG-592: import modal hangs on "Setting up project"
// in k8s mode.
// =============================================================================
//
// The old k8s import path emitted exactly one SSE event (`install/skipped`),
// leaving generate/preview/health spinning in the modal forever. The fix —
// `bridgePodBootstrap` — polls the agent pod's `GET /preview/status` and
// translates its `phase` field into the four ImportEvent step events the
// modal already understands.
//
// This test covers the contract `bridgePodBootstrap` promises to its caller:
//
//   1. Phase progression ('installing' → 'building' → 'ready') emits the
//      correct sequence of step events, in the correct order, and with no
//      duplicates.
//   2. Pod URL resolution failure → every step terminates with `failed` so
//      the modal can close.
//   3. SSE-closed `emit` (throws) doesn't tear down the polling loop —
//      bridge keeps reading phases and just stops emitting.
//
// Run: bun test apps/api/src/routes/__tests__/project-import-bridge-pod-bootstrap.test.ts

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'

// Avoid pulling the heavy module graph (Prisma, S3, agent SDK) just to test
// the bridge. We import the file under test only after mocking its
// `getProjectPodUrl` dependency and `fetch`.
type ImportEvent = {
  phase: 'bootstrap'
  step: 'install' | 'generate' | 'preview' | 'health'
  status: 'running' | 'ok' | 'failed' | 'skipped'
  message?: string
}

const PROJECT_ID = 'proj_test_shog592'

// Hold a reference to the mocked fetch so tests can swap behavior per case.
let mockFetch: (url: string, init?: any) => Promise<Response>
const originalFetch = globalThis.fetch

beforeEach(() => {
  // Default fetch: deny — individual tests override.
  mockFetch = async () => new Response('not configured', { status: 500 })
  // @ts-expect-error — replacing global fetch is intentional
  globalThis.fetch = (url: string, init?: any) => mockFetch(url, init)

  // Default getProjectPodUrl: returns a pod URL immediately.
  mock.module('../../lib/knative-project-manager', () => ({
    getProjectPodUrl: async () => 'http://pod.test.svc.cluster.local',
  }))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

function collectEvents() {
  const events: ImportEvent[] = []
  return {
    events,
    emit: (ev: ImportEvent) => {
      events.push(ev)
    },
  }
}

// Fast deadlines so tests don't sit in real timeouts. Production defaults
// (120s pod, 5min bootstrap) are exercised by integration / canary, not
// unit tests — keeping CI fast.
const FAST_OPTS = {
  podDeadlineMs: 500,
  podPerAttemptMs: 200,
  podRetryIntervalMs: 50,
  bootstrapDeadlineMs: 3_000,
  pollIntervalMs: 50,
  maxConsecutiveErrors: 5,
} as const

describe('bridgePodBootstrap — k8s import lifecycle', () => {
  test('phase progression emits each step in order, no duplicates', async () => {
    // Pod walks: installing → generating-prisma → building → ready.
    // Build a script of phases the mocked /preview/status returns, one per
    // poll. The bridge polls every 1.5s; we short-circuit by advancing
    // through the script as fast as fetch is called.
    const phaseScript = [
      'installing',
      'installing',
      'generating-prisma',
      'building',
      'starting-api',
      'ready',
    ]
    let cursor = 0
    mockFetch = async (url: string) => {
      expect(url).toContain('/preview/status')
      const phase = phaseScript[Math.min(cursor++, phaseScript.length - 1)]
      return new Response(JSON.stringify({ phase }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { events, emit } = collectEvents()
    const { bridgePodBootstrap } = await import('../project-export-import')
    await bridgePodBootstrap(PROJECT_ID, emit, FAST_OPTS)

    // Every event must be a bootstrap event for one of our four steps.
    for (const ev of events) {
      expect(ev.phase).toBe('bootstrap')
      expect(['install', 'generate', 'preview', 'health']).toContain(ev.step)
    }

    // Per-step transitions must be monotonic: running -> ok (no going back).
    const byStep: Record<string, string[]> = {
      install: [], generate: [], preview: [], health: [],
    }
    for (const ev of events) byStep[ev.step].push(ev.status)

    expect(byStep.install).toEqual(['running', 'ok'])
    expect(byStep.generate).toEqual(['running', 'ok'])
    expect(byStep.preview).toEqual(['running', 'ok'])
    // Health flips straight to ok on `ready` — no transient running emitted.
    expect(byStep.health).toEqual(['ok'])
  }, 30_000)

  test('pod URL never resolves → all four steps end as failed', async () => {
    mock.module('../../lib/knative-project-manager', () => ({
      getProjectPodUrl: async () => null,
    }))

    const { events, emit } = collectEvents()
    const { bridgePodBootstrap } = await import('../project-export-import')
    await bridgePodBootstrap(PROJECT_ID, emit, FAST_OPTS)

    const terminalsByStep: Record<string, string> = {}
    for (const ev of events) terminalsByStep[ev.step] = ev.status
    expect(terminalsByStep.install).toBe('failed')
    expect(terminalsByStep.generate).toBe('failed')
    expect(terminalsByStep.preview).toBe('failed')
    expect(terminalsByStep.health).toBe('failed')
  }, 10_000)

  test('SSE-closed emit (throws) does not crash the bridge', async () => {
    mockFetch = async () =>
      new Response(JSON.stringify({ phase: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

    let emitCalls = 0
    const emit = (_ev: ImportEvent) => {
      emitCalls++
      throw new Error('client navigated away — SSE closed')
    }

    const { bridgePodBootstrap } = await import('../project-export-import')
    await expect(bridgePodBootstrap(PROJECT_ID, emit, FAST_OPTS)).resolves.toBeUndefined()
    // We tried to emit at least once before the loop terminated on the
    // `ready` phase mapping (4 steps × 1 emit = 4 attempts).
    expect(emitCalls).toBeGreaterThanOrEqual(1)
  }, 30_000)

  test('pod reports install error → install: failed pins, never overwritten by ready', async () => {
    // Regression for the silent-failure edge case. PreviewManager catches
    // install failures and marches _phase forward anyway. Without the
    // errors-aware emit + terminal lock, we'd report install: ok once the
    // pod hit `ready`. With them, install: failed wins and stays.
    const phaseScript = ['installing', 'building', 'starting-api', 'ready']
    let cursor = 0
    mockFetch = async () => {
      const phase = phaseScript[Math.min(cursor++, phaseScript.length - 1)]
      return new Response(
        JSON.stringify({
          phase,
          errors: { install: 'ENOSPC: no space left on device', generate: null },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const { events, emit } = collectEvents()
    const { bridgePodBootstrap } = await import('../project-export-import')
    await bridgePodBootstrap(PROJECT_ID, emit, FAST_OPTS)

    // Final state per step.
    const finalByStep: Record<string, ImportEvent | undefined> = {}
    for (const ev of events) finalByStep[ev.step] = ev

    expect(finalByStep.install?.status).toBe('failed')
    expect(finalByStep.install?.message).toContain('ENOSPC')
    // Generate / preview / health still get to report ok (those stages
    // succeeded; we only pin failure on the stage that actually broke).
    expect(finalByStep.generate?.status).toBe('ok')
    expect(finalByStep.preview?.status).toBe('ok')
    expect(finalByStep.health?.status).toBe('ok')

    // Belt-and-braces: install was never emitted as `ok` even after the
    // pod reached `ready` (would have been a regression of the bug).
    const installStatuses = events.filter((e) => e.step === 'install').map((e) => e.status)
    expect(installStatuses).not.toContain('ok')
  }, 10_000)

  test('unknown phase string is treated as transient, eventually fails out', async () => {
    // Pod is alive (200 OK) but returns a phase value the bridge doesn't
    // know — likely a runtime image newer than the API. Before the fix,
    // the bridge spun silently until the 5-min cap. Now: each unknown
    // counts as a poll error and the consecutive-error bailout fires.
    mockFetch = async () =>
      new Response(JSON.stringify({ phase: 'futuristic-new-phase' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })

    const { events, emit } = collectEvents()
    const { bridgePodBootstrap } = await import('../project-export-import')
    const t0 = Date.now()
    await bridgePodBootstrap(PROJECT_ID, emit, FAST_OPTS)
    const elapsedMs = Date.now() - t0

    // FAST_OPTS: maxConsecutiveErrors=5 × pollIntervalMs=50ms = ~250ms
    // budget for the unknown-phase loop. Whole thing should be well
    // under the bootstrap deadline.
    expect(elapsedMs).toBeLessThan(FAST_OPTS.bootstrapDeadlineMs)

    const finalByStep: Record<string, string> = {}
    for (const ev of events) finalByStep[ev.step] = ev.status
    expect(finalByStep.install).toBe('failed')
    expect(finalByStep.generate).toBe('failed')
    expect(finalByStep.preview).toBe('failed')
    expect(finalByStep.health).toBe('failed')
  }, 10_000)

  test('getProjectPodUrl hangs → per-attempt timeout fires, bridge fails out', async () => {
    // Real-world failure: knative call blocks indefinitely. Without the
    // Promise.race wrapper, the bridge would inherit that hang and never
    // hit its outer deadline. With it, each attempt times out and the
    // outer pod deadline closes the loop.
    mock.module('../../lib/knative-project-manager', () => ({
      getProjectPodUrl: () => new Promise(() => { /* never resolves */ }),
    }))

    const { events, emit } = collectEvents()
    const { bridgePodBootstrap } = await import('../project-export-import')
    const t0 = Date.now()
    await bridgePodBootstrap(PROJECT_ID, emit, FAST_OPTS)
    const elapsedMs = Date.now() - t0

    // Must close out within FAST_OPTS.podDeadlineMs (+ slack), not hang.
    expect(elapsedMs).toBeLessThan(FAST_OPTS.podDeadlineMs + 1_000)
    const finalByStep: Record<string, string> = {}
    for (const ev of events) finalByStep[ev.step] = ev.status
    expect(finalByStep.install).toBe('failed')
  }, 10_000)
})
