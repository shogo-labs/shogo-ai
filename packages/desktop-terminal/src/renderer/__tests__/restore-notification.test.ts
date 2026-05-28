// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  RestoreCoordinator,
  type RestoreClient,
  type SessionSnapshotSummary,
} from '../restore-notification'

// ─── fake client ─────────────────────────────────────────────────

interface FakeClient extends RestoreClient {
  setSnapshots(list: SessionSnapshotSummary[]): void
  setRestoreError(id: string | null, message?: string): void
  setListError(message: string | null): void
  /** Records all calls — for assertions. */
  calls: { fn: string; args: unknown[] }[]
}

function makeClient(): FakeClient {
  let snapshots: SessionSnapshotSummary[] = []
  let restoreErrorId: string | null = null
  let restoreErrorMessage = 'restore failed'
  let listError: string | null = null
  const calls: { fn: string; args: unknown[] }[] = []
  return {
    calls,
    async listSnapshots(workspaceHash) {
      calls.push({ fn: 'list', args: [workspaceHash] })
      if (listError) throw new Error(listError)
      return snapshots.filter((s) => s.workspaceHash === workspaceHash)
    },
    async restoreSession(workspaceHash, snapshotId) {
      calls.push({ fn: 'restore', args: [workspaceHash, snapshotId] })
      if (restoreErrorId === snapshotId) throw new Error(restoreErrorMessage)
      return { newSessionId: `new-${snapshotId}` }
    },
    async discardSnapshot(workspaceHash, snapshotId) {
      calls.push({ fn: 'discard', args: [workspaceHash, snapshotId] })
    },
    setSnapshots(list) { snapshots = list },
    setRestoreError(id, message) {
      restoreErrorId = id
      if (message) restoreErrorMessage = message
    },
    setListError(message) { listError = message },
  }
}

function snap(over: Partial<SessionSnapshotSummary> = {}): SessionSnapshotSummary {
  return {
    id: 's1',
    workspaceHash: 'ws-a',
    cwd: '/tmp',
    shell: '/bin/zsh',
    writtenAt: 1_700_000_000_000,
    ringBytes: 1024,
    ...over,
  }
}

// ─── silent mode ─────────────────────────────────────────────────

describe('RestoreCoordinator — silent mode', () => {
  it('moves idle → scanning → restoring → done with restoredCount', async () => {
    const client = makeClient()
    client.setSnapshots([snap({ id: 's1' }), snap({ id: 's2' })])
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1_700_000_000_000 })
    const states: string[] = []
    c.on((s) => states.push(s.state))
    await c.scan()
    expect(c.snapshot().state).toBe('done')
    expect(c.snapshot().restoredCount).toBe(2)
    expect(c.snapshot().snapshots.every((s) => s.accepted === true)).toBe(true)
    expect(c.snapshot().snapshots.every((s) => s.newSessionId)).toBe(true)
    expect(states).toContain('scanning')
    expect(states).toContain('restoring')
    expect(states).toContain('done')
  })

  it('transitions to idle when no snapshots found', async () => {
    const client = makeClient()
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-empty', now: () => 1_700_000_000_000 })
    await c.scan()
    expect(c.snapshot().state).toBe('idle')
    expect(c.snapshot().snapshots).toEqual([])
  })

  it('records error per-snapshot but stays in done if any succeeded', async () => {
    const client = makeClient()
    client.setSnapshots([snap({ id: 's1' }), snap({ id: 's2' })])
    client.setRestoreError('s1', 'host unreachable')
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1_700_000_000_000 })
    await c.scan()
    expect(c.snapshot().state).toBe('done')
    expect(c.snapshot().restoredCount).toBe(1)
    expect(c.snapshot().errorMessage).toBe('host unreachable')
    const failed = c.snapshot().snapshots.find((s) => s.id === 's1')!
    expect(failed.accepted).toBe(false)
  })

  it('transitions to error when ALL restores fail', async () => {
    const client = makeClient()
    client.setSnapshots([snap({ id: 's1' })])
    client.setRestoreError('s1', 'no shell')
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1_700_000_000_000 })
    await c.scan()
    expect(c.snapshot().state).toBe('error')
    expect(c.snapshot().restoredCount).toBe(0)
  })

  it('passes workspaceHash to listSnapshots', async () => {
    const client = makeClient()
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-xyz', now: () => 0 })
    await c.scan()
    expect(client.calls[0]).toEqual({ fn: 'list', args: ['ws-xyz'] })
  })
})

// ─── prompt mode ─────────────────────────────────────────────────

describe('RestoreCoordinator — prompt mode', () => {
  it('stops at offering with snapshots; restore() advances to done', async () => {
    const client = makeClient()
    client.setSnapshots([snap({ id: 's1' }), snap({ id: 's2' })])
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', mode: 'prompt', now: () => 1_700_000_000_000 })
    await c.scan()
    expect(c.snapshot().state).toBe('offering')
    expect(c.snapshot().snapshots.length).toBe(2)
    // No restore calls yet.
    expect(client.calls.filter((c) => c.fn === 'restore')).toHaveLength(0)
    await c.accept()
    expect(c.snapshot().state).toBe('done')
    expect(c.snapshot().restoredCount).toBe(2)
  })

  it('accept(ids) only restores the supplied ids', async () => {
    const client = makeClient()
    client.setSnapshots([snap({ id: 's1' }), snap({ id: 's2' }), snap({ id: 's3' })])
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', mode: 'prompt', now: () => 1_700_000_000_000 })
    await c.scan()
    await c.accept(['s1', 's3'])
    expect(c.snapshot().restoredCount).toBe(2)
    const restoredIds = client.calls.filter((c) => c.fn === 'restore').map((c) => c.args[1])
    expect(restoredIds.sort()).toEqual(['s1', 's3'])
  })

  it('dismiss() discards all snapshots and moves to done with restoredCount=0', async () => {
    const client = makeClient()
    client.setSnapshots([snap({ id: 's1' }), snap({ id: 's2' })])
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', mode: 'prompt', now: () => 1_700_000_000_000 })
    await c.scan()
    await c.dismiss()
    expect(c.snapshot().state).toBe('done')
    expect(c.snapshot().restoredCount).toBe(0)
    const discardedIds = client.calls.filter((c) => c.fn === 'discard').map((c) => c.args[1])
    expect(discardedIds.sort()).toEqual(['s1', 's2'])
  })

  it('accept / dismiss are no-ops outside the offering state', async () => {
    const client = makeClient()
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', mode: 'prompt' })
    await c.accept()
    await c.dismiss()
    expect(client.calls.filter((c) => c.fn === 'restore')).toHaveLength(0)
    expect(client.calls.filter((c) => c.fn === 'discard')).toHaveLength(0)
  })
})

// ─── max age filtering ─────────────────────────────────────────

describe('RestoreCoordinator — maxAgeMs', () => {
  it('drops snapshots older than the cutoff and discards them', async () => {
    const client = makeClient()
    const now = 1_700_000_000_000
    client.setSnapshots([
      snap({ id: 'fresh', writtenAt: now - 1_000 }),
      snap({ id: 'stale', writtenAt: now - (8 * 24 * 3600 * 1000) }), // 8 days old
    ])
    const c = new RestoreCoordinator({
      client, workspaceHash: 'ws-a', mode: 'prompt',
      maxAgeMs: 7 * 24 * 3600 * 1000,
      now: () => now,
    })
    await c.scan()
    expect(c.snapshot().snapshots.map((s) => s.id)).toEqual(['fresh'])
    // give the discard microtasks a chance to settle
    await new Promise((r) => setTimeout(r, 5))
    expect(client.calls.find((c) => c.fn === 'discard' && c.args[1] === 'stale')).toBeTruthy()
  })

  it('returns idle when ALL snapshots are stale', async () => {
    const client = makeClient()
    const now = 1_700_000_000_000
    client.setSnapshots([
      snap({ id: 'a', writtenAt: 0 }),
      snap({ id: 'b', writtenAt: 0 }),
    ])
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => now, mode: 'prompt' })
    await c.scan()
    expect(c.snapshot().state).toBe('idle')
  })
})

// ─── idempotency + acknowledge ─────────────────────────────────

describe('RestoreCoordinator — idempotency + acknowledge', () => {
  it('scan() is idempotent — repeated calls do not re-list', async () => {
    const client = makeClient()
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1 })
    await c.scan()
    await c.scan()
    await c.scan()
    expect(client.calls.filter((c) => c.fn === 'list')).toHaveLength(1)
  })

  it('acknowledge() transitions done → idle and clears state', async () => {
    const client = makeClient()
    client.setSnapshots([snap()])
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1_700_000_000_000 })
    await c.scan()
    expect(c.snapshot().state).toBe('done')
    c.acknowledge()
    expect(c.snapshot().state).toBe('idle')
    expect(c.snapshot().snapshots).toEqual([])
    expect(c.snapshot().restoredCount).toBe(0)
  })

  it('acknowledge() also clears error state', async () => {
    const client = makeClient()
    client.setListError('boom')
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1 })
    await c.scan()
    expect(c.snapshot().state).toBe('error')
    c.acknowledge()
    expect(c.snapshot().state).toBe('idle')
    expect(c.snapshot().errorMessage).toBeNull()
  })

  it('acknowledge() is a no-op outside done / error', async () => {
    const client = makeClient()
    client.setSnapshots([snap()])
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', mode: 'prompt', now: () => 1_700_000_000_000 })
    await c.scan()
    expect(c.snapshot().state).toBe('offering')
    c.acknowledge()
    expect(c.snapshot().state).toBe('offering')
  })
})

// ─── listener lifecycle ────────────────────────────────────────

describe('RestoreCoordinator — listener lifecycle', () => {
  it('fires listeners on every state change', async () => {
    const client = makeClient()
    client.setSnapshots([snap()])
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1_700_000_000_000 })
    let count = 0
    c.on(() => count++)
    await c.scan()
    expect(count).toBeGreaterThanOrEqual(3) // scanning, restoring, done
  })

  it('unsubscribe stops further notifications', async () => {
    const client = makeClient()
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1 })
    let count = 0
    const off = c.on(() => count++)
    off()
    await c.scan()
    expect(count).toBe(0)
  })

  it('dispose clears listeners', async () => {
    const client = makeClient()
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1 })
    let count = 0
    c.on(() => count++)
    c.dispose()
    await c.scan()
    expect(count).toBe(0)
  })
})

// ─── error paths ───────────────────────────────────────────────

describe('RestoreCoordinator — error paths', () => {
  it('listSnapshots throw → state error + errorMessage', async () => {
    const client = makeClient()
    client.setListError('host down')
    const c = new RestoreCoordinator({ client, workspaceHash: 'ws-a', now: () => 1 })
    await c.scan()
    expect(c.snapshot().state).toBe('error')
    expect(c.snapshot().errorMessage).toBe('host down')
  })
})
