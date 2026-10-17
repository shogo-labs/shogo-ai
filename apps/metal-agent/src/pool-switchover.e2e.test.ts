// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Rootfs switch-over on one host, through the real pool.
 *
 * A rebuild stages `<base>.staged` beside the live image. The control plane
 * boots recent runtimes on it (`openStaged`) and suspends them into the staged
 * slot while users keep resuming their current snapshots. Activation renames
 * the staged image over the base, promotes the staged snapshots and restarts
 * the agent; every pre-warmed runtime then resumes on the new image with its
 * user's latest work. A VM still running a superseded image is retired on
 * suspend (backed up, no snapshot), so nothing ever resumes old guest code.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { metrics, M } from './metrics'
import { MetalWarmPool, StagedRootfsUnavailableError } from './pool'
import { activateStagedImages, stagedRootfsPath } from './self-update'
import { computeRootfsIdentity, type SnapshotStore } from './snapshot-store'
import { FakeHost, FakeS3, fakeHostConfig, tarOf, useFakeS3Env } from './test-harness/fake-metal-host'

const ENV = { RUNTIME_AUTH_SECRET: 'tok' }
const NONE = { kind: 'none' } as unknown as SnapshotStore

let restoreEnv: () => void
const cleanups: Array<() => void> = []
beforeAll(() => {
  restoreEnv = useFakeS3Env()
})
afterAll(() => restoreEnv())
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

/** A golden image of `bytes` bytes; mtime set so two images never share an identity. */
function writeImage(path: string, bytes: number, mtimeS: number) {
  writeFileSync(path, Buffer.alloc(bytes))
  utimesSync(path, mtimeS, mtimeS)
}

function rig() {
  const s3 = new FakeS3()
  const host = new FakeHost()
  host.persistSnapshots = true
  const dir = mkdtempSync(join(tmpdir(), 'switchover-'))
  cleanups.push(() => s3.stop(), () => host.stopAll(), () => rmSync(dir, { recursive: true, force: true }))
  const baseRootfs = join(dir, 'rootfs.ext4')
  writeImage(baseRootfs, 1024, 1_700_000_000)
  const cfg = fakeHostConfig(dir, s3, { baseRootfs, rootfsIdentity: '' })
  const pools: MetalWarmPool[] = []
  /** A (re)started agent over the same dirs and VMs. */
  const agent = async () => {
    const pool = new MetalWarmPool(host.manager(), cfg, NONE)
    await pool.start()
    pools.push(pool)
    return pool
  }
  const stage = (bytes = 2048, mtimeS = 1_700_000_100) => {
    writeImage(stagedRootfsPath(baseRootfs), bytes, mtimeS)
    return computeRootfsIdentity(cfg, stagedRootfsPath(baseRootfs))
  }
  const current = () => computeRootfsIdentity(cfg, baseRootfs)
  return { s3, host, cfg, agent, stage, current, baseRootfs }
}

const SRC = 'p1/project-src.tar.gz'

describe('staged pre-warm', () => {
  test('a staged boot runs the staged image and suspends into the staged slot; the current snapshot keeps serving', async () => {
    const r = rig()
    r.s3.put(SRC, tarOf({ 'src/App.tsx': 'v1\n' }))
    const pool = await r.agent()
    const A = r.current()
    await pool.open('p1', ENV)
    await pool.suspend('p1')

    const B = r.stage()
    const writes = r.s3.writes.length
    const staged = await pool.openStaged('p1', ENV)
    expect(staged.mode).toBe('assigned')
    expect('bootRootfsIdentity' in staged && staged.bootRootfsIdentity).toBe(B)
    expect(r.host.boots.at(-1)?.rootfsBase).toBe(stagedRootfsPath(r.baseRootfs))
    // While the staged VM runs, the current snapshot is still there.
    expect(pool.getProjectStatus('p1')).toMatchObject({ state: 'assigned', rootfsFresh: false, snapshotRootfsIdentity: B })

    const out = await pool.suspendOrRetire('p1')
    expect(out).toMatchObject({ kind: 'suspended', staged: true })
    // Nobody used it, so it pushed nothing: the current snapshot's backups are still the latest.
    expect(r.s3.writes.length).toBe(writes)
    expect(pool.getProjectStatus('p1')).toMatchObject({
      state: 'suspended',
      rootfsFresh: true,
      snapshotRootfsIdentity: A,
      stagedSnapshotIdentity: B,
    })

    // Asked again, the host says it already holds it.
    expect(await pool.openStaged('p1', ENV)).toEqual({ mode: 'prewarmed', stagedSnapshotIdentity: B })

    // A user open in the meantime resumes the current image, as before.
    const user = await pool.open('p1', ENV)
    expect(user.mode).toBe('resumed')
    expect(user.bootRootfsIdentity).toBe(A)
  }, 30_000)

  test('a user open drops the staged snapshot (it would miss their newer work)', async () => {
    const r = rig()
    const pool = await r.agent()
    await pool.open('p1', ENV)
    await pool.suspend('p1')
    r.stage()
    await pool.openStaged('p1', ENV)
    await pool.suspendOrRetire('p1')
    expect(pool.stagedSnapshot('p1')).toBeDefined()

    await pool.open('p1', ENV)
    expect(pool.stagedSnapshot('p1')).toBeUndefined()
    expect(pool.getProjectStatus('p1').stagedSnapshotIdentity).toBeUndefined()
  }, 30_000)

  test('a staged VM a user worked on is backed up on suspend like any other', async () => {
    const r = rig()
    r.s3.put(SRC, tarOf({ 'src/App.tsx': 'v1\n' }))
    const pool = await r.agent()
    r.stage()
    const staged = await pool.openStaged('p1', ENV)
    if (staged.mode === 'prewarmed') throw new Error('unexpected prewarmed')
    r.host.guestFor(staged.handle)!.edit('src/App.tsx', 'edited on the staged VM\n')
    pool.getAssigned('p1')!.lastRealActivityAt = Date.now() + 1
    await pool.suspendOrRetire('p1')
    expect(r.s3.writes).toContain(SRC)
  }, 30_000)

  test('without a staged image a staged open is refused', async () => {
    const r = rig()
    const pool = await r.agent()
    await expect(pool.openStaged('p1', ENV)).rejects.toBeInstanceOf(StagedRootfsUnavailableError)
  }, 30_000)

  test('a rebuilt staged image discards the older pre-warm, live and across a restart', async () => {
    const r = rig()
    const pool = await r.agent()
    r.stage()
    await pool.openStaged('p1', ENV)
    await pool.suspendOrRetire('p1')
    await pool.openStaged('p2', ENV)
    await pool.suspendOrRetire('p2')

    // The heartbeat's onStaged hook after a rebuild.
    const C = r.stage(4096, 1_700_000_200)
    expect(pool.dropStagedSnapshots([C])).toBe(2)
    expect(pool.stagedSnapshot('p1')).toBeUndefined()

    // A restart in between rebuilds finds the same: nothing for an old image survives.
    await pool.openStaged('p3', ENV)
    await pool.suspendOrRetire('p3')
    r.stage(8192, 1_700_000_300)
    const next = await r.agent()
    expect(next.stagedSnapshot('p3')).toBeUndefined()
  }, 30_000)
})

describe('activation', () => {
  test('rename + promote + restart: the pre-warmed runtime resumes on the new image with the latest work', async () => {
    const r = rig()
    r.s3.put(SRC, tarOf({ 'src/App.tsx': 'v1\n' }))
    const pool = await r.agent()
    await pool.open('p1', ENV)
    await pool.suspend('p1')

    // The user edits after the staged image lands; the pre-warm then picks it up from durable state.
    const B = r.stage()
    r.s3.put(SRC, tarOf({ 'src/App.tsx': 'v2 (edited before the pre-warm)\n' }))
    await pool.openStaged('p1', ENV)
    await pool.suspendOrRetire('p1')

    const promotedBefore = metrics.getCounter(M.stagedSnapshotsPromoted)
    activateStagedImages(r.baseRootfs)
    expect(r.current()).toBe(B)
    expect(pool.promoteStagedSnapshots([B])).toBe(1)
    expect(metrics.getCounter(M.stagedSnapshotsPromoted)).toBe(promotedBefore + 1)

    const next = await r.agent()
    expect(next.getProjectStatus('p1')).toMatchObject({ state: 'suspended', rootfsFresh: true, snapshotRootfsIdentity: B })
    expect(next.getProjectStatus('p1').stagedSnapshotIdentity).toBeUndefined()
    const woke = await next.open('p1', ENV)
    expect(woke.mode).toBe('resumed')
    expect(woke.bootRootfsIdentity).toBe(B)
    expect(r.host.guestFor(woke.handle)!.read('src/App.tsx')).toBe('v2 (edited before the pre-warm)\n')
  }, 30_000)

  test('a GC sweep between promotion and the restart keeps the promoted snapshots', async () => {
    const r = rig()
    const pool = await r.agent()
    await pool.open('p1', ENV)
    await pool.suspend('p1')
    const B = r.stage()
    await pool.openStaged('p1', ENV)
    await pool.suspendOrRetire('p1')
    await pool.open('p2', ENV)
    await pool.suspend('p2')

    activateStagedImages(r.baseRootfs)
    expect(pool.promoteStagedSnapshots([B])).toBe(1)
    // The draining agent's last sweep: the old-image snapshot goes, the promoted one stays.
    const gc = await pool.gcSweep()
    expect(gc.staleReclaimed).toEqual(['p2'])
    expect(pool.getProjectStatus('p1')).toMatchObject({ state: 'suspended', rootfsFresh: true, snapshotRootfsIdentity: B })

    const next = await r.agent()
    expect(next.getProjectStatus('p1')).toMatchObject({ state: 'suspended', rootfsFresh: true, snapshotRootfsIdentity: B })
    expect((await next.open('p1', ENV)).mode).toBe('resumed')
  }, 30_000)

  test('a runtime not pre-warmed loses its old-image snapshot at activation and cold-boots on the new image', async () => {
    const r = rig()
    r.s3.put(SRC, tarOf({ 'src/App.tsx': 'v1\n' }))
    const pool = await r.agent()
    await pool.open('p1', ENV)
    await pool.suspend('p1')
    const B = r.stage()
    activateStagedImages(r.baseRootfs)
    pool.promoteStagedSnapshots([B])

    const next = await r.agent()
    expect(next.getProjectStatus('p1').rootfsFresh).toBe(false)
    const woke = await next.open('p1', ENV)
    expect(woke.mode).toBe('assigned')
    expect(woke.bootRootfsIdentity).toBe(B)
    expect(r.host.guestFor(woke.handle)!.read('src/App.tsx')).toBe('v1\n')
  }, 30_000)

  test('a staged snapshot whose runtime is running at activation is dropped, not promoted over it', async () => {
    const r = rig()
    const pool = await r.agent()
    const B = r.stage()
    await pool.openStaged('p1', ENV)
    await pool.suspendOrRetire('p1')
    // Re-opened through a path that kept the staged snapshot (it can't via
    // open(), which drops it): promotion must still never stomp a live VM.
    const held = pool.stagedSnapshot('p1')!
    await pool.open('p1', ENV)
    ;(pool as any).stagedSuspended.set('p1', held)
    activateStagedImages(r.baseRootfs)
    expect(pool.promoteStagedSnapshots([B])).toBe(0)
    expect(pool.getAssigned('p1')).toBeDefined()
  }, 30_000)
})

describe('retire on a superseded image', () => {
  test('a VM still on the old image is backed up and stopped with no snapshot; the next open runs the new image with its work', async () => {
    const r = rig()
    r.s3.put(SRC, tarOf({ 'src/App.tsx': 'v1\n' }))
    const pool = await r.agent()
    const a = await pool.open('p1', ENV)
    r.host.guestFor(a.handle)!.edit('src/App.tsx', 'edited on the old image\n')

    // The switch happens under it (this VM keeps running across the restart).
    const B = r.stage()
    renameSync(stagedRootfsPath(r.baseRootfs), r.baseRootfs)
    ;(pool as any).rootfsIds.standard = B
    expect(pool.getProjectStatus('p1').rootfsFresh).toBe(false)

    const retiredBefore = metrics.getCounter(M.suspendRetiredStale)
    const out = await pool.suspendOrRetire('p1')
    expect(out).toEqual({ kind: 'retired' })
    expect(metrics.getCounter(M.suspendRetiredStale)).toBe(retiredBefore + 1)
    expect(pool.getProjectStatus('p1').state).toBe('none')

    const woke = await pool.open('p1', ENV)
    expect(woke.mode).toBe('assigned')
    expect(woke.bootRootfsIdentity).toBe(B)
    expect(r.host.guestFor(woke.handle)!.read('src/App.tsx')).toBe('edited on the old image\n')
  }, 30_000)

  describe('rollout rotation', () => {
    const MIN = 60_000
    /** p1 running on the old image, which has just been replaced under it. */
    async function onReplacedImage(opts: { alwaysOn?: boolean } = {}) {
      const r = rig()
      r.cfg.rolloutIdleMs = 15 * MIN
      r.cfg.rolloutDeadlineMs = 24 * 60 * MIN
      r.s3.put(SRC, tarOf({ 'src/App.tsx': 'v1\n' }))
      const pool = await r.agent()
      const a = await pool.open('p1', opts.alwaysOn ? { ...ENV, SHOGO_ALWAYS_ON: '1' } : ENV)
      r.host.guestFor(a.handle)!.edit('src/App.tsx', 'edited on the old image\n')
      const B = r.stage()
      renameSync(stagedRootfsPath(r.baseRootfs), r.baseRootfs)
      ;(pool as any).rootfsIds.standard = B
      return { r, pool, B, vm: pool.getAssigned('p1')! }
    }

    test('an idle VM on a replaced image is retired, and its next open runs the new image with its work', async () => {
      const { r, pool, B, vm } = await onReplacedImage()
      const t0 = Date.now()
      vm.lastRealActivityAt = t0
      expect(await pool.rotateStale(t0 + 14 * MIN)).toEqual({ retired: [], alwaysOn: [] })
      expect(pool.getAssigned('p1')).toBeDefined()

      const before = metrics.getCounter(M.rolloutRotated)
      expect(await pool.rotateStale(t0 + 15 * MIN)).toEqual({ retired: ['p1'], alwaysOn: [] })
      expect(metrics.getCounter(M.rolloutRotated)).toBe(before + 1)
      expect(pool.getProjectStatus('p1').state).toBe('none')

      const woke = await pool.open('p1', ENV)
      expect(woke.bootRootfsIdentity).toBe(B)
      expect(r.host.guestFor(woke.handle)!.read('src/App.tsx')).toBe('edited on the old image\n')
    }, 30_000)

    test('an always-on VM rotates too, and is reported apart so it is booted again', async () => {
      const { pool, vm } = await onReplacedImage({ alwaysOn: true })
      expect(vm.alwaysOn).toBe(true)
      vm.lastRealActivityAt = Date.now() - 20 * MIN
      expect(await pool.rotateStale()).toEqual({ retired: [], alwaysOn: ['p1'] })
    }, 30_000)

    test('a VM mid agent turn is never rotated, even past the deadline', async () => {
      const { pool, vm } = await onReplacedImage()
      const t0 = Date.now()
      vm.lastRealActivityAt = t0 - 60 * MIN
      vm.activeStreams = 1
      await pool.rotateStale(t0)
      expect(await pool.rotateStale(t0 + 25 * 60 * MIN)).toEqual({ retired: [], alwaysOn: [] })
      expect(pool.getAssigned('p1')).toBeDefined()
    }, 30_000)

    test('a VM that is never idle for long is rotated at the deadline, between turns', async () => {
      const { pool, vm } = await onReplacedImage()
      const t0 = Date.now()
      vm.lastRealActivityAt = t0
      expect((await pool.rotateStale(t0)).retired).toEqual([])
      vm.lastRealActivityAt = t0 + 24 * 60 * MIN - MIN
      expect(await pool.rotateStale(t0 + 24 * 60 * MIN)).toEqual({ retired: ['p1'], alwaysOn: [] })
    }, 30_000)

    test('a VM on the current image is left alone', async () => {
      const r = rig()
      r.cfg.rolloutIdleMs = 15 * MIN
      const pool = await r.agent()
      await pool.open('p1', ENV)
      pool.getAssigned('p1')!.lastRealActivityAt = Date.now() - 60 * MIN
      expect(await pool.rotateStale()).toEqual({ retired: [], alwaysOn: [] })
      expect(pool.getAssigned('p1')).toBeDefined()
    }, 30_000)
  })

  test('a VM on the current image suspends normally', async () => {
    const r = rig()
    const pool = await r.agent()
    await pool.open('p1', ENV)
    const out = await pool.suspendOrRetire('p1')
    expect(out).toMatchObject({ kind: 'suspended', staged: false })
    expect(pool.getProjectStatus('p1')).toMatchObject({ state: 'suspended', rootfsFresh: true })
  }, 30_000)
})
