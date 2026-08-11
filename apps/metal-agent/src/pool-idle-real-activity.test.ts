// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool idle-suspend gating — reapIdle must measure GUEST-OBSERVED activity, not
 * `lastTouchedAt`.
 *
 * `lastTouchedAt` answers "did anything ask about this VM": a control-plane
 * routing/status poll bumps it, and so does the activity poll every time it
 * fails open. Both run on the reaper's own interval, so gating on it means a
 * VM's idle age can never grow past one poll cycle and NO window ever expires.
 * Production ran a 4h window and held ~320 VMs resident whose apps had been
 * idle for days; only 3 fleet-wide ever qualified to suspend.
 *
 * Driven with fakes — no real Firecracker host.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { MetalWarmPool, type AssignedVm } from './pool'
import type { FirecrackerVMManager } from './firecracker-vm-manager'
import type { SnapshotStore } from './snapshot-store'

const IDLE_MS = 1000

class TestPool extends MetalWarmPool {
  suspended: string[] = []
  override async suspend(projectId: string): Promise<any> {
    this.suspended.push(projectId)
    ;(this as any).assigned.delete(projectId)
    return { projectId }
  }
  seed(projectId: string, fields: Partial<AssignedVm>) {
    const now = Date.now()
    const a: AssignedVm = {
      projectId,
      handle: { id: `vm-${projectId}`, agentUrl: 'http://10.0.0.9:8080', guestIp: '10.0.0.9' } as any,
      assignedAt: now,
      lastTouchedAt: now,
      lastRealActivityAt: now,
      alwaysOn: false,
      ...fields,
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
    idleSuspendMs: IDLE_MS,
    activityPoll: true,
    activityTimeoutMs: 50,
  } as typeof config
  mkdirSync(cfg.snapDir, { recursive: true })
  mkdirSync(cfg.runDir, { recursive: true })
  const fakeMgr = { procCount: () => 0, isRunning: () => true } as unknown as FirecrackerVMManager
  return new TestPool(fakeMgr, cfg, { kind: 'none' } as unknown as SnapshotStore)
}

describe('reapIdle gates on real guest activity, not lastTouchedAt', () => {
  let dir: string
  const realFetch = globalThis.fetch
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metal-idle-real-'))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  })

  test('suspends a VM a routing poll keeps touching but whose guest is quiet', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    // The exact production shape: control plane polled it a moment ago, the
    // guest itself has served nothing for ages.
    pool.seed('polled-but-quiet', { lastTouchedAt: Date.now(), lastRealActivityAt: old, assignedAt: old })

    expect(await pool.reapIdle(IDLE_MS)).toEqual(['polled-but-quiet'])
  })

  test('keeps a VM whose guest served real traffic, even if nothing touched it', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    pool.seed('serving', { lastTouchedAt: old, lastRealActivityAt: Date.now(), assignedAt: old })

    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
    expect(pool.peek('serving')).toBeDefined()
  })

  test('gives a freshly-placed VM a full window before its first request', async () => {
    const pool = makePool(dir)
    // Never reported activity: lastRealActivityAt falls back to assignedAt, so
    // the window runs from placement rather than suspending on the next tick.
    pool.seed('just-opened', { assignedAt: Date.now(), lastRealActivityAt: undefined })
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])

    pool.seed('opened-long-ago', { assignedAt: Date.now() - 10 * IDLE_MS, lastRealActivityAt: undefined })
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['opened-long-ago'])
  })

  test('a failed activity poll no longer extends the idle window', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('unreachable-guest', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as any
    await pool.pollActivity()

    // Fail-open still marks it touched (other consumers rely on that)...
    expect(a.lastTouchedAt).toBeGreaterThan(old)
    // ...but it must not look like the guest did something.
    expect(a.lastRealActivityAt).toBe(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['unreachable-guest'])
  })

  test('an active stream counts as real activity and blocks suspension', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('generating', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ activeStreams: 1 }), { status: 200 }))) as any
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('guest traffic since the last look refreshes the window', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('busy', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.lastActivityAt = 1

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lastRequestAt: 999, activeStreams: 0 }), { status: 200 }),
      )) as any
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })
})
