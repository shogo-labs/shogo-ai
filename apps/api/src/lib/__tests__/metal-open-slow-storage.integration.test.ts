// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * End-to-end: a project open, from the API down to object storage, while the
 * git history download hangs.
 *
 * 2026-10-25: a warm-pool open took 2m33s. The host's git history download
 * hung, every /assign outlived the API's 30s budget (five `assign_timeout`s)
 * and none of it showed up as a slow open, because each attempt was measured
 * on its own and stopped at 30s.
 *
 * Real here: `MetalWarmPoolController` and its metrics, HTTP to a host that
 * answers /assign and /status exactly as metal-agent's server.ts does
 * (`pool.open` / `assignResponseBody` / `pool.getProjectStatus`), the real
 * `MetalWarmPool`, git, tar, the guest's adopt and its late-swap gate, and an
 * S3-compatible store. Only the microVM is faked. Timeouts are scaled down:
 * the API's 30s assign budget is ASSIGN_TIMEOUT_MS below.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { metrics } from '@opentelemetry/api'
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assignResponseBody } from '../../../../metal-agent/src/assign-response'
import { MetalWarmPool } from '../../../../metal-agent/src/pool'
import type { SnapshotStore } from '../../../../metal-agent/src/snapshot-store'
import {
  FakeHost,
  FakeS3,
  fakeHostConfig,
  repoArchiveOf,
  tarOf,
  useFakeS3Env,
  type GuestKind,
} from '../../../../metal-agent/src/test-harness/fake-metal-host'

const ASSIGN_TIMEOUT_MS = 2_000
const FOREGROUND_MS = 300

// Both are read when the controller module loads, as in production.
process.env.METAL_ASSIGN_TIMEOUT_MS = String(ASSIGN_TIMEOUT_MS)
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const provider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
})
metrics.setGlobalMeterProvider(provider)

const { MetalWarmPoolController, isAssignTimeout } = await import('../metal-warm-pool-controller')
const { MetalPlacementRegistry } = await import('../metal-placement-registry')

interface Point {
  attributes: Record<string, unknown>
  value: number | { count: number; sum: number; min?: number; max?: number }
}

/** Points for `hostId` (each test has its own host; the provider is cumulative). */
async function points(name: string, hostId: string): Promise<Point[]> {
  await provider.forceFlush()
  const latest = exporter.getMetrics().at(-1)
  if (!latest) return []
  return latest.scopeMetrics
    .flatMap((sm) => sm.metrics)
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) => m.dataPoints as unknown as Point[])
    .filter((p) => (p.attributes.host_id ?? p.attributes.host) === hostId)
}

const hist = (p: Point) => p.value as { count: number; sum: number; min?: number; max?: number }
const count = (p: Point) => (typeof p.value === 'number' ? p.value : hist(p).count)

let restoreEnv: () => void
const cleanups: Array<() => void | Promise<void>> = []
beforeAll(() => {
  restoreEnv = useFakeS3Env()
})
afterAll(() => restoreEnv())
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/**
 * One metal host: the real pool behind the same /assign and /status bodies as
 * metal-agent's server.ts, with object storage the test can break.
 */
function metalHost(hostId: string, guestKind: GuestKind) {
  const s3 = new FakeS3()
  const vms = new FakeHost(undefined, guestKind)
  const dir = mkdtempSync(join(tmpdir(), `metal-${hostId}-`))
  const pool = new MetalWarmPool(
    vms.manager(),
    fakeHostConfig(dir, s3, { repoForegroundMs: FOREGROUND_MS }),
    { kind: 'none' } as unknown as SnapshotStore,
  )
  /** Every /assign the host finished, including ones the API stopped waiting for. */
  const finished: string[] = []
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const body: any = await req.json().catch(() => ({}))
      if (path === '/assign') {
        const r = await pool.open(body.projectId, body.env ?? {})
        if (r.mode === 'prewarmed') return Response.json(r)
        finished.push(body.projectId)
        return Response.json(assignResponseBody(r, vms.guestFor(r.handle)!.url))
      }
      if (path === '/status') return Response.json(pool.getProjectStatus(body.projectId))
      return new Response('not found', { status: 404 })
    },
  })
  const releases: Array<() => void> = []
  cleanups.push(
    () => s3.stop(),
    () => vms.stopAll(),
    () => rmSync(dir, { recursive: true, force: true }),
    () => {
      server.stop(true)
    },
    async () => {
      releases.splice(0).forEach((r) => r())
      const until = Date.now() + 10_000
      while (Date.now() < until && [...(pool as any).assigned.values()].some((a: any) => a.repoHydratePending)) {
        await Bun.sleep(20)
      }
    },
  )
  return {
    hostId,
    s3,
    pool,
    finished,
    registration: {
      hostId,
      meshIp: '127.0.0.1',
      agentPort: server.port,
      region: 'us',
      arch: 'x64',
      capacity: { poolSize: 4, memMiB: 2048, vcpus: 2 },
      load: { available: 4, assigned: 0, suspended: 0 },
    },
    stall(match: (key: string) => boolean, mode?: Parameters<FakeS3['stall']>[1]) {
      releases.push(s3.stall(match, mode))
    },
  }
}

async function seedProject(s3: FakeS3, projectId: string) {
  const files = { 'src/App.tsx': 'the user’s app\n' }
  const t0 = Date.now() - 7_200_000
  s3.put(`${projectId}/project-src.tar.gz`, tarOf(files), t0)
  const repo = await repoArchiveOf(files)
  s3.put(`${projectId}/repo.git.tar.gz`, repo.bytes, t0 + 60_000)
  return { repoKey: `${projectId}/repo.git.tar.gz`, repoSha: repo.sha }
}

function controller(host: ReturnType<typeof metalHost>) {
  const env = async () => ({ RUNTIME_AUTH_SECRET: 'tok' })
  const c = new MetalWarmPoolController(env as any, fetch, Date.now, new MetalPlacementRegistry(() => null))
  c.registerHost(host.registration)
  return c
}

/** What the IDE does: retry an open that timed out, until it gets a URL. */
async function openLikeTheIde(c: InstanceType<typeof MetalWarmPoolController>, projectId: string, beforeRetry?: () => Promise<void>) {
  const t0 = performance.now()
  let timeouts = 0
  for (;;) {
    try {
      const url = await c.getMetalProjectUrl(projectId)
      return { url, timeouts, ms: performance.now() - t0 }
    } catch (err) {
      if (!isAssignTimeout(err) || ++timeouts > 10) throw err
      await beforeRetry?.()
    }
  }
}

describe('opening a project while object storage hangs on its git history', () => {
  test('the first /assign answers inside the API budget, served on the source, and is measured as such', async () => {
    const host = metalHost('dal-1', 'deferring')
    const { repoKey } = await seedProject(host.s3, 'p1')
    host.stall((k) => k === repoKey)
    const c = controller(host)

    const { url, timeouts, ms } = await openLikeTheIde(c, 'p1')

    // The incident: five assign timeouts. Now: none, and well inside the budget.
    expect(url).toStartWith('http://127.0.0.1:')
    expect(timeouts).toBe(0)
    expect(ms).toBeLessThan(ASSIGN_TIMEOUT_MS)
    expect(host.s3.stalledGets((k) => k === repoKey)).toBeGreaterThan(0)

    expect((await points('metal.host_errors', 'dal-1')).filter((p) => p.attributes.reason === 'timeout')).toEqual([])
    const ready = await points('metal.time_to_ready_ms', 'dal-1')
    expect(ready.map((p) => p.attributes)).toEqual([{ path: 'assigned', host_id: 'dal-1', region: 'us' }])
    expect(hist(ready[0]).count).toBe(1)
    expect(hist(ready[0]).max!).toBeLessThan(ASSIGN_TIMEOUT_MS)
    // The dashboards can tell this open skipped the history download.
    const repo = await points('metal.repo_hydrate', 'dal-1')
    expect(repo.map((p) => [p.attributes.mode, p.attributes.host_id, count(p)])).toEqual([['deferred', 'dal-1', 1]])
  }, 30_000)

  test('an open that does outlive the budget is measured from the first attempt, with the host phases that caused it', async () => {
    // A guest that cannot refuse a late `.git` swap has to be waited for, so
    // a slow download still holds its open: the incident's exact shape.
    const host = metalHost('dal-2', 'current')
    const { repoKey } = await seedProject(host.s3, 'p1')
    const SLOW = Math.round(ASSIGN_TIMEOUT_MS * 1.5)
    host.stall((k) => k === repoKey, { kind: 'delay', afterMs: SLOW })
    const c = controller(host)

    // The IDE retries after each timeout; by the retry the host has finished
    // the open the API gave up on, so the retry re-attaches to it.
    const { timeouts, ms } = await openLikeTheIde(c, 'p1', async () => {
      const until = Date.now() + 15_000
      while (!host.finished.includes('p1') && Date.now() < until) await Bun.sleep(20)
    })

    expect(timeouts).toBe(1)
    expect(ms).toBeGreaterThanOrEqual(SLOW)
    expect((await points('metal.host_errors', 'dal-2')).filter((p) => p.attributes.reason === 'timeout').map(count)).toEqual([1])

    // One open, one measurement: the whole wait, not the 2s the retry took.
    const ready = await points('metal.time_to_ready_ms', 'dal-2')
    expect(ready.map((p) => p.attributes)).toEqual([{ path: 'after_timeout', host_id: 'dal-2', region: 'us' }])
    expect(hist(ready[0]).count).toBe(1)
    expect(hist(ready[0]).max!).toBeGreaterThanOrEqual(SLOW)

    // The open the API stopped waiting for still reports where its time went.
    const phases = await points('metal.wake_phase_ms', 'dal-2')
    const lateRepo = phases.find((p) => p.attributes.phase === 'host.hydrate_repo' && p.attributes.mode === 'late_assigned')
    expect(lateRepo).toBeDefined()
    expect(hist(lateRepo!).max!).toBeGreaterThanOrEqual(SLOW - 100)
    const repo = await points('metal.repo_hydrate', 'dal-2')
    expect(repo.map((p) => [p.attributes.mode, count(p)])).toEqual([['foreground', 1]])
  }, 60_000)
})
