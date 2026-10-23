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
 */

import { describe, expect, it } from 'bun:test'
import {
  MACHINE_RETRY_CAP_MS,
  MACHINE_RETRY_BASE_MS,
  MachineWorkspaceStateStore,
  describeLastSynced,
  describeMachineWorkspace,
  isMachineConditionError,
  parseRetryAfter,
} from '../machine-workspace-state'

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
  it('recognises the three machine codes and nothing else', () => {
    expect(isMachineConditionError({ status: 503, code: 'waking' })).toBe(true)
    expect(isMachineConditionError({ status: 503, code: 'runtime_starting' })).toBe(true)
    expect(isMachineConditionError({ status: 409, code: 'machine_offline_readonly' })).toBe(true)
    expect(isMachineConditionError({ status: 409, code: 'machine_timeout' })).toBe(true)
    // A 500 is the workspace's own problem and must still be shown.
    expect(isMachineConditionError({ status: 500, code: 'internal' })).toBe(false)
    expect(isMachineConditionError({ status: 503, code: 'unavailable' })).toBe(false)
    expect(isMachineConditionError(new Error('network down'))).toBe(false)
  })
})

describe('the store a screen subscribes to', () => {
  it('moves to offline on the read-only refusal, and reports who to tell', () => {
    const store = new MachineWorkspaceStateStore()
    const seen: string[] = []
    store.subscribe((condition) => seen.push(condition.kind))

    const condition = store.report({ status: 409, code: 'machine_offline_readonly' })

    expect(condition.kind).toBe('offline')
    expect(seen).toEqual(['offline'])
  })

  it('backs off while waking, honours Retry-After, and caps at a minute', () => {
    const store = new MachineWorkspaceStateStore()

    const first = store.report({ status: 503, code: 'waking' }, NOW)
    expect(first).toEqual({ kind: 'waking', retryAfterMs: MACHINE_RETRY_BASE_MS, attempt: 1 })

    const second = store.report({ status: 503, code: 'runtime_starting' }, NOW)
    expect(second).toEqual({ kind: 'waking', retryAfterMs: MACHINE_RETRY_BASE_MS * 2, attempt: 2 })

    const asked = store.report(
      { status: 503, code: 'waking', headers: { get: (name: string) => (name === 'retry-after' ? '7' : null) } },
      NOW,
    )
    expect(asked).toEqual({ kind: 'waking', retryAfterMs: 7_000, attempt: 3 })

    // Ten failures in, the backoff is still a minute, not five.
    for (let i = 0; i < 10; i++) store.report({ status: 503, code: 'waking' }, NOW)
    const capped = store.get()
    expect(capped.kind).toBe('waking')
    if (capped.kind === 'waking') expect(capped.retryAfterMs).toBeLessThanOrEqual(MACHINE_RETRY_CAP_MS)
  })

  it('leaves an ordinary error to the screen that made the request', () => {
    const store = new MachineWorkspaceStateStore()
    store.report({ status: 409, code: 'machine_offline_readonly' })

    expect(store.report({ status: 500, code: 'internal' }).kind).toBe('offline')
    expect(store.report(new Error('boom')).kind).toBe('offline')
  })

  it('clears the moment a request comes back, and forgets the attempt count', () => {
    const store = new MachineWorkspaceStateStore()
    const seen: string[] = []
    store.subscribe((condition) => seen.push(condition.kind))

    store.report({ status: 503, code: 'waking' })
    store.markOk()
    store.markOk()

    expect(store.get().kind).toBe('ok')
    expect(seen).toEqual(['waking', 'ok'])
    // A later failure starts the backoff over rather than jumping to 4s.
    expect(store.report({ status: 503, code: 'waking' })).toEqual({
      kind: 'waking',
      retryAfterMs: MACHINE_RETRY_BASE_MS,
      attempt: 1,
    })
  })
})
