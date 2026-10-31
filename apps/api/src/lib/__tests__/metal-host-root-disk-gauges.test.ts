// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `metal.host.root_disk_used_pct` / `metal.host.root_disk_free_bytes` (SHO-271).
 *
 * The ROOT filesystem is where `/var/lib/docker` keeps every pulled
 * `shogo-runtime` image. `metal.host.disk_used_pct` describes the NVMe cache
 * only, so a host whose root disk filled (dal-2: 83 images, 100%, ten days of
 * failed updates) looked healthy. These gauges are the missing series, and an
 * older agent that does not report the field must produce no series at all —
 * a zero would read as an empty disk.
 *
 * The meter provider must be installed BEFORE the controller module loads (OTel
 * meters do not retro-delegate), hence the dynamic import of a distinct module
 * instance in a file of its own.
 */

import { describe, expect, test } from 'bun:test'
import { metrics } from '@opentelemetry/api'
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const provider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
})
metrics.setGlobalMeterProvider(provider)

// A distinct module instance (query string) so this file works whether or not
// another test file already loaded the controller without our meter provider.
const { registerMetalHost } = await import('../metal-warm-pool-controller?rootdisk-gauges')

interface Point {
  attributes: Record<string, unknown>
  value: number
}

async function points(name: string, hostId: string): Promise<Point[]> {
  await provider.forceFlush()
  const latest = exporter.getMetrics().at(-1)
  if (!latest) return []
  return latest.scopeMetrics
    .flatMap((sm) => sm.metrics)
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) => m.dataPoints as unknown as Point[])
    .filter((p) => p.attributes.host_id === hostId)
}

function registration(hostId: string, extra: Record<string, unknown> = {}) {
  return {
    hostId,
    meshIp: '10.100.0.9',
    agentPort: 9900,
    region: 'us',
    arch: 'x64',
    capacity: { poolSize: 4, memMiB: 4096, vcpus: 4 },
    load: { available: 1, assigned: 2, suspended: 0 },
    disk: { totalBytes: 0, freeBytes: 0, usedPct: 5, cacheBytes: 0, localCount: 0 },
    ...extra,
  } as any
}

describe('metal.host.root_disk_* gauges', () => {
  test('emits used percent and free bytes per host_id', async () => {
    registerMetalHost(registration('rootdisk-a', { rootDisk: { totalBytes: 440e9, freeBytes: 44e9, usedPct: 90 } }))
    const used = await points('metal.host.root_disk_used_pct', 'rootdisk-a')
    const free = await points('metal.host.root_disk_free_bytes', 'rootdisk-a')
    expect(used).toHaveLength(1)
    expect(used[0].value).toBe(90)
    expect(used[0].attributes.region).toBe('us')
    expect(free).toHaveLength(1)
    expect(free[0].value).toBe(44e9)
  })

  test('an agent that does not report rootDisk produces no series and no error', async () => {
    expect(() => registerMetalHost(registration('rootdisk-old'))).not.toThrow()
    expect(await points('metal.host.root_disk_used_pct', 'rootdisk-old')).toEqual([])
    expect(await points('metal.host.root_disk_free_bytes', 'rootdisk-old')).toEqual([])
    // ...while the NVMe series it does report is unaffected.
    expect(await points('metal.host.disk_used_pct', 'rootdisk-old')).toHaveLength(1)
  })

  test('a root disk at 100% reads as 100, not as "no data"', async () => {
    registerMetalHost(registration('rootdisk-full', { rootDisk: { totalBytes: 440e9, freeBytes: 0, usedPct: 100 } }))
    const used = await points('metal.host.root_disk_used_pct', 'rootdisk-full')
    expect(used[0].value).toBe(100)
  })
})
