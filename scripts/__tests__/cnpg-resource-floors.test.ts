// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The CNPG platform Postgres pods were sized below their own working set: on
 * 2026-10-14 `platform-pg-2` held 3.88 GiB average / 4.00 GiB peak against a
 * 2Gi request and a 4Gi limit (97% of the limit, 163-393% of the request), and
 * nothing alerted on it. Both production manifests declared exactly
 * `request/limit = 0.50`, which is the under-reservation this pins.
 *
 * Pure-static: reads the two Cluster manifests, no cluster access.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

const root = resolve(import.meta.dir, '../..')

// [manifest, request MiB floor, limit MiB floor] — the sizing the fix must land.
// Both pairs are request/limit = 0.667. The pre-fix manifests are 2048/4096 and
// 1024/2048 — exactly 0.50.
const CLUSTERS: Array<[path: string, requestMi: number, limitMi: number]> = [
  ['k8s/cnpg/production-us-oci/platform-cluster.yaml', 4096, 6144],
  ['k8s/cnpg/production-eu-oci/platform-cluster.yaml', 2048, 3072],
]

function toMi(q: unknown): number {
  if (typeof q !== 'string') throw new Error(`expected a memory quantity string, got ${typeof q}`)
  const unit = q.endsWith('Gi') ? 1024 : q.endsWith('Mi') ? 1 : null
  if (unit === null) throw new Error(`unparsable memory quantity: ${q}`)
  return Math.round(Number.parseFloat(q) * unit)
}

describe('CNPG platform-pg memory floors', () => {
  for (const [path, floorReq, floorLim] of CLUSTERS) {
    test(`${path}: request tracks the working set, limit leaves OOM headroom`, () => {
      const spec = parse(readFileSync(resolve(root, path), 'utf8')).spec ?? {}
      const r = spec.resources ?? {}
      const req = toMi(r.requests?.memory)
      const lim = toMi(r.limits?.memory)
      expect(req).toBeLessThanOrEqual(lim)
      // request ≈ the live working set (pg-2: 3.88 GiB avg / 4.00 GiB peak)
      expect(req).toBeGreaterThanOrEqual(floorReq)
      expect(lim).toBeGreaterThanOrEqual(floorLim)
      // request must be ≥ 60% of limit: the live pods run at 163–393% of request,
      // so a request far below the limit is exactly the under-reservation defect.
      expect(req / lim).toBeGreaterThanOrEqual(0.6)
    })
  }
})

// Beyond the sizing spec above: the rule that makes the next under-reservation
// loud. `platform-pg` is declared with the same metadata.name in the same
// namespace by two independent Cluster manifests on two different OKE clusters,
// so a `k8s.pod.name`-only groupBy splices them into one series — the failure
// that produced the phantom `platform-pg-3` row in the 2026-10-13 scan.
describe('CNPGPostgresMemorySaturation alert', () => {
  const ALERT = 'terraform/modules/signoz/alerts/cnpg-memory-saturation.yaml'
  const rule = parse(readFileSync(resolve(root, ALERT), 'utf8'))
  const spec = rule.condition.compositeQuery.queries[0].spec

  test('is a v2alpha1 container memory-utilisation rule wired to platform-oncall', () => {
    expect(rule.schemaVersion).toBe('v2alpha1')
    expect(rule.alert).toBe('CNPGPostgresMemorySaturation')
    expect(spec.aggregations[0].metricName).toBe('k8s.container.memory_limit_utilization')
    expect(spec.filter.expression).toContain("k8s.namespace.name = 'shogo-production-system'")
    expect(spec.filter.expression).toContain("k8s.container.name = 'postgres'")

    const threshold = rule.condition.thresholds.spec[0]
    expect(threshold.op).toBe('above')
    expect(threshold.target).toBe(0.9)
    expect(threshold.matchType).toBe('all_the_times')
    expect(threshold.channels).toContain('platform-oncall')
  })

  test('groups by cluster as well as pod, and notifies on the same keys', () => {
    const groupBy = spec.groupBy.map((g: { name: string }) => g.name)
    expect(groupBy).toContain('k8s.pod.name')
    expect(groupBy).toContain('k8s.cluster.name')
    expect(rule.notificationSettings.groupBy).toEqual(groupBy)
  })
})
