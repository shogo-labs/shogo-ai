// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool always-on — the metal parity for Knative min-scale=1 (paid tiers).
 *
 * The control plane sets `SHOGO_ALWAYS_ON` in the assign env for paid instance
 * tiers; the agent must (a) never idle-suspend those VMs in the reaper, and
 * (b) (re)apply the flag from env on every open (so it survives a resume, which
 * carries no env) and persist it for adopt-on-restart. Driven with fakes — no
 * real Firecracker host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { CacheIndex } from './cache-index'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

/** Pool subclass that stubs suspend() so reapIdle can be asserted offline. */
class TestPool extends MetalWarmPool {
  suspended: string[] = []
  override async suspend(projectId: string): Promise<any> {
    this.suspended.push(projectId)
    ;(this as any).assigned.delete(projectId)
    return { projectId }
  }
  seed(projectId: string, lastTouchedAt: number, alwaysOn: boolean) {
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any,
      assignedAt: 0,
      lastTouchedAt,
      alwaysOn,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }
  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }
}

function makePool(dir: string): TestPool {
  const cfg = {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    idleSuspendMs: 1000,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0 } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('pool idle-suspend always-on exemption', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-alwayson-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('reapIdle suspends idle regular VMs but skips always-on VMs', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10_000 // well past the 1000ms idle threshold
    pool.seed('regular', old, false)
    pool.seed('paid', old, true)

    const suspended = await pool.reapIdle(1000)

    expect(suspended).toEqual(['regular'])
    expect(pool.suspended).toEqual(['regular'])
    // always-on VM remains assigned + untouched
    expect(pool.peek('paid')).toBeDefined()
    expect(pool.peek('regular')).toBeUndefined()
  })

  test('reapIdle does not suspend a recently-touched always-on VM either', async () => {
    const pool = makePool(dir)
    pool.seed('paid', Date.now(), true)
    const suspended = await pool.reapIdle(1000)
    expect(suspended).toEqual([])
    expect(pool.suspended).toEqual([])
  })

  test('reapIdle skips an idle VM that has an active agent message (activeStreams>0)', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10_000 // past the idle threshold
    const busy = pool.seed('generating', old, false)
    busy.activeStreams = 1 // last activity poll saw a live turn in flight
    pool.seed('quiet', old, false)

    const suspended = await pool.reapIdle(1000)

    // Only the idle, non-generating VM is suspended; the busy one keeps running.
    expect(suspended).toEqual(['quiet'])
    expect(pool.peek('generating')).toBeDefined()
    expect(pool.peek('quiet')).toBeUndefined()
  })

  test('open() applies SHOGO_ALWAYS_ON=1 from env to a live VM and persists it', async () => {
    const pool = makePool(dir)
    pool.seed('p1', Date.now(), false)

    await pool.open('p1', { SHOGO_ALWAYS_ON: '1' })

    expect(pool.peek('p1')?.alwaysOn).toBe(true)
    // persisted to the live registry for adopt-on-restart
    const live = (pool as any).live.get('p1')
    expect(live?.alwaysOn).toBe(true)
  })

  test('open() clears always-on when the env no longer carries the flag', async () => {
    const pool = makePool(dir)
    const a = pool.seed('p1', Date.now(), true)
    expect(a.alwaysOn).toBe(true)

    await pool.open('p1', {}) // e.g. downgraded to a free tier

    expect(pool.peek('p1')?.alwaysOn).toBe(false)
  })
})
