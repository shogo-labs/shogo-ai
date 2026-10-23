// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The three states a machine workspace can be in, and what each one says
 * (SHO-185, AC4).
 *
 * The wording and the flags are asserted here rather than in a rendered chat:
 * the value a banner and a composer need is this function's output, and this
 * repo has no React Native renderer for the mobile screens — so the test that
 * can actually fail is the view model's.
 *
 * The failures are built the way the app really produces them: a real
 * `ShogoError.fromStatus(status, message, body)` over the real body the cloud's
 * machine routes send (see `apps/api/src/routes/machines.ts`). An earlier
 * version of this file hand-built `{ status, code }` objects, which asserted a
 * seam nothing in the app uses — the SDK puts the API's code in `details`, and
 * its own `code` is the status map (`409 → 'CONFLICT'`). That story passed
 * while every real failure classified as `ok`.
 */

import { describe, expect, it } from 'bun:test'
import { ShogoError } from '@shogo-ai/sdk'
import {
  MACHINE_RETRY_CAP_MS,
  MACHINE_RETRY_BASE_MS,
  MachineWorkspaceStateStore,
  describeLastSynced,
  describeMachineWorkspace,
  errorLastSyncedAt,
  isMachineConditionError,
  parseRetryAfter,
} from '../machine-workspace-state'

/** The 409 the cloud answers a write to a sleeping machine with. */
function offlineReadOnly(lastSyncedAt: string | null = null): ShogoError {
  return ShogoError.fromStatus(
    409,
    'Russell\'s MacBook is offline — this workspace is read-only until it is back',
    {
      error: {
        code: 'machine_offline_readonly',
        message: "Russell's MacBook is offline — this workspace is read-only until it is back",
        lastSyncedAt,
      },
    },
  )
}

/** The 503 the cloud answers while the machine's tunnel is coming up. */
function waking(code: 'waking' | 'runtime_starting' = 'waking', retryAfterSeconds = 3): ShogoError {
  return ShogoError.fromStatus(503, 'Starting the machine runtime', {
    error: {
      code,
      message: code === 'waking' ? "Russell's MacBook is waking up" : 'Starting the machine runtime',
      retryAfterSeconds,
    },
  })
}

/** Waking with no wait in the body, so the local backoff has to decide. */
function wakingWithoutWait(): ShogoError {
  return ShogoError.fromStatus(503, "Russell's MacBook is waking up", {
    error: { code: 'waking', message: "Russell's MacBook is waking up" },
  })
}

/** The 409 for a request that never came back through the tunnel. */
function machineTimeout(): ShogoError {
  return ShogoError.fromStatus(409, 'did not answer in time', {
    error: {
      code: 'machine_timeout',
      message: "Russell's MacBook is connected but did not answer in time",
      detail: 'no response in 30000ms',
    },
  })
}

/** An ordinary failure inside the workspace: not a machine state. */
function serverError(): ShogoError {
  return ShogoError.fromStatus(500, 'Something broke', {
    error: { code: 'internal', message: 'Something broke' },
  })
}

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0)

describe('the banner for a machine that is asleep', () => {
  it('names the machine, says it is offline, and says when it last synced', () => {
    const view = describeMachineWorkspace(
      { kind: 'offline' },
      { machineName: "Russell's MacBook", lastSyncedAt: new Date(NOW - 42 * 60_000).toISOString(), now: NOW },
    )

    expect(view.banner).toBe("Russell's MacBook is offline — last synced 42m ago")
    expect(view.tone).toBe('offline')
    expect(view.composeDisabled).toBe(true)
    expect(view.retryAfterMs).toBeNull()
  })

  it('says "never" rather than a date it does not have, and never shows the id', () => {
    const view = describeMachineWorkspace({ kind: 'offline' }, { machineName: null, lastSyncedAt: null })

    expect(view.banner).toBe('Your Mac is offline — last synced never')
    expect(view.banner).not.toContain('undefined')
  })
})

describe('the banner while the machine is waking', () => {
  it('says it is waking and carries the wait the server asked for', () => {
    const view = describeMachineWorkspace(
      { kind: 'waking', retryAfterMs: 5_000, attempt: 1 },
      { machineName: "Russell's MacBook" },
    )

    expect(view.banner).toBe("Waking Russell's MacBook…")
    expect(view.tone).toBe('waking')
    expect(view.composeDisabled).toBe(true)
    expect(view.retryAfterMs).toBe(5_000)
  })
})

describe('no banner when the machine is fine', () => {
  it('renders nothing and leaves the composer alone', () => {
    expect(describeMachineWorkspace({ kind: 'ok' })).toEqual({
      banner: null,
      tone: 'none',
      composeDisabled: false,
      retryAfterMs: null,
    })
  })
})

describe('how long a last sync ago was', () => {
  it('reads as just now, minutes, hours and days', () => {
    expect(describeLastSynced(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now')
    expect(describeLastSynced(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago')
    expect(describeLastSynced(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h ago')
    expect(describeLastSynced(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe('2d ago')
    // A clock behind the cloud is not "-4m ago".
    expect(describeLastSynced(new Date(NOW + 4 * 60_000).toISOString(), NOW)).toBe('just now')
    expect(describeLastSynced(null, NOW)).toBe('never')
    expect(describeLastSynced('not a date', NOW)).toBe('never')
  })
})

describe('Retry-After', () => {
  it('takes seconds, dates and numbers, and never waits past a minute', () => {
    expect(parseRetryAfter('2')).toBe(2_000)
    expect(parseRetryAfter('600')).toBe(MACHINE_RETRY_CAP_MS)
    expect(parseRetryAfter(new Date(NOW + 3_000).toUTCString(), NOW)).toBe(3_000)
    expect(parseRetryAfter(1.5)).toBe(1_500)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('nonsense')).toBeNull()
  })
})

describe('what counts as a machine state and what is just an error', () => {
  it('recognises the three machine codes the API sends, through the error the client throws', () => {
    expect(isMachineConditionError(waking('waking'))).toBe(true)
    expect(isMachineConditionError(waking('runtime_starting'))).toBe(true)
    expect(isMachineConditionError(offlineReadOnly())).toBe(true)
    expect(isMachineConditionError(machineTimeout())).toBe(true)
  })

  it('does not mistake a real error for a machine state', () => {
    // A 500 is the workspace's own problem and must still be shown.
    expect(isMachineConditionError(serverError())).toBe(false)
    // The status alone is not enough: a 503 with someone else's code is not a wake.
    expect(
      isMachineConditionError(
        ShogoError.fromStatus(503, 'unavailable', { error: { code: 'unavailable' } }),
      ),
    ).toBe(false)
    // And the status map the SDK puts on `code` must never be read as a machine code.
    expect(ShogoError.fromStatus(409, 'conflict', {}).code).toBe('CONFLICT')
    expect(isMachineConditionError(ShogoError.fromStatus(409, 'conflict', {}))).toBe(false)
    expect(isMachineConditionError(new Error('network down'))).toBe(false)
  })
})

describe('the store a screen subscribes to', () => {
  it('moves to offline on the read-only refusal, and reports who to tell', () => {
    const store = new MachineWorkspaceStateStore()
    const seen: string[] = []
    store.subscribe((condition) => seen.push(condition.kind))

    const condition = store.report(offlineReadOnly())

    expect(condition.kind).toBe('offline')
    expect(seen).toEqual(['offline'])
  })

  it('carries the last-sync time off the refusal, so the banner can say when', () => {
    const store = new MachineWorkspaceStateStore()
    const lastSyncedAt = new Date(NOW - 42 * 60_000).toISOString()

    const condition = store.report(offlineReadOnly(lastSyncedAt))

    expect(condition).toEqual({ kind: 'offline', lastSyncedAt })
    expect(
      describeMachineWorkspace(condition, { machineName: "Russell's MacBook", now: NOW }).banner,
    ).toBe("Russell's MacBook is offline — last synced 42m ago")
  })

  it('backs off while waking, honours the wait the server asked for, and caps at a minute', () => {
    const store = new MachineWorkspaceStateStore()

    const first = store.report(waking('waking', 3), NOW)
    // The server's own number wins over the local backoff, in seconds.
    expect(first).toEqual({ kind: 'waking', retryAfterMs: 3_000, attempt: 1 })
    expect(MACHINE_RETRY_BASE_MS).toBeLessThan(3_000)

    const second = store.report(waking('runtime_starting', 6), NOW)
    expect(second).toEqual({ kind: 'waking', retryAfterMs: 6_000, attempt: 2 })

    // Ten failures in, the wait is still a minute, not five.
    for (let i = 0; i < 10; i++) store.report(waking('waking', 600), NOW)
    const capped = store.get()
    expect(capped.kind).toBe('waking')
    if (capped.kind === 'waking') {
      expect(capped.retryAfterMs).toBe(MACHINE_RETRY_CAP_MS)
      expect(capped.attempt).toBe(12)
    }
  })

  it('falls back to doubling backoff when the body carries no wait', () => {
    const store = new MachineWorkspaceStateStore()

    expect(store.report(wakingWithoutWait())).toEqual({
      kind: 'waking',
      retryAfterMs: MACHINE_RETRY_BASE_MS,
      attempt: 1,
    })
  })

  it('leaves an ordinary error to the screen that made the request', () => {
    const store = new MachineWorkspaceStateStore()
    store.report(offlineReadOnly())

    expect(store.report(serverError()).kind).toBe('offline')
    expect(store.report(new Error('boom')).kind).toBe('offline')
  })

  it('clears the moment a request comes back, and forgets the attempt count', () => {
    const store = new MachineWorkspaceStateStore()
    const seen: string[] = []
    store.subscribe((condition) => seen.push(condition.kind))

    store.report(waking())
    store.markOk()
    store.markOk()

    expect(store.get().kind).toBe('ok')
    expect(seen).toEqual(['waking', 'ok'])
    // A later failure starts the backoff over rather than jumping to 4s.
    expect(store.report(wakingWithoutWait())).toEqual({
      kind: 'waking',
      retryAfterMs: MACHINE_RETRY_BASE_MS,
      attempt: 1,
    })
  })
})

describe('the last-sync time on a refusal', () => {
  it('reads it out of the body, and says nothing when it is absent', () => {
    const iso = new Date(NOW - 60_000).toISOString()
    expect(errorLastSyncedAt(offlineReadOnly(iso))).toBe(iso)
    expect(errorLastSyncedAt(offlineReadOnly(null))).toBeNull()
    expect(errorLastSyncedAt(serverError())).toBeNull()
    expect(errorLastSyncedAt(new Error('boom'))).toBeNull()
  })
})
