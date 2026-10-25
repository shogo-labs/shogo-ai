// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * QA acceptance for SHO-206, host side: a VM resumed from a snapshot must not
 * keep the clock it was frozen with.
 *
 * The dev's tests prove the pieces — `guestBootArgs` pins the clocksource,
 * `callGuestHook('rehydrate')` puts `hostNowMs` in the body, `guest-clock.ts`
 * corrects a skew. What none of them prove is the thing staging actually did:
 * a guest that comes back 4h40m behind is *measured* on the first post-restore
 * health check, *counted* in metrics, and *corrected* by the rehydrate call that
 * follows it — over real HTTP, in that order, on the real `MetalWarmPool`.
 *
 * The guest here is a miniature of the real one: it stamps `/health` with its
 * own (possibly frozen) clock and applies `hostNowMs` exactly as
 * `packages/agent-runtime/src/guest-clock.ts` and the Go pool-agent do. The
 * clock is only moved by a guest that reads the body, which is what makes the
 * "old guest" case below meaningful.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config, type MetalConfig } from './config'
import type { FcVmHandle } from './firecracker-vm-manager'
import { M, metrics } from './metrics'
import { MetalWarmPool } from './pool'
import type { SnapshotStore } from './snapshot-store'

const dirs: string[] = []
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The staging incident: a workspace suspended for 4h40m came back that far behind. */
const FROZEN_BY_MS = 4 * 3600_000 + 40 * 60_000

type ClockGuest = ReturnType<typeof makeClockGuest>

/**
 * A guest whose wall clock can be frozen (a restore from a TSC snapshot) and
 * which corrects itself from the `hostNowMs` the host sends on rehydrate.
 * `appliesHostClock: false` is the old guest: it accepts the call and ignores
 * the field, which is the upgrade-order case the plan says must stay harmless.
 */
function makeClockGuest(opts: { appliesHostClock?: boolean } = {}) {
  const appliesHostClock = opts.appliesHostClock ?? true
  const calls: Array<{ path: string; body: any }> = []
  /** Guest clock minus real time. A restore from a TSC snapshot leaves it negative. */
  let offsetMs = 0
  /** What the guest measured when it last corrected itself. */
  let lastCorrection: { skewMs: number; corrected: boolean } | null = null

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname
      const guestNow = Date.now() + offsetMs
      const headers = { 'content-type': 'application/json', Date: new Date(guestNow).toUTCString() }
      if (path === '/health') return new Response(JSON.stringify({ ok: true }), { headers })
      if (path.startsWith('/pool/')) {
        const body = req.body ? await req.json().catch(() => null) : null
        calls.push({ path, body })
        if (path === '/pool/rehydrate' && appliesHostClock) {
          const hostNowMs = Number(body?.hostNowMs)
          if (Number.isFinite(hostNowMs) && hostNowMs > 0) {
            const skewMs = Date.now() + offsetMs - hostNowMs
            if (Math.abs(skewMs) > 2000) {
              offsetMs = hostNowMs - Date.now()
              lastCorrection = { skewMs, corrected: true }
            } else {
              lastCorrection = { skewMs, corrected: false }
            }
          }
        }
      }
      if (path === '/pool/export' || path === '/pool/export-data' || path === '/pool/export-repo') {
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify({ ok: true }), { headers })
    },
  })
  cleanups.push(() => server.stop(true))

  return {
    port: server.port!,
    url: `http://127.0.0.1:${server.port}`,
    calls,
    /** The VM resumes holding the clock it was snapshotted with. */
    freezeBehind(ms: number) {
      offsetMs = -ms
    },
    get lastCorrection() {
      return lastCorrection
    },
    /** Guest minus host, in ms, as an outside observer reads it off /health. */
    async skewVsHost(): Promise<number> {
      const before = Date.now()
      const res = await fetch(`http://127.0.0.1:${server.port}/health`, { signal: AbortSignal.timeout(2000) })
      const after = Date.now()
      return Date.parse(res.headers.get('date')!) - Math.round((before + after) / 2)
    },
  }
}

function fakeMgr(guestPort: number) {
  let n = 0
  const handle = (): FcVmHandle => {
    n++
    return {
      id: `vm-${n}`,
      agentUrl: `http://127.0.0.1:${guestPort}`,
      guestIp: '127.0.0.1',
      pid: 1000 + n,
      platform: 'linux',
      net: { tap: `fctap${n}`, guestIp: '127.0.0.1' } as any,
      rootfs: `/tmp/fake-rootfs-${n}`,
      socketPath: `/tmp/fake-${n}.sock`,
      serialLog: `/tmp/fake-${n}.serial`,
      vcpus: 2,
      memoryMB: 1024,
      vmClass: 'standard',
    } as FcVmHandle
  }
  return {
    startVM: async () => handle(),
    restoreVM: async () => handle(),
    stopVM: async () => {},
    isRunning: () => true,
    procCount: () => 0,
    reapHostOrphans: () => 0,
    snapshotVM: async (h: FcVmHandle) => ({
      vmId: h.id,
      snapshotPath: '/tmp/x.vmstate',
      memFilePath: '/tmp/x.mem',
      net: h.net,
      rootfs: h.rootfs,
      vcpus: h.vcpus,
      memoryMB: h.memoryMB,
      createdAt: Date.now(),
      bytesMem: 0,
      bytesState: 0,
      bytesRootfs: 0,
      vmClass: h.vmClass,
    }),
    durableRootfs: () => ({ path: '/tmp/x.rootfs', mode: 'full' }),
    restoreRootfsArtifactPath: (p: string) => p,
  }
}

function makeCfg(): MetalConfig {
  const dir = mkdtempSync(join(tmpdir(), 'qa-sho206-'))
  dirs.push(dir)
  const snapDir = join(dir, 'snap')
  const runDir = join(dir, 'run')
  mkdirSync(snapDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })
  return { ...config, work: dir, snapDir, runDir, poolSize: 0, snapStore: 'none' } as MetalConfig
}

const ENV = { RUNTIME_AUTH_SECRET: 'tok-206' }

async function poolFor(guest: ClockGuest): Promise<MetalWarmPool> {
  const pool = new MetalWarmPool(fakeMgr(guest.port) as any, makeCfg(), { kind: 'none' } as unknown as SnapshotStore)
  await pool.start()
  await pool.assign('proj-206', ENV)
  await pool.suspend('proj-206')
  return pool
}

/** Collects what the host logged while `fn` runs. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = []
  const real = console.warn
  console.warn = (...args: any[]) => {
    warnings.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
  }
  try {
    return { result: await fn(), warnings }
  } finally {
    console.warn = real
  }
}

describe('SHO-206 · a restored guest gets the host clock', () => {
  test('a snapshot restored 4h40m behind is corrected before the guest serves again', async () => {
    const guest = makeClockGuest()
    const pool = await poolFor(guest)
    const restoresBefore = metrics.getCounter(M.guestClockSkewAfterRestore)

    // The VM comes back holding the clock it was frozen with — exactly what the
    // staging workspace did (fcr-c9t-1xkeh read 12:02:44 at 16:43Z).
    guest.freezeBehind(FROZEN_BY_MS)
    expect(await guest.skewVsHost()).toBeLessThan(-FROZEN_BY_MS + 5_000)

    const { result: resumed, warnings } = await captureWarnings(() => pool.resume('proj-206', ENV))
    expect(resumed?.assigned.projectId).toBe('proj-206')

    // The rehydrate call carried the host's clock, and the guest used it.
    const rehydrate = guest.calls.filter((c) => c.path === '/pool/rehydrate')
    expect(rehydrate.length).toBeGreaterThanOrEqual(1)
    expect(typeof rehydrate.at(-1)?.body?.hostNowMs).toBe('number')
    expect(guest.lastCorrection?.corrected).toBe(true)
    expect(guest.lastCorrection!.skewMs).toBeLessThan(-FROZEN_BY_MS + 60_000)

    // AC2(b): the guest is now within 2 s of the host, read back over HTTP.
    expect(Math.abs(await guest.skewVsHost())).toBeLessThanOrEqual(2000)

    // Plan item 3: the skew was visible before it was corrected.
    expect(metrics.getCounter(M.guestClockSkewAfterRestore)).toBe(restoresBefore + 1)
    expect(metrics.getGauge(M.guestClockSkewMs)).toBeGreaterThanOrEqual(FROZEN_BY_MS - 60_000)
    expect(warnings.some((w) => /guest clock skew -?\d+ms after restore/.test(w))).toBe(true)
  }, 30_000)

  test('a guest that comes back on time is not counted as a skew', async () => {
    const guest = makeClockGuest()
    const pool = await poolFor(guest)
    const restoresBefore = metrics.getCounter(M.guestClockSkewAfterRestore)
    const gaugeBefore = metrics.getGauge(M.guestClockSkewMs)

    const { warnings } = await captureWarnings(() => pool.resume('proj-206', ENV))

    expect(metrics.getCounter(M.guestClockSkewAfterRestore)).toBe(restoresBefore)
    expect(metrics.getGauge(M.guestClockSkewMs)).toBe(gaugeBefore)
    expect(warnings.some((w) => /after restore/.test(w))).toBe(false)
    expect(Math.abs(await guest.skewVsHost())).toBeLessThanOrEqual(2000)
  }, 30_000)

  test('an old guest that ignores hostNowMs still resumes, and the skew stays visible', async () => {
    // Upgrade order: new host, guest image predating the clock sync. The resume
    // must not fail or hang on it, and the operator must still see the skew —
    // that is the whole difference between "fixed" and "silently still broken".
    const guest = makeClockGuest({ appliesHostClock: false })
    const pool = await poolFor(guest)
    const restoresBefore = metrics.getCounter(M.guestClockSkewAfterRestore)

    guest.freezeBehind(FROZEN_BY_MS)
    const { result: resumed, warnings } = await captureWarnings(() => pool.resume('proj-206', ENV))

    expect(resumed?.assigned.projectId).toBe('proj-206')
    expect(metrics.getCounter(M.guestClockSkewAfterRestore)).toBe(restoresBefore + 1)
    expect(warnings.some((w) => /guest clock skew -?\d+ms after restore/.test(w))).toBe(true)
    // Uncorrected by design: this is the snapshot that only a cold boot fixes.
    expect(await guest.skewVsHost()).toBeLessThan(-FROZEN_BY_MS + 60_000)
  }, 30_000)

  test('the guest hook still carries the runtime token, so an authed guest accepts the sync', async () => {
    const guest = makeClockGuest()
    const pool = await poolFor(guest)
    const seen: Array<string | null> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/pool/rehydrate')) seen.push(new Headers(init?.headers).get('authorization'))
      return realFetch(input, init)
    }) as typeof fetch
    try {
      await pool.resume('proj-206', ENV)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen).toContain('Bearer tok-206')
  }, 30_000)
})
