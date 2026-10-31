// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * What open() reports about a wake, and which snapshots it keeps.
 *
 * Production (2026-10): ~44% of wakes cold-booted, mostly because a sibling
 * runtime had re-exported a member's writable state after the snapshot was
 * taken. Data drift is now repaired on resume; the /assign response carries a
 * per-phase breakdown and, on a cold boot, why no snapshot was used.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { metrics, M } from './metrics'
import { MetalWarmPool } from './pool'
import type { SnapshotStore } from './snapshot-store'
import { FakeHost, FakeS3, fakeHostConfig, tarOf, useFakeS3Env } from './test-harness/fake-metal-host'

const ENV = { RUNTIME_AUTH_SECRET: 'tok' }

let restoreEnv: () => void
const cleanups: Array<() => void> = []
beforeAll(() => {
  restoreEnv = useFakeS3Env()
})
afterAll(() => restoreEnv())
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

function rig() {
  const s3 = new FakeS3()
  const host = new FakeHost()
  const dir = mkdtempSync(join(tmpdir(), 'wake-phases-'))
  cleanups.push(() => s3.stop(), () => host.stopAll(), () => rmSync(dir, { recursive: true, force: true }))
  const pool = new MetalWarmPool(host.manager(), fakeHostConfig(dir, s3), { kind: 'none' } as unknown as SnapshotStore)
  return { s3, host, pool }
}

describe('open() wake report', () => {
  test('a cold boot reports its phases and that there was no snapshot', async () => {
    const { pool } = rig()
    const r = await pool.open('p1', ENV)
    expect(r.mode).toBe('assigned')
    expect(r.staleReason).toBe('no_snapshot')
    expect(r.phases?.guest_assign).toBeGreaterThanOrEqual(0)
    expect(r.phases?.can_resume).toBeGreaterThanOrEqual(0)
    expect(r.totalMs).toBeGreaterThanOrEqual(0)
  }, 30_000)

  test('a resume reports restore, health and the guest hooks', async () => {
    const { pool } = rig()
    await pool.open('p1', ENV)
    await pool.suspend('p1')
    const r = await pool.open('p1', ENV)
    expect(r.mode).toBe('resumed')
    expect(r.staleReason).toBeUndefined()
    for (const phase of ['stale_check', 'restore', 'health', 'refresh_env', 'rehydrate']) {
      expect(r.phases?.[phase]).toBeGreaterThanOrEqual(0)
    }
    expect(r.totalMs!).toBeGreaterThanOrEqual(r.readyMs ?? 0)
  }, 30_000)

  test('a re-open of a live VM is a reuse with only the liveness check', async () => {
    const { pool } = rig()
    await pool.open('p1', ENV)
    const r = await pool.open('p1', ENV)
    expect(r.reused).toBe(true)
    expect(Object.keys(r.phases ?? {})).toEqual(['live_check'])
  }, 30_000)

  test('a source archive written after the snapshot still cold-boots, and says why', async () => {
    const { s3, pool } = rig()
    s3.put('p1/project-src.tar.gz', tarOf({ 'src/App.tsx': 'v1\n' }))
    await pool.open('p1', ENV)
    await pool.suspend('p1')
    s3.put('p1/project-src.tar.gz', tarOf({ 'src/App.tsx': 'v2 from a rescue\n' }))
    const r = await pool.open('p1', ENV)
    expect(r.mode).toBe('assigned')
    expect(r.staleReason).toBe('source')
  }, 30_000)
})

describe('stale reason honesty (SHO-271)', () => {
  /**
   * A durable pull that returns nothing was ALWAYS labelled `rootfs`, even when
   * the identity matched. That inflated the measured post-release cold-boot wave
   * and sent rewarm tuning after the wrong cause, so the store now reports why
   * it missed and the pool records that.
   */
  test('a pull miss that is not a rootfs change is labelled store_miss', async () => {
    const { host, pool } = rig()
    await pool.open('p1', ENV)
    await pool.suspend('p1')
    // The durable tier exists but has a metadata entry whose snapshot cannot be
    // pulled, for a reason other than the golden image having changed.
    ;(pool as unknown as { store: SnapshotStore }).store = {
      kind: 'fs',
      slim: false,
      head: async () => ({ projectId: 'p1', rootfsIdentity: 'current', createdAt: Date.now() }) as never,
      pull: async () => null,
      missReason: async () => 'absent' as const,
      push: async () => {},
      remove: async () => {},
      ensureBase: async () => {},
      pullBase: async () => false,
    } as unknown as SnapshotStore
    ;(pool as unknown as { evictLocal(id: string): void }).evictLocal('p1')
    const r = await pool.open('p1', ENV)
    expect(r.mode).toBe('assigned')
    expect(r.staleReason).toBe('store_miss')
  }, 30_000)
})

describe('member writable-state drift', () => {
  const ANCHOR = 'ws:proj:m1'
  const WS_ENV = { ...ENV, WORKSPACE_PROJECT_IDS: 'm1' }

  test('a member database re-exported by a sibling runtime is re-applied on resume, not cold-booted', async () => {
    const { s3, host, pool } = rig()
    s3.put('m1/project-src.tar.gz', tarOf({ 'App.tsx': 'm1\n' }))
    s3.put('m1/project-data.tar.gz', tarOf({ 'prisma/dev.db': 'rows v1\n' }))
    await pool.open(ANCHOR, WS_ENV)
    await pool.suspend(ANCHOR)

    const newer = s3.put('m1/project-data.tar.gz', tarOf({ 'prisma/dev.db': 'rows v2 from the workspace session\n' }))
    const before = metrics.getCounter(M.snapshotDriftRepaired)
    const r = await pool.open(ANCHOR, WS_ENV)

    expect(r.mode).toBe('resumed')
    expect(r.phases?.repair_drift).toBeGreaterThanOrEqual(0)
    expect(metrics.getCounter(M.snapshotDriftRepaired)).toBe(before + 1)
    const a = pool.getAssigned(ANCHOR)!
    expect(a.memberData?.m1.parentEtag).toBe(newer)
    expect(a.memberData?.m1.untrustedReason).toBeUndefined()
    const guest = host.guestFor(a.handle)!
    expect(readFileSync(join(guest.ws, 'm1/prisma/dev.db'), 'utf-8')).toBe('rows v2 from the workspace session\n')
  }, 30_000)

  test('member source drift alongside data drift still cold-boots', async () => {
    const { s3, pool } = rig()
    s3.put('m1/project-src.tar.gz', tarOf({ 'App.tsx': 'm1\n' }))
    s3.put('m1/project-data.tar.gz', tarOf({ 'prisma/dev.db': 'rows v1\n' }))
    await pool.open(ANCHOR, WS_ENV)
    await pool.suspend(ANCHOR)

    s3.put('m1/project-data.tar.gz', tarOf({ 'prisma/dev.db': 'rows v2\n' }))
    s3.put('m1/project-src.tar.gz', tarOf({ 'App.tsx': 'm1 v2\n' }))
    const r = await pool.open(ANCHOR, WS_ENV)
    expect(r.mode).toBe('assigned')
    expect(['member_data', 'member_source']).toContain(r.staleReason!)
  }, 30_000)
})
