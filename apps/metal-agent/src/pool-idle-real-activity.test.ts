// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * pool idle-suspend gating — reapIdle must measure what a USER did, not what our
 * own machinery did.
 *
 * Two rounds of the same bug, both fixed here:
 *
 *  1. `lastTouchedAt` answers "did anything ask about this VM": a control-plane
 *     routing/status poll bumps it, and so does the activity poll every time it
 *     fails open. Both run on the reaper's own interval, so gating on it means a
 *     VM's idle age can never grow past one poll cycle and NO window ever
 *     expires. Production ran a 4h window and held ~320 VMs resident whose apps
 *     had been idle for days; only 3 fleet-wide ever qualified to suspend.
 *
 *  2. The guest's catch-all `lastRequestAt` counts every request it serves —
 *     including the host's writable-state and published-data export sweeps,
 *     which call `/pool/export-data` on EVERY assigned VM every 120s. Gating on
 *     that held 202 VMs resident, 67 of them sharing `realIdleMs` to the
 *     millisecond (one sweep stamped them all) while 93 had never served a
 *     single app or agent request in their lives.
 *
 * So the gate is the guest's own per-class user signals: `lastAppRequestAt`,
 * `lastAgentRequestAt`, `activeStreams`. Driven with fakes — no real host.
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

  test('a legacy guest with no per-class fields still keeps its window on traffic', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('busy', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.lastActivityAt = 1

    // No lastAppRequestAt/lastAgentRequestAt keys at all: an older runtime image
    // that cannot classify. The catch-all is then the only signal we have, so it
    // must still protect the VM rather than let us suspend real users.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ lastRequestAt: 999, activeStreams: 0 }), { status: 200 }),
      )) as any
    await pool.pollActivity()

    expect(a.perClassActivity).toBeUndefined()
    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('the host export sweep advancing lastRequestAt does NOT hold a VM open', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('export-swept', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.lastActivityAt = 1

    // Exactly what production reported: the catch-all counter keeps climbing
    // because /pool/export-data is hit every 120s, while the guest states plainly
    // that no app request and no agent turn has EVER happened.
    let served = 1000
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRequestAt: (served += 1000),
            activeStreams: 0,
            lastAppRequestAt: null,
            appRequestCount: 0,
            lastAgentRequestAt: null,
          }),
          { status: 200 },
        ),
      )) as any

    await pool.pollActivity()
    await pool.pollActivity()

    expect(a.perClassActivity).toBe(true)
    // Touched (something did reach the guest) but not "used".
    expect(a.lastTouchedAt).toBeGreaterThan(old)
    expect(a.lastRealActivityAt).toBe(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['export-swept'])
  })

  test('a real app request refreshes the window', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('app-users', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.perClassActivity = true // already baselined by an earlier poll
    a.lastAppRequestAt = 5000

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ lastRequestAt: 9000, activeStreams: 0, lastAppRequestAt: 6000, lastAgentRequestAt: null }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('a real agent turn refreshes the window', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    const a = pool.seed('agent-chat', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })
    a.perClassActivity = true
    a.lastAgentRequestAt = 5000

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ lastRequestAt: 9000, activeStreams: 0, lastAppRequestAt: null, lastAgentRequestAt: 7000 }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    expect(a.lastRealActivityAt).toBeGreaterThan(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('the first poll after a restart treats an old timestamp as history, not activity', async () => {
    const pool = makePool(dir)
    const old = Date.now() - 10 * IDLE_MS
    // adopt() seeds lastRealActivityAt, but this VM's last real use was days ago.
    const a = pool.seed('adopted', { lastTouchedAt: old, lastRealActivityAt: old, assignedAt: old })

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            lastRequestAt: 9000,
            activeStreams: 0,
            lastAppRequestAt: Date.now() - 2 * 24 * 3600 * 1000,
            lastAgentRequestAt: null,
          }),
          { status: 200 },
        ),
      )) as any
    await pool.pollActivity()

    // Baseline recorded, window NOT refreshed — otherwise every agent restart
    // would grant the whole fleet a fresh window.
    expect(a.perClassActivity).toBe(true)
    expect(a.lastAppRequestAt).toBeGreaterThan(0)
    expect(a.lastRealActivityAt).toBe(old)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['adopted'])
  })
})
