// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-420 QA acceptance — the busy-idle ceiling across a rolling deploy.
 *
 * The unit tests in `pool-busy-idle-ceiling.test.ts` seed `AssignedVm` fields
 * directly, including `needsUserActivityBaseline`. That proves the reaper's
 * arithmetic but not the wiring the plan actually depends on: that `adopt()`
 * sets the flag, so a host restart does not hand a VM that has been idle for
 * days another full ceiling. These tests drive the real `adopt()` (a live
 * registry entry + a stub guest, as `pool-adopt.test.ts` does) and then the real
 * `pollActivity()` → `reapIdle()` pair the reaper timer runs in one tick.
 *
 * One guest server and one live child are shared by the whole file: the suite
 * runs in a single process and a server + child per test is enough to get the
 * runner killed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { LiveRegistry, type LiveVmEntry } from './live-registry'
import { M, metrics } from './metrics'
import { MetalWarmPool, type AssignedVm } from './pool'

const IDLE_MS = 1000
const CEILING_MS = 10 * IDLE_MS
const HOUR = 3_600_000

class TestPool extends MetalWarmPool {
  suspendedIds: string[] = []
  override async suspend(projectId: string): Promise<any> {
    this.suspendedIds.push(projectId)
    ;(this as any).assigned.delete(projectId)
    return { projectId }
  }
  peek(projectId: string): AssignedVm | undefined {
    return (this as any).assigned.get(projectId)
  }
}

const dirs: string[] = []

/** What the shared guest reports from /pool/activity. Each test sets it. */
let activity: () => Response = () => new Response('not configured', { status: 500 })
let guestUrl = ''
let guest: ReturnType<typeof Bun.serve> | null = null
let liveChild: ReturnType<typeof Bun.spawn> | null = null

beforeAll(() => {
  guest = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname
      if (path === '/health' || path === '/ready') return new Response('ok')
      if (path === '/pool/activity') return activity()
      return new Response('not found', { status: 404 })
    },
  })
  guestUrl = `http://localhost:${guest.port}`
  liveChild = Bun.spawn(['sleep', '120'])
})

afterAll(() => {
  guest?.stop(true)
  liveChild?.kill('SIGKILL')
})

function makeCfg() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-sho420-'))
  dirs.push(dir)
  return {
    ...config,
    work: dir,
    snapDir: join(dir, 'snap'),
    runDir: join(dir, 'run'),
    dmCowDir: join(dir, 'cow'),
    rootfsCow: 'full' as const,
    snapStore: 'none' as const,
    poolSize: 0, // adopt() reconciles; don't boot warm VMs
    idleSuspendMs: IDLE_MS,
    busyIdleCeilingMs: CEILING_MS,
    activityPoll: true,
    activityTimeoutMs: 200,
  }
}

/** A live-registry entry for a VM the previous agent left running. */
function entry(cfg: any, projectId: string, pid: number, agentUrl: string): LiveVmEntry {
  const sock = join(cfg.runDir, `${projectId}.sock`)
  writeFileSync(sock, '')
  return {
    projectId,
    vmId: `fcvm-${projectId}`,
    pid,
    guestIp: '127.0.0.1',
    agentUrl,
    socketPath: sock,
    serialLog: join(cfg.runDir, `${projectId}.serial`),
    net: { tap: 'fctap0', guestIp: '127.0.0.1' } as any,
    rootfs: join(cfg.runDir, `${projectId}.rootfs.ext4`),
    vcpus: 2,
    memoryMB: 4096,
    assignedAt: 1000,
    lastTouchedAt: 2000,
    v: 1,
  }
}

/** The guest's own report: stuck busy, last user request `lastAt`. */
function activityBody(lastAt: number) {
  return JSON.stringify({
    lastRequestAt: 1,
    activeStreams: 2,
    busy: true,
    activeTurns: 1,
    liveStreams: 2,
    lastAppRequestAt: lastAt,
    lastAgentRequestAt: lastAt,
  })
}

function fakeMgr() {
  return { adoptVM: () => {}, reapHostOrphans: () => 0, procCount: () => 0 }
}

/** Adopt one VM through the real rolling-deploy path. */
async function adoptOne(projectId: string) {
  const cfg = makeCfg()
  const reg = new LiveRegistry(cfg.runDir)
  reg.put(entry(cfg, projectId, liveChild!.pid, guestUrl))
  const pool = new TestPool(fakeMgr() as any, cfg as any)
  const res = await pool.adopt()
  expect(res.adopted).toEqual([projectId])
  return { pool, a: pool.peek(projectId)! }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('SHO-420 acceptance: adopt → baseline → ceiling', () => {
  test('a VM adopted after a restart is past the ceiling on the first reaper pass, not given a fresh 6h', async () => {
    const now = Date.now()
    const lastUserRequest = now - 48 * HOUR
    activity = () => new Response(activityBody(lastUserRequest), { status: 200 })

    const { pool, a } = await adoptOne('idle-48h')

    // adopt() seeds the clock to `now` and asks for a baseline correction.
    expect(a.needsUserActivityBaseline).toBe(true)
    expect(a.lastUserActivityAt).toBeGreaterThanOrEqual(now)

    // The reaper's tick: poll, then reap.
    const before = metrics.getCounter(M.busyIdleCeilingSuspended)
    await pool.pollActivity()
    expect(a.perClassActivity).toBe(true)
    expect(a.lastUserActivityAt).toBe(lastUserRequest)
    expect(a.needsUserActivityBaseline).toBe(false)

    expect(await pool.reapIdle(IDLE_MS)).toEqual(['idle-48h'])
    expect(pool.suspendedIds).toEqual(['idle-48h'])
    expect(metrics.getCounter(M.busyIdleCeilingSuspended) - before).toBe(1)
  })

  test('the baseline is one-shot: a later quiet poll does not rewind the clock to the guest history', async () => {
    const now = Date.now()
    let lastAt = now - 48 * HOUR
    activity = () => new Response(activityBody(lastAt), { status: 200 })

    const { pool, a } = await adoptOne('adopted')
    await pool.pollActivity()
    expect(a.lastUserActivityAt).toBe(lastAt)

    // A user request lands: the clock moves to now.
    const served = Date.now()
    lastAt = served
    await pool.pollActivity()
    expect(a.lastUserActivityAt).toBeGreaterThanOrEqual(served)

    // The guest goes quiet again and keeps reporting busy. The next poll must
    // NOT re-baseline back to the frozen history — the flag is already spent.
    await pool.pollActivity()
    expect(a.lastUserActivityAt).toBeGreaterThanOrEqual(served)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])
  })

  test('a mute guest at adopt time keeps the correction pending, and cannot be reaped on the seed', async () => {
    const now = Date.now()
    let failActivity = true
    activity = () =>
      failActivity
        ? new Response('boom', { status: 500 })
        : new Response(activityBody(now - 48 * HOUR), { status: 200 })

    const { pool, a } = await adoptOne('mute')

    await pool.pollActivity()
    // Failed poll: fail open, correction still pending, clock still the seed.
    expect(a.needsUserActivityBaseline).toBe(true)
    expect(a.lastUserActivityAt).toBeGreaterThanOrEqual(now)
    expect(await pool.reapIdle(IDLE_MS)).toEqual([])

    // The guest answers: the correction lands and the ceiling fires.
    failActivity = false
    await pool.pollActivity()
    expect(a.needsUserActivityBaseline).toBe(false)
    expect(a.lastUserActivityAt).toBe(now - 48 * HOUR)
    expect(await pool.reapIdle(IDLE_MS)).toEqual(['mute'])
  })
})
