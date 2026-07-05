// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Metal Warm Pool Controller — the control-plane (apps/api) side of the
 * cloud-agnostic Firecracker substrate (see the Cloud Firecracker snapshots
 * plan). It is the `metal` analog of:
 *   - warm-pool-controller.ts   (Knative pods)
 *   - vm-warm-pool-controller.ts (desktop VMs, getVMProjectUrl)
 *
 * Unlike those two, the pool lives OFF-cluster on bare-metal hosts (Latitude.sh
 * pilot) reached over the WireGuard mesh. Each host runs apps/metal-agent, which:
 *   - announces itself here on a heartbeat (POST /api/internal/metal/register),
 *   - owns its local Firecracker warm pool + per-project suspend/restore,
 *   - resolves POST {meshIp}:{agentPort}/assign to a mesh-routable runtime URL
 *     (resume-from-snapshot on a hit, else claim+assign a warm microVM).
 *
 * So this controller does NOT boot or snapshot anything itself — it is a router:
 * pick a live host with capacity (sticky per project so a project keeps hitting
 * the host that holds its hot/durable snapshot), call /assign, surface the URL,
 * and record snapshot hit-rate / wake-latency metrics mirroring `warm_pool.*`.
 *
 * getMetalProjectUrl throws on any miss/host failure; resolveProjectPodUrl
 * treats metal as best-effort and falls back to the Knative path, so this is
 * safe to roll out behind the per-project flag.
 */

import { trace, SpanStatusCode, metrics } from '@opentelemetry/api'
import { buildProjectEnv } from './runtime/build-project-env'
import { getMetalPlacementRegistry, type HostScalars, type MetalPlacementRegistry } from './metal-placement-registry'

const tracer = trace.getTracer('shogo-metal-pool')
const meter = metrics.getMeter('shogo-metal-pool')

const assignmentsCounter = meter.createCounter('metal.assignments', {
  description: 'Metal /assign resolutions, labelled by mode (assigned|resumed) and source (local|store|none)',
})
const coldMissCounter = meter.createCounter('metal.cold_miss', {
  description: 'Metal assigns that were a fresh claim (no snapshot to resume) — the cold-start denominator for hit-rate',
})
const hostErrorCounter = meter.createCounter('metal.host_errors', {
  description: 'Metal host /assign call failures (network/5xx), labelled by reason',
})
const noHostCounter = meter.createCounter('metal.no_host', {
  description: 'getMetalProjectUrl calls with no live host available (falls back to Knative)',
})
const wakeLatency = meter.createHistogram('metal.wake_latency_ms', {
  description: 'Host-reported restore→ready latency for a resumed project (the user-facing wake cost)',
  unit: 'ms',
})

/** Registration payload a node-agent POSTs on its heartbeat (see register.ts). */
export interface MetalHostRegistration {
  hostId: string
  meshIp: string
  agentPort: number
  region: string
  arch: string
  capacity: { poolSize: number; memMiB: number; vcpus: number }
  load: { available: number; assigned: number; suspended: number }
  /** NVMe cache scalars (Phase 5). Absent on older agents → treated as headroom. */
  disk?: { totalBytes: number; freeBytes: number; usedPct: number; cacheBytes: number; localCount: number }
  /** Compact node-agent counters (gc/resume) for fleet observability. */
  metrics?: Record<string, number>
}

interface HostEntry extends MetalHostRegistration {
  registeredAt: number
  lastSeenAt: number
}

/** A host is considered live if it heartbeat within this window. */
const HOST_TTL_MS = parseInt(process.env.METAL_HOST_TTL_MS || '90000', 10)
const ASSIGN_TIMEOUT_MS = parseInt(process.env.METAL_ASSIGN_TIMEOUT_MS || '30000', 10)
/** Hosts at/above this used% are de-prioritized for NEW cold placements (GC pressure). */
const DISK_HIGH_PCT = parseInt(process.env.METAL_DISK_HIGH_PCT || '85', 10)

export class NoMetalHostError extends Error {
  readonly code = 'NO_METAL_HOST'
  constructor(msg = 'no live metal host available') {
    super(msg)
    this.name = 'NoMetalHostError'
  }
}

interface AssignResult {
  url: string
  mode?: 'assigned' | 'resumed'
  source?: 'local' | 'store'
  readyMs?: number
}

type EnvBuilder = (projectId: string) => Promise<Record<string, string>>
type FetchImpl = typeof fetch

export class MetalWarmPoolController {
  private hosts = new Map<string, HostEntry>()
  /** projectId → hostId. Sticky so a project returns to the host holding its snapshot. */
  private projectHost = new Map<string, string>()
  private pending = new Map<string, Promise<string>>()
  private stats = { assigned: 0, resumed: 0, coldMiss: 0, hostErrors: 0, noHost: 0 }

  /** Stable per-process lease holder token (distinct per API replica). */
  private holderId = `metal-cp-${process.env.HOSTNAME || crypto.randomUUID()}`

  constructor(
    private envBuilder: EnvBuilder = buildProjectEnv,
    private fetchImpl: FetchImpl = fetch,
    private now: () => number = Date.now,
    private registry: MetalPlacementRegistry = getMetalPlacementRegistry(),
  ) {}

  /** Upsert a host from its heartbeat, mirroring scalars to the shared registry. */
  registerHost(reg: MetalHostRegistration): void {
    const existing = this.hosts.get(reg.hostId)
    const entry: HostEntry = {
      ...reg,
      registeredAt: existing?.registeredAt ?? this.now(),
      lastSeenAt: this.now(),
    }
    this.hosts.set(reg.hostId, entry)
    // Publish scalars so sibling API replicas see this host (best-effort).
    const scalars: HostScalars = {
      hostId: reg.hostId,
      meshIp: reg.meshIp,
      agentPort: reg.agentPort,
      region: reg.region,
      arch: reg.arch,
      capacity: reg.capacity,
      load: reg.load,
      disk: reg.disk,
      lastSeenAt: entry.lastSeenAt,
    }
    void this.registry.upsertHost(scalars).catch(() => {})
  }

  /** Hosts that heartbeat within HOST_TTL_MS. */
  liveHosts(): HostEntry[] {
    const cutoff = this.now() - HOST_TTL_MS
    return [...this.hosts.values()].filter((h) => h.lastSeenAt >= cutoff)
  }

  /**
   * Candidate hosts for a project, best-first:
   *   1. the host that holds the project locally (cache hit) — from the shared
   *      registry placement if provided, else local stickiness; a local resume
   *      is sub-second vs a cross-host S3 pull or a cold boot;
   *   2. remaining live hosts UNDER the disk high-watermark, lightest-load first;
   *   3. hosts AT/OVER the high-watermark last (they're shedding via GC, so
   *      placing a new cold project there just fights the sweep).
   */
  private candidates(projectId: string, placedHostId?: string): HostEntry[] {
    const live = this.liveHosts()
    const preferId = placedHostId ?? this.projectHost.get(projectId)
    const preferred = preferId ? live.find((h) => h.hostId === preferId) : undefined
    const rest = live
      .filter((h) => h.hostId !== preferred?.hostId)
      .sort((a, b) => {
        // Under-watermark hosts always sort ahead of over-watermark ones.
        const ap = overWatermark(a) ? 1 : 0
        const bp = overWatermark(b) ? 1 : 0
        if (ap !== bp) return ap - bp
        return loadRatio(a) - loadRatio(b)
      })
    return preferred ? [preferred, ...rest] : rest
  }

  /**
   * Resolve a project to a mesh-routable runtime URL by calling a host's
   * /assign (which resumes-from-snapshot on a hit, else claims a warm microVM).
   * Deduplicates concurrent callers for the same project. Throws when no host is
   * live or every candidate fails — the caller (resolveProjectPodUrl) then falls
   * back to the Knative path.
   */
  async getMetalProjectUrl(projectId: string): Promise<string> {
    const inflight = this.pending.get(projectId)
    if (inflight) return inflight
    const p = this._resolve(projectId).finally(() => this.pending.delete(projectId))
    this.pending.set(projectId, p)
    return p
  }

  private async _resolve(projectId: string): Promise<string> {
    return tracer.startActiveSpan('metal.get_pod_url', { attributes: { 'project.id': projectId } }, async (span) => {
      try {
        // Anti split brain: acquire a short-TTL lease before resuming. The
        // winner runs the project; a loser converges on the winner's host (from
        // the placement it publishes) so two hosts never run the same project
        // and write the same S3 workspace keys. Fails open on a Redis blip.
        const gotLease = await this.registry.acquireLease(projectId, this.holderId).catch(() => true)
        let placedHostId: string | undefined
        if (!gotLease) {
          placedHostId = (await this.waitForPlacement(projectId))?.hostId
          span.setAttribute('resolve.lease', 'joined')
        } else {
          placedHostId = (await this.registry.getPlacement(projectId).catch(() => null))?.hostId
          span.setAttribute('resolve.lease', 'acquired')
        }

        const cands = this.candidates(projectId, placedHostId)
        if (cands.length === 0) {
          if (gotLease) void this.registry.releaseLease(projectId, this.holderId).catch(() => {})
          this.stats.noHost++
          noHostCounter.add(1)
          span.setAttribute('resolve.method', 'no_host')
          throw new NoMetalHostError()
        }

        const env = await this.envBuilder(projectId)
        let lastErr: unknown

        for (const host of cands) {
          try {
            const res = await this.assignOnHost(host, projectId, env)
            this.projectHost.set(projectId, host.hostId)
            // Publish placement so sibling replicas route here (cache-aware) and
            // any lease loser converges on this host. The project is now local.
            void this.registry.setPlacement(projectId, host.hostId, 'local').catch(() => {})
            if (gotLease) void this.registry.renewLease(projectId, this.holderId).catch(() => {})

            const mode = res.mode ?? 'assigned'
            const source = res.source ?? 'none'
            assignmentsCounter.add(1, { mode, source })
            span.setAttribute('resolve.host', host.hostId)
            span.setAttribute('resolve.region', host.region)
            span.setAttribute('resolve.method', mode === 'resumed' ? `resumed_${source}` : 'assigned')
            if (mode === 'resumed') {
              this.stats.resumed++
              if (typeof res.readyMs === 'number') {
                wakeLatency.record(res.readyMs, { source })
                span.setAttribute('resolve.wake_ms', res.readyMs)
              }
            } else {
              this.stats.assigned++
              this.stats.coldMiss++
              coldMissCounter.add(1)
            }
            span.setStatus({ code: SpanStatusCode.OK })
            return res.url
          } catch (err) {
            lastErr = err
            this.stats.hostErrors++
            hostErrorCounter.add(1, { host: host.hostId })
            // Drop stickiness/placement so we don't keep hammering a dead host.
            if (this.projectHost.get(projectId) === host.hostId) this.projectHost.delete(projectId)
            void this.registry.clearPlacement(projectId).catch(() => {})
            console.warn(`[MetalPool] assign on host ${host.hostId} failed for ${projectId}: ${(err as any)?.message ?? err}`)
          }
        }

        // Nothing succeeded — release the lease we hold so a retry (here or on a
        // sibling replica) isn't blocked waiting for the TTL to expire.
        if (gotLease) void this.registry.releaseLease(projectId, this.holderId).catch(() => {})
        span.setAttribute('resolve.method', 'all_hosts_failed')
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'all metal hosts failed' })
        throw lastErr ?? new NoMetalHostError('all metal hosts failed')
      } catch (err: any) {
        span.recordException(err)
        throw err
      } finally {
        span.end()
      }
    })
  }

  /**
   * Wait (bounded) for the lease winner to publish a placement, so a lease loser
   * routes to the SAME host instead of racing to a different one. Returns null
   * if none appears in time (caller falls back to normal candidate ordering).
   */
  private async waitForPlacement(projectId: string, timeoutMs = 3000, stepMs = 100): Promise<{ hostId: string } | null> {
    const deadline = this.now() + timeoutMs
    for (;;) {
      const p = await this.registry.getPlacement(projectId).catch(() => null)
      if (p) return p
      if (this.now() >= deadline) return null
      await new Promise((r) => setTimeout(r, stepMs))
    }
  }

  private async assignOnHost(host: HostEntry, projectId: string, env: Record<string, string>): Promise<AssignResult> {
    const base = `http://${host.meshIp}:${host.agentPort}`
    const res = await this.fetchImpl(`${base}/assign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.METAL_REGISTER_TOKEN ? { Authorization: `Bearer ${process.env.METAL_REGISTER_TOKEN}` } : {}),
      },
      body: JSON.stringify({ projectId, env }),
      signal: AbortSignal.timeout(ASSIGN_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`metal /assign ${res.status}: ${await res.text().catch(() => '')}`)
    }
    const body = (await res.json()) as AssignResult
    if (!body?.url) throw new Error('metal /assign returned no url')
    return body
  }

  /** Best-effort keep-alive → defer host-side idle auto-suspend + renew lease. */
  async touch(projectId: string): Promise<void> {
    const hostId = this.projectHost.get(projectId)
    if (!hostId) return
    const host = this.hosts.get(hostId)
    if (!host) return
    // Keep the fencing lease alive while the project is actively used; when the
    // user goes idle and the host suspends, we stop renewing and it expires.
    void this.registry.renewLease(projectId, this.holderId).catch(() => {})
    try {
      await this.fetchImpl(`http://${host.meshIp}:${host.agentPort}/touch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      /* best-effort */
    }
  }

  getStatus() {
    const live = this.liveHosts()
    const resumedPlusCold = this.stats.resumed + this.stats.coldMiss
    return {
      hosts: {
        total: this.hosts.size,
        live: live.length,
        detail: [...this.hosts.values()].map((h) => ({
          hostId: h.hostId,
          region: h.region,
          arch: h.arch,
          meshIp: h.meshIp,
          agentPort: h.agentPort,
          capacity: h.capacity,
          load: h.load,
          disk: h.disk,
          live: h.lastSeenAt >= this.now() - HOST_TTL_MS,
          overWatermark: overWatermark(h),
          lastSeenMsAgo: this.now() - h.lastSeenAt,
        })),
      },
      projects: this.projectHost.size,
      stats: {
        ...this.stats,
        // Snapshot hit-rate: fraction of resolutions served by a resume vs a
        // cold claim. The headline "sleep/wake" effectiveness number.
        snapshotHitRate: resumedPlusCold > 0 ? +(this.stats.resumed / resumedPlusCold).toFixed(3) : null,
      },
      config: { hostTtlMs: HOST_TTL_MS, assignTimeoutMs: ASSIGN_TIMEOUT_MS },
    }
  }
}

/** assigned/poolSize load ratio; unknown capacity sorts last. */
function loadRatio(h: HostEntry): number {
  const cap = h.capacity?.poolSize || 0
  if (cap <= 0) return Number.POSITIVE_INFINITY
  return (h.load?.assigned ?? 0) / cap
}

/** True if the host is at/over the disk high-watermark (GC is shedding). */
function overWatermark(h: HostEntry): boolean {
  return typeof h.disk?.usedPct === 'number' && h.disk.usedPct >= DISK_HIGH_PCT
}

// --- singleton ---------------------------------------------------------------

let controller: MetalWarmPoolController | null = null

export function getMetalWarmPoolController(): MetalWarmPoolController {
  if (!controller) controller = new MetalWarmPoolController()
  return controller
}

/** Test-only: replace the singleton with an injected instance. */
export function _setMetalWarmPoolController(c: MetalWarmPoolController | null): void {
  controller = c
}

export function registerMetalHost(reg: MetalHostRegistration): void {
  getMetalWarmPoolController().registerHost(reg)
}

export async function getMetalProjectUrl(projectId: string): Promise<string> {
  return getMetalWarmPoolController().getMetalProjectUrl(projectId)
}

// Eligibility gating lives in the dependency-free metal-eligibility module so
// resolveProjectPodUrl can probe it cheaply. Re-exported here for convenience.
export { isMetalEnabled, isMetalEligibleProject } from './metal-eligibility'
