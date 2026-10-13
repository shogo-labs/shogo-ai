// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Production detector for the runtime placement invariant:
 *
 *   one live runtime per project, in the workspace's home region.
 *
 * #1232, #1233, #1236 and #1238 were all the same failure — a project running
 * on two hosts, or in the wrong region — and each was found by a user seeing
 * the starter template, or by someone counting VMs by hand (29 projects).
 * This audit asks the fleet instead, every reconcile tick, and exposes the
 * answer as metrics plus an error log line to alert on.
 *
 * Two violations, both scoped to the runtimes THIS region's hosts report (hosts
 * heartbeat only to their own region's control plane, so each region audits
 * itself; a project in the wrong region shows up in the region it wrongly runs
 * in):
 *
 *   duplicate_host        the same runtime key is held by more than one host.
 *                         `split` when two hosts are RUNNING it (both can write
 *                         state), `stale_copy` when the extra one is a snapshot.
 *   outside_home_region   a project's runtime exists in a region other than its
 *                         workspace's `homeRegion` (a stale tree there backs up
 *                         over the real one).
 *
 * `published:{id}` keys are skipped: since #1241 a published VM never writes
 * durable source, and a regional copy of it is not a violation. Workspace keys
 * (`ws:{workspaceId}`) have no single project to compare, so are skipped for
 * the home-region check but still checked for duplicates.
 */

import { metrics } from '@opentelemetry/api'

export interface RuntimeRow {
  projectId: string
  ready: boolean
  host?: string
  region?: string
}

export type RuntimeViolation =
  | {
      kind: 'duplicate_host'
      key: string
      severity: 'split' | 'stale_copy'
      hosts: string[]
    }
  | {
      kind: 'outside_home_region'
      key: string
      projectId: string
      region: string
      homeRegion: string
      hosts: string[]
    }

export interface RuntimeAuditReport {
  at: number
  runtimes: number
  violations: RuntimeViolation[]
}

const meter = metrics.getMeter('shogo-metal-audit')
const violationGauge = meter.createObservableGauge('metal.runtime.invariant_violations', {
  description:
    'Runtimes violating the placement invariant at the last audit, labelled by kind ' +
    '(duplicate_split|duplicate_stale_copy|outside_home_region). Alert on > 0.',
})
const auditErrors = meter.createCounter('metal.runtime.audit_errors', {
  description: 'Runtime placement audits that failed to run',
})

let last: RuntimeAuditReport | null = null

violationGauge.addCallback((obs) => {
  const counts = { duplicate_split: 0, duplicate_stale_copy: 0, outside_home_region: 0 }
  for (const v of last?.violations ?? []) {
    if (v.kind === 'outside_home_region') counts.outside_home_region++
    else if (v.severity === 'split') counts.duplicate_split++
    else counts.duplicate_stale_copy++
  }
  for (const [kind, n] of Object.entries(counts)) obs.observe(n, { kind })
})

/** The last audit's report (tests, admin surfaces). */
export function getLastRuntimeAudit(): RuntimeAuditReport | null {
  return last
}

/** @internal */
export function _resetRuntimeAudit(): void {
  last = null
}

/** The project a runtime key belongs to, or null when it has no single project. */
export function projectIdOfRuntimeKey(key: string): string | null {
  if (key.startsWith('published:')) return null
  if (key.startsWith('ws:proj:')) return key.slice('ws:proj:'.length) || null
  if (key.startsWith('ws:')) return null
  return key
}

/** Runtime keys held by more than one host. Pure. */
export function findDuplicateRuntimes(rows: RuntimeRow[]): RuntimeViolation[] {
  const byKey = new Map<string, Map<string, boolean>>()
  for (const r of rows) {
    if (r.projectId.startsWith('published:') || !r.host) continue
    const hosts = byKey.get(r.projectId) ?? new Map<string, boolean>()
    // A host listing the key both as running and cached counts as running.
    hosts.set(r.host, (hosts.get(r.host) ?? false) || r.ready)
    byKey.set(r.projectId, hosts)
  }
  const out: RuntimeViolation[] = []
  for (const [key, hosts] of byKey) {
    if (hosts.size < 2) continue
    const running = [...hosts.values()].filter(Boolean).length
    out.push({
      kind: 'duplicate_host',
      key,
      severity: running >= 2 ? 'split' : 'stale_copy',
      hosts: [...hosts.keys()].sort(),
    })
  }
  return out
}

/**
 * Projects whose runtime exists in `region` although their workspace is homed
 * elsewhere. Pure: `homeRegions` maps projectId -> workspace homeRegion (null
 * or absent = unknown/legacy, never a violation). `peerIds` are the configured
 * peer regions: a home region that isn't a peer has nowhere else to run.
 */
export function findOutsideHomeRuntimes(
  rows: RuntimeRow[],
  region: string,
  homeRegions: Map<string, string | null>,
  peerIds: string[],
): RuntimeViolation[] {
  const hostsByProject = new Map<string, Set<string>>()
  const keyByProject = new Map<string, string>()
  for (const r of rows) {
    const projectId = projectIdOfRuntimeKey(r.projectId)
    if (!projectId) continue
    const hosts = hostsByProject.get(projectId) ?? new Set<string>()
    if (r.host) hosts.add(r.host)
    hostsByProject.set(projectId, hosts)
    keyByProject.set(projectId, r.projectId)
  }
  const out: RuntimeViolation[] = []
  for (const [projectId, hosts] of hostsByProject) {
    const homeRegion = homeRegions.get(projectId)
    if (!homeRegion || homeRegion === region || !peerIds.includes(homeRegion)) continue
    out.push({
      kind: 'outside_home_region',
      key: keyByProject.get(projectId)!,
      projectId,
      region,
      homeRegion,
      hosts: [...hosts].sort(),
    })
  }
  return out
}

export interface RuntimeAuditDeps {
  listRuntimes: () => Promise<RuntimeRow[]>
  /** This control plane's region id; null in single-region/local (no home-region check). */
  region?: string | null
  peerIds?: string[]
  /** projectId -> workspace homeRegion. Defaults to a batched database lookup. */
  loadHomeRegions?: (projectIds: string[]) => Promise<Map<string, string | null>>
  now?: () => number
}

async function defaultLoadHomeRegions(projectIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (projectIds.length === 0) return out
  const { prisma } = await import('./prisma')
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, workspaceId: true },
  })
  const workspaceIds = [...new Set(projects.map((p: { workspaceId: string }) => p.workspaceId))]
  const workspaces = await prisma.workspace.findMany({
    where: { id: { in: workspaceIds } },
    select: { id: true, homeRegion: true },
  })
  const home = new Map<string, string | null>(
    workspaces.map((w: { id: string; homeRegion: string | null }) => [w.id, w.homeRegion ?? null]),
  )
  for (const p of projects as Array<{ id: string; workspaceId: string }>) {
    out.set(p.id, home.get(p.workspaceId) ?? null)
  }
  return out
}

/**
 * Run one audit: list what the fleet runs, find violations, publish metrics and
 * log each one at error level (`[metal-audit] INVARIANT VIOLATION ...`).
 * Never throws — a detector must not take down the reconcile loop.
 */
export async function auditMetalRuntimes(deps: RuntimeAuditDeps): Promise<RuntimeAuditReport | null> {
  try {
    const rows = await deps.listRuntimes()
    const violations = findDuplicateRuntimes(rows)

    const { RAW_REGION_ID, REGION_PEERS } = await import('./region')
    const region = 'region' in deps ? deps.region : RAW_REGION_ID
    const peerIds = deps.peerIds ?? REGION_PEERS.map((p) => p.id)
    if (region && peerIds.length > 0) {
      // A failed home-region lookup (database blip) must not hide duplicates.
      try {
        const projectIds = [
          ...new Set(rows.map((r) => projectIdOfRuntimeKey(r.projectId)).filter((id): id is string => !!id)),
        ]
        const homeRegions = await (deps.loadHomeRegions ?? defaultLoadHomeRegions)(projectIds)
        violations.push(...findOutsideHomeRuntimes(rows, region, homeRegions, peerIds))
      } catch (err: any) {
        auditErrors.add(1)
        console.warn('[metal-audit] home-region check skipped:', err?.message ?? err)
      }
    }

    const report: RuntimeAuditReport = { at: (deps.now ?? Date.now)(), runtimes: rows.length, violations }
    last = report
    for (const v of violations) {
      if (v.kind === 'duplicate_host') {
        console.error(
          `[metal-audit] INVARIANT VIOLATION duplicate_host (${v.severity}): ${v.key} is held by ${v.hosts.join(', ')}`,
        )
      } else {
        console.error(
          `[metal-audit] INVARIANT VIOLATION outside_home_region: ${v.projectId} runs in ${v.region} on ` +
            `${v.hosts.join(', ')} but its workspace is homed in ${v.homeRegion}`,
        )
      }
    }
    return report
  } catch (err: any) {
    auditErrors.add(1)
    console.warn('[metal-audit] audit failed:', err?.message ?? err)
    return null
  }
}
