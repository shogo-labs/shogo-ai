// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Two node-agents under one `METAL_HOST_ID` must not merge into one fleet entry.
 *
 * `registerHost` used to overwrite the whole entry on every heartbeat, so the
 * second agent's load/disk/capacity replaced the live host's 30 times a minute
 * and `metal.host.disk_used_pct` for that hostId became an average of two
 * machines (a 76%-full host and a 12%-full one read as one series). The
 * incumbent is now kept and the collision is counted — but only while the
 * incumbent is actually heartbeating, or a host whose meshIp legitimately
 * changed could never reclaim its own id.
 *
 * The meter provider must be installed BEFORE the controller module loads (OTel
 * meters do not retro-delegate), hence the dynamic import of its own instance.
 */

import { describe, expect, mock, test } from 'bun:test'
import { metrics } from '@opentelemetry/api'
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

mock.module('../prisma', () => ({ prisma: {} }))

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const provider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
})
metrics.setGlobalMeterProvider(provider)

const mod = await import('../metal-warm-pool-controller?hostid-collision')
const { MetalWarmPoolController } = mod
type Registration = Parameters<InstanceType<typeof MetalWarmPoolController>['registerHost']>[0]

const T0 = 1_700_000_000_000
const HOST_TTL_MS = 90_000

/** Heartbeats and registry writes, captured instead of hitting Redis. */
function harness() {
  let clock = T0
  const upserts: any[] = []
  const controller = new MetalWarmPoolController(
    (async () => ({})) as any,
    (async () => new Response()) as any,
    () => clock,
    {
      upsertHost: async (s: any) => {
        upserts.push(s)
      },
      listHosts: async () => [],
    } as any,
  )
  return {
    controller,
    upserts,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function reg(overrides: Partial<Registration> = {}): Registration {
  return {
    hostId: 'latitude-dal-1',
    meshIp: '10.8.0.2',
    agentPort: 9900,
    region: 'us',
    arch: 'x64',
    capacity: { poolSize: 40, memMiB: 98304, vcpus: 64 },
    load: { available: 12, assigned: 3, suspended: 25 },
    disk: { totalBytes: 4_000, freeBytes: 630, usedPct: 84.27, cacheBytes: 200, localCount: 694 },
    ...overrides,
  }
}

/** The one live entry for a hostId (the controller keeps a map keyed by id). */
function entry(controller: InstanceType<typeof MetalWarmPoolController>, hostId = 'latitude-dal-1') {
  const found = controller.liveHosts().filter((h) => h.hostId === hostId)
  expect(found).toHaveLength(1)
  return found[0]
}

async function collisionPoints(): Promise<Array<{ attributes: Record<string, unknown>; value: number }>> {
  await provider.forceFlush()
  const latest = exporter.getMetrics().at(-1)
  if (!latest) return []
  return latest.scopeMetrics
    .flatMap((sm) => sm.metrics)
    .filter((m) => m.descriptor.name === 'metal.host.id_collisions')
    .flatMap((m) => m.dataPoints as any)
}

describe('registerHost under a duplicated METAL_HOST_ID', () => {
  test('keeps the incumbent and counts the collision when the meshIp differs', async () => {
    const { controller, upserts } = harness()
    controller.registerHost(reg())
    expect(upserts).toHaveLength(1)

    const warn: string[] = []
    const origWarn = console.warn
    console.warn = (...args: any[]) => warn.push(args.join(' '))
    let result: { hostIdCollision: boolean }
    try {
      result = controller.registerHost(
        reg({
          meshIp: '10.8.0.99',
          load: { available: 200, assigned: 0, suspended: 0 },
          disk: { totalBytes: 4_000, freeBytes: 3_500, usedPct: 12, cacheBytes: 0, localCount: 0 },
        }),
      )
    } finally {
      console.warn = origWarn
    }

    expect(result.hostIdCollision).toBe(true)
    const host = entry(controller)
    // The incumbent's identity, occupancy and disk all survive the colliding heartbeat.
    expect(host.meshIp).toBe('10.8.0.2')
    expect(host.load.available).toBe(12)
    expect(host.disk?.usedPct).toBe(84.27)
    // Nothing was published: a sibling replica must keep reading one host's numbers.
    expect(upserts).toHaveLength(1)
    expect(warn.join('\n')).toContain(
      '[MetalPool] hostId collision: latitude-dal-1 already registered from 10.8.0.2, ignoring 10.8.0.99',
    )

    const points = await collisionPoints()
    const us = points.find((p) => p.attributes.region === 'us')
    expect(us?.value).toBeGreaterThanOrEqual(1)
  }, 30_000)

  test('a non-colliding heartbeat still adopts new values', () => {
    const { controller } = harness()
    expect(controller.registerHost(reg()).hostIdCollision).toBe(false)

    const next = controller.registerHost(
      reg({
        load: { available: 4, assigned: 9, suspended: 27 },
        disk: { totalBytes: 4_000, freeBytes: 500, usedPct: 87.5, cacheBytes: 0, localCount: 700 },
      }),
    )
    expect(next.hostIdCollision).toBe(false)
    const host = entry(controller)
    expect(host.load.assigned).toBe(9)
    expect(host.disk?.usedPct).toBe(87.5)
  })

  test('a new meshIp is adopted once the incumbent has gone stale', () => {
    const { controller, advance, upserts } = harness()
    controller.registerHost(reg())
    advance(HOST_TTL_MS + 1_000)

    const result = controller.registerHost(reg({ meshIp: '10.8.0.7', load: { available: 30, assigned: 0, suspended: 0 } }))
    expect(result.hostIdCollision).toBe(false)
    const host = entry(controller)
    expect(host.meshIp).toBe('10.8.0.7')
    expect(host.load.available).toBe(30)
    expect(upserts).toHaveLength(2)
  })
})
