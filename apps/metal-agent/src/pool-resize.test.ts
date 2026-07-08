// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool.applyResize — live instance-tier change (metal parity for a Knative
 * resource patch). Firecracker can't hot-change vCPU/RAM, so those land on the
 * next boot; what we CAN apply live is the always-on flag, so a paid upgrade
 * stops the reaper immediately and a downgrade re-arms it. Driven with fakes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

class TestPool extends MetalWarmPool {
  seed(projectId: string, alwaysOn: boolean) {
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any,
      assignedAt: 0,
      lastTouchedAt: Date.now(),
      alwaysOn,
    }
    ;(this as any).assigned.set(projectId, a)
    return a
  }
  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }
  live_(projectId: string): any {
    return (this as any).live.get(projectId)
  }
}

function makePool(dir: string): TestPool {
  const cfg = { ...config, work: dir, snapDir: join(dir, 'snap'), runDir: join(dir, 'run') } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0 } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('pool.applyResize', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-resize-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('upgrade flips always-on ON live and persists for adopt-on-restart', () => {
    const pool = makePool(dir)
    pool.seed('p1', false)

    expect(pool.applyResize('p1', { alwaysOn: true })).toBe(true)
    expect(pool.peek('p1')?.alwaysOn).toBe(true)
    expect(pool.live_('p1')?.alwaysOn).toBe(true)
  })

  test('downgrade flips always-on OFF (re-arms the idle reaper)', () => {
    const pool = makePool(dir)
    pool.seed('p1', true)

    expect(pool.applyResize('p1', { alwaysOn: false })).toBe(true)
    expect(pool.peek('p1')?.alwaysOn).toBe(false)
  })

  test('no-op (returns false) when the project is not live on this host', () => {
    const pool = makePool(dir)
    expect(pool.applyResize('ghost', { alwaysOn: true })).toBe(false)
  })

  test('omitting alwaysOn leaves the flag untouched', () => {
    const pool = makePool(dir)
    pool.seed('p1', true)
    expect(pool.applyResize('p1', {})).toBe(true)
    expect(pool.peek('p1')?.alwaysOn).toBe(true)
  })
})
