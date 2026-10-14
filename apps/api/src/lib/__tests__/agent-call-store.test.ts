// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, it } from 'bun:test'
import { _testing, getAgentCall, putAgentCall, waitForAgentCall } from '../agent-call-store'

const base = { runId: 'run-1', startedAt: 1, updatedAt: 1 }

beforeEach(() => _testing.records.clear())

describe('agent-call-store (in-memory fallback)', () => {
  it('scopes records by project', async () => {
    await putAgentCall('proj-a', { ...base, status: 'running' })
    expect((await getAgentCall('proj-a', 'run-1'))?.status).toBe('running')
    expect(await getAgentCall('proj-b', 'run-1')).toBeUndefined()
  })

  it('waitForAgentCall returns undefined for an unknown run without waiting', async () => {
    const t0 = Date.now()
    expect(await waitForAgentCall('proj-a', 'nope', 5_000)).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('waitForAgentCall returns early once the call settles', async () => {
    await putAgentCall('proj-a', { ...base, status: 'running' })
    setTimeout(() => void putAgentCall('proj-a', { ...base, status: 'completed', reply: 'done' }), 30)
    const t0 = Date.now()
    const rec = await waitForAgentCall('proj-a', 'run-1', 5_000, { pollIntervalMs: 5 })
    expect(rec).toMatchObject({ status: 'completed', reply: 'done' })
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('waitForAgentCall returns the running record after waitMs', async () => {
    await putAgentCall('proj-a', { ...base, status: 'running' })
    const rec = await waitForAgentCall('proj-a', 'run-1', 30, { pollIntervalMs: 5 })
    expect(rec?.status).toBe('running')
  })
})
