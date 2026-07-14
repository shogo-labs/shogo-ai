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
import { buildProjectEnv, buildPublishedProjectEnv } from './runtime/build-project-env'
import { getMetalPlacementRegistry, type HostScalars, type MetalPlacementRegistry } from './metal-placement-registry'

/**
 * The controller keys every runtime by an opaque string. A dev/preview runtime
 * uses the bare `projectId`; a LIVE published site uses a distinct
 * `published:{projectId}` key so its always-on, published-mode microVM never
 * collides with the same project's editing VM (different env, different
 * snapshot). Keep this the single source of the convention.
 */
export function publishedRuntimeKey(projectId: string): string {
  return `published:${projectId}`
}

const tracer = trace.getTracer('shogo-metal-pool')
const meter = metrics.getMeter('shogo-metal-pool')

const assignmentsCounter = meter.createCounter('metal.assignments', {
  description: 'Metal /assign resolutions, labelled by mode (assigned|resumed) and source (local|store|none)',
})
const coldMissCounter = meter.createCounter('metal.cold_miss', {
  description: 'Metal assigns that were a fresh claim (no snapshot to resume) — the cold-start denominator for hit-rate',
})
const reusedCounter = meter.createCounter('metal.reused', {
  description: 'Metal /assign resolutions that re-attached an ALREADY-RUNNING VM (no boot, no resume) — a warm hit, NOT a cold miss',
})
const urlCacheHitCounter = meter.createCounter('metal.url_cache_hit', {
  description: 'getMetalProjectUrl calls served from the short-TTL resolved-URL cache without calling the host /assign',
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

// --- Per-host fleet gauges (SigNoz) ------------------------------------------
// The counters above cover the ROUTER path (assign/wake/errors). These observable
// gauges surface the live STATE of each metal host from its heartbeat — warm-pool
// depth, in-use VMs, disk pressure, and (critically) the live firecracker-process
// count so a recurrence of the churn leak is caught fleet-wide instead of by SSH.
// Every gauge is labelled by {host_id, region, arch}. Heartbeats round-robin
// across API replicas, so a host may be observed by more than one replica within
// its TTL — dashboards/alerts should aggregate with `max by (host_id)`.
const hostUpGauge = meter.createObservableGauge('metal.host.up', {
  description: '1 while a metal host has heartbeat within TTL (absent series = host gone)',
})
const hostAvailableGauge = meter.createObservableGauge('metal.host.available', {
  description: 'Warm (idle, ready) microVMs on a metal host',
})
const hostAssignedGauge = meter.createObservableGauge('metal.host.assigned', {
  description: 'Assigned (in-use) microVMs on a metal host',
})
const hostSuspendedGauge = meter.createObservableGauge('metal.host.suspended', {
  description: 'Suspended (snapshotted) projects cached on a metal host',
})
const hostFcProcsGauge = meter.createObservableGauge('metal.host.fc_procs', {
  description: 'Live firecracker processes on a metal host — should track available+assigned; a growing gap is the churn process-leak fingerprint',
})
const hostPoolSizeGauge = meter.createObservableGauge('metal.host.pool_size', {
  description: 'Configured WARM-POOL target on a metal host (idle pre-booted VMs; NOT total capacity)',
})
const hostUtilGauge = meter.createObservableGauge('metal.host.util_pct', {
  description: 'assigned/MAX_VMS_PER_HOST utilization percent on a metal host (burst scale-up trigger basis)',
})
const hostDiskUsedGauge = meter.createObservableGauge('metal.host.disk_used_pct', {
  description: 'NVMe cache disk used percent on a metal host',
})
const hostDiskFreeGauge = meter.createObservableGauge('metal.host.disk_free_bytes', {
  description: 'NVMe free bytes on a metal host',
  unit: 'By',
})
const hostCacheCountGauge = meter.createObservableGauge('metal.host.cache_local_count', {
  description: 'Locally cached suspended-project snapshots on a metal host',
})
// Assigned-set decomposition by liveness class (see MetalHostRegistration.load.
// liveness). These sum to metal.host.assigned and answer "of the N running VMs,
// how many have real users vs an agent turn vs are just in the idle tail" — the
// signal that separates true demand from open-tab churn. Absent on old agents /
// pre-rootfs-rebuild guests, so a missing series means "not reporting yet".
const hostAppActiveGauge = meter.createObservableGauge('metal.host.app_active', {
  description: 'Assigned microVMs serving end-user APP traffic (/api/*) within the activity window',
})
const hostAgentActiveGauge = meter.createObservableGauge('metal.host.agent_active', {
  description: 'Assigned microVMs with an AGENT chat turn in flight at the last activity poll',
})
const hostIdleTailGauge = meter.createObservableGauge('metal.host.idle_tail', {
  description: 'Assigned microVMs that are running but neither used nor mid-turn — the idle-suspend tail',
})

let fleetGaugesRegistered = false

/**
 * Register the batch callback that feeds the per-host fleet gauges from the
 * live heartbeat view. Idempotent (guarded) and lazy — called from
 * registerMetalHost so it only wires up in a process that actually receives
 * heartbeats (never during unit tests that new-up their own controller). The
 * callback reads the CURRENT singleton each collection, so it tracks whatever
 * controller is live.
 */
function ensureFleetGauges(): void {
  if (fleetGaugesRegistered) return
  fleetGaugesRegistered = true
  meter.addBatchObservableCallback(
    (obs) => {
      const c = getMetalWarmPoolController()
      for (const h of c.liveHosts()) {
        const attrs = { host_id: h.hostId, region: h.region, arch: h.arch }
        obs.observe(hostUpGauge, 1, attrs)
        obs.observe(hostAvailableGauge, h.load?.available ?? 0, attrs)
        obs.observe(hostAssignedGauge, h.load?.assigned ?? 0, attrs)
        obs.observe(hostSuspendedGauge, h.load?.suspended ?? 0, attrs)
        if (typeof h.load?.fcProcs === 'number') obs.observe(hostFcProcsGauge, h.load.fcProcs, attrs)
        obs.observe(hostPoolSizeGauge, h.capacity?.poolSize ?? 0, attrs)
        obs.observe(hostUtilGauge, utilizationPct(h), attrs)
        if (h.disk) {
          obs.observe(hostDiskUsedGauge, h.disk.usedPct, attrs)
          obs.observe(hostDiskFreeGauge, h.disk.freeBytes, attrs)
          obs.observe(hostCacheCountGauge, h.disk.localCount, attrs)
        }
        // Only emit the liveness decomposition when the host actually reported
        // it — a zero would otherwise be indistinguishable from "old agent not
        // reporting", masking rollout progress on the dashboard.
        if (h.load?.liveness) {
          obs.observe(hostAppActiveGauge, h.load.liveness.appActive, attrs)
          obs.observe(hostAgentActiveGauge, h.load.liveness.agentActive, attrs)
          obs.observe(hostIdleTailGauge, h.load.liveness.idleTail, attrs)
        }
      }
    },
    [
      hostUpGauge,
      hostAvailableGauge,
      hostAssignedGauge,
      hostSuspendedGauge,
      hostFcProcsGauge,
      hostPoolSizeGauge,
      hostUtilGauge,
      hostDiskUsedGauge,
      hostDiskFreeGauge,
      hostCacheCountGauge,
      hostAppActiveGauge,
      hostAgentActiveGauge,
      hostIdleTailGauge,
    ],
  )
}

/** Registration payload a node-agent POSTs on its heartbeat (see register.ts). */
export interface MetalHostRegistration {
  hostId: string
  meshIp: string
  agentPort: number
  region: string
  arch: string
  capacity: { poolSize: number; memMiB: number; vcpus: number }
  load: {
    available: number
    assigned: number
    suspended: number
    /** Live firecracker processes on the host. Absent on older agents. A gap
     * above available+assigned is the churn process-leak fingerprint. */
    fcProcs?: number
    /**
     * Assigned (running) set decomposed by WHY each VM is live, so a raw
     * `assigned` count can be read as app-users + agent-turns + idle-tail:
     *   appActive   — served end-user app traffic (/api/*) recently
     *   agentActive — an agent chat turn was in flight at the last poll
     *   idleTail    — running but neither used nor mid-turn (idle-suspend tail)
     * The three buckets are disjoint and sum to `assigned`. Absent on older
     * agents (pre this build) and on guests still running the old rootfs (they
     * report no per-class activity, so the agent buckets them as idleTail).
     */
    liveness?: { appActive: number; agentActive: number; idleTail: number }
  }
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
/**
 * Schedulable microVM slots per metal host — the REAL capacity denominator for
 * utilization. An s3-large-x86 box (24c / 512 GB) comfortably runs ~80
 * concurrent ~1 GB microVMs.
 *
 * This is deliberately NOT `capacity.poolSize`, which is only the WARM-POOL
 * target (the agent's METAL_POOL_SIZE, default 1 — how many idle VMs it keeps
 * pre-booted). Dividing the count of LIVE `assigned` projects by the warm-pool
 * size made a host running a dozen projects report >100% "utilization" and
 * falsely trip burst scale-up (e.g. 13 assigned / poolSize 4 = 325%). Utilization
 * is `assigned / MAX_VMS_PER_HOST`. Override with METAL_MAX_VMS_PER_HOST.
 */
export const MAX_VMS_PER_HOST = Math.max(1, parseInt(process.env.METAL_MAX_VMS_PER_HOST || '80', 10))
/**
 * How long a resolved (projectId → runtime URL) mapping stays cached before the
 * next resolve re-hits the host's /assign. A project's URL is stable while it's
 * running (mesh IP + persisted DNAT port survive even an agent rolling restart,
 * which re-adopts the VM), so serving repeat proxy/preview/chat requests from
 * this cache eliminates the churn of re-`/assign`-ing an already-running VM on
 * every request (the source of the inflated cold-miss metric and needless
 * agent/Redis load). Kept short so a suspend/migrate is picked up quickly; a
 * stale hit just fails the proxy once and re-resolves. `<= 0` disables caching.
 *
 * SAFE vs idle-suspend: the host tracks idleness from REAL guest traffic (the
 * activity poll over DNAT), NOT from control-plane /assign calls — so skipping
 * /assign here never causes an actively-served project to be suspended.
 */
const URL_CACHE_TTL_MS = parseInt(process.env.METAL_URL_CACHE_TTL_MS || '15000', 10)

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
  /**
   * True when `mode:'assigned'` re-attached a VM that was ALREADY RUNNING on the
   * host (the agent's `live` fast-path) rather than a fresh cold claim. Lets the
   * controller record a warm hit instead of a cold miss for repeat resolves.
   */
  reused?: boolean
}

/** A cached resolution of a project to its runtime URL (see URL_CACHE_TTL_MS). */
interface UrlCacheEntry {
  url: string
  hostId: string
  expiresAt: number
}

/** Outcome of a stop (suspend-to-snapshot) request. */
export interface StopResult {
  /** The project was actually suspended (or was already stopped). */
  suspended: boolean
  /** The node-agent refused because the project has an active agent message. */
  busy: boolean
}

type EnvBuilder = (
  projectId: string,
  opts?: { logPrefix?: string; forMetal?: boolean },
) => Promise<Record<string, string>>
type PublishedEnvBuilder = (
  projectId: string,
  subdomain: string,
  opts?: { alwaysOn?: boolean },
) => Promise<Record<string, string>>
type FetchImpl = typeof fetch

export class MetalWarmPoolController {
  private hosts = new Map<string, HostEntry>()
  /** projectId → hostId. Sticky so a project returns to the host holding its snapshot. */
  private projectHost = new Map<string, string>()
  private pending = new Map<string, Promise<string>>()
  /** projectId → resolved runtime URL, short-lived (URL_CACHE_TTL_MS). Skips the
   * host /assign for repeat requests to an already-running project. */
  private urlCache = new Map<string, UrlCacheEntry>()
  private stats = { assigned: 0, resumed: 0, reused: 0, coldMiss: 0, cacheHit: 0, hostErrors: 0, noHost: 0 }
  /** Cordoned hostIds (admin drain) — excluded from NEW placements. Synced from
   * the shared registry on each resolve so every API replica honors a cordon. */
  private cordoned = new Set<string>()

  /** Stable per-process lease holder token (distinct per API replica). */
  private holderId = `metal-cp-${process.env.HOSTNAME || crypto.randomUUID()}`

  constructor(
    private envBuilder: EnvBuilder = buildProjectEnv,
    private fetchImpl: FetchImpl = fetch,
    private now: () => number = Date.now,
    private registry: MetalPlacementRegistry = getMetalPlacementRegistry(),
    private publishedEnvBuilder: PublishedEnvBuilder = buildPublishedProjectEnv,
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

  /** Hosts this replica has heard heartbeat from within HOST_TTL_MS. */
  liveHosts(): HostEntry[] {
    const cutoff = this.now() - HOST_TTL_MS
    return [...this.hosts.values()].filter((h) => h.lastSeenAt >= cutoff)
  }

  /**
   * Live hosts across the WHOLE fleet, merging this replica's in-memory view
   * with the shared registry (Redis). This is essential in multi-replica
   * deployments: a node-agent's heartbeat lands on ONE api pod per interval
   * (LB round-robin), so a pod that hasn't personally received a heartbeat
   * within HOST_TTL_MS would otherwise see zero hosts and — in metal-only mode
   * — 503 every project. The registry TTL (also HOST_TTL_MS) keeps the shared
   * view fresh; on a Redis blip we degrade to the in-memory view. Local entries
   * win on conflict (they carry the freshest load numbers this pod has seen).
   */
  async liveHostsShared(): Promise<HostEntry[]> {
    const local = this.liveHosts()
    let shared: HostScalars[] = []
    try {
      shared = await this.registry.listHosts()
    } catch {
      return local
    }
    const byId = new Map<string, HostEntry>()
    for (const s of shared) {
      // registry rows are already TTL-pruned; treat lastSeenAt as authoritative.
      byId.set(s.hostId, { ...s, registeredAt: s.lastSeenAt })
    }
    // Local view overrides (fresher load/disk from this pod's own heartbeats).
    for (const h of local) byId.set(h.hostId, h)
    // Refresh the cordon set (best-effort) so candidate selection below and any
    // sibling replica's admin cordon are honored without a restart.
    try {
      this.cordoned = new Set(await this.registry.listCordoned())
    } catch {
      /* keep last-known cordon set on a registry blip */
    }
    return [...byId.values()]
  }

  /** Fleet-wide live host count (registry-aware) for readiness checks. */
  async liveHostCount(): Promise<number> {
    return (await this.liveHostsShared()).length
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
  private candidates(projectId: string, placedHostId: string | undefined, live: HostEntry[]): HostEntry[] {
    // Cordoned hosts drain: they keep serving live projects but take no NEW
    // placements, so a project on a cordoned host re-places elsewhere on wake.
    const eligible = live.filter((h) => !this.cordoned.has(h.hostId))
    const preferId = placedHostId ?? this.projectHost.get(projectId)
    const preferred = preferId ? eligible.find((h) => h.hostId === preferId) : undefined
    const rest = eligible
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
    return this.resolveRuntime(projectId, () => this.envBuilder(projectId, { forMetal: true }))
  }

  /**
   * Resolve ANY runtime key (a bare projectId for dev/preview, or
   * `published:{id}` for a live site) to a mesh-routable URL. Shares the whole
   * hot path — URL cache, singleflight, lease, placement, sticky candidate
   * ordering — so a published microVM gets the same anti-split-brain + cache-
   * aware routing as a preview VM. `buildEnv` supplies the assign env lazily
   * (only built once the lease is held / a host is available).
   */
  private async resolveRuntime(runtimeKey: string, buildEnv: () => Promise<Record<string, string>>): Promise<string> {
    // Fast path: an already-resolved, still-running runtime returns its cached
    // URL without touching the host — killing the per-request /assign churn that
    // a client polling loop (e.g. a stuck preview iframe) would otherwise create.
    const cached = this.getCachedUrl(runtimeKey)
    if (cached) {
      this.stats.cacheHit++
      urlCacheHitCounter.add(1)
      return cached
    }
    const inflight = this.pending.get(runtimeKey)
    if (inflight) return inflight
    const p = this._resolve(runtimeKey, buildEnv).finally(() => this.pending.delete(runtimeKey))
    this.pending.set(runtimeKey, p)
    return p
  }

  /** Live cached URL for a project, or undefined if absent/expired/disabled. */
  private getCachedUrl(projectId: string): string | undefined {
    if (URL_CACHE_TTL_MS <= 0) return undefined
    const e = this.urlCache.get(projectId)
    if (!e) return undefined
    if (this.now() >= e.expiresAt) {
      this.urlCache.delete(projectId)
      return undefined
    }
    return e.url
  }

  /**
   * Drop a project's cached URL so the next resolve re-hits the host. Call
   * whenever the runtime may have moved or gone away: assign failure, suspend
   * (/stop), or destroy. Public so routes that knowingly change a project's
   * placement (e.g. an admin move) can force a fresh resolve.
   */
  invalidateUrlCache(projectId: string): void {
    this.urlCache.delete(projectId)
  }

  private async _resolve(projectId: string, buildEnv: () => Promise<Record<string, string>>): Promise<string> {
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

        const cands = this.candidates(projectId, placedHostId, await this.liveHostsShared())
        if (cands.length === 0) {
          if (gotLease) void this.registry.releaseLease(projectId, this.holderId).catch(() => {})
          this.stats.noHost++
          noHostCounter.add(1)
          span.setAttribute('resolve.method', 'no_host')
          throw new NoMetalHostError()
        }

        // forMetal: the guest runs outside OKE and must reach the AI proxy /
        // Shogo API over the PUBLIC URL (in-cluster DNS is unresolvable there).
        const env = await buildEnv()
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
            span.setAttribute(
              'resolve.method',
              mode === 'resumed' ? `resumed_${source}` : res.reused ? 'reused' : 'assigned',
            )
            if (mode === 'resumed') {
              this.stats.resumed++
              if (typeof res.readyMs === 'number') {
                wakeLatency.record(res.readyMs, { source })
                span.setAttribute('resolve.wake_ms', res.readyMs)
              }
            } else if (res.reused) {
              // Already-running VM re-attached (agent `live` fast-path). Not a
              // cold boot — record a warm hit so it doesn't pollute cold-miss.
              this.stats.reused++
              reusedCounter.add(1)
            } else {
              this.stats.assigned++
              this.stats.coldMiss++
              coldMissCounter.add(1)
            }
            // Cache the resolution so repeat requests skip /assign entirely.
            if (URL_CACHE_TTL_MS > 0) {
              this.urlCache.set(projectId, {
                url: res.url,
                hostId: host.hostId,
                expiresAt: this.now() + URL_CACHE_TTL_MS,
              })
            }
            span.setStatus({ code: SpanStatusCode.OK })
            return res.url
          } catch (err) {
            lastErr = err
            this.stats.hostErrors++
            hostErrorCounter.add(1, { host: host.hostId })
            // Drop stickiness/placement/cache so we don't keep hammering a dead host.
            if (this.projectHost.get(projectId) === host.hostId) this.projectHost.delete(projectId)
            this.urlCache.delete(projectId)
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

  /** Bearer-over-mesh headers for node-agent control calls. */
  private agentHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(process.env.METAL_REGISTER_TOKEN ? { Authorization: `Bearer ${process.env.METAL_REGISTER_TOKEN}` } : {}),
    }
  }

  /**
   * The live host currently holding a project — its sticky placement. Prefers
   * this replica's in-memory stickiness, then the shared placement registry (the
   * project may be placed on a host this replica hasn't personally heard from).
   * Returns undefined when the project isn't placed anywhere live.
   */
  private async hostForProject(projectId: string): Promise<HostEntry | undefined> {
    const localId = this.projectHost.get(projectId)
    if (localId) {
      const h = this.hosts.get(localId)
      if (h && h.lastSeenAt >= this.now() - HOST_TTL_MS) return h
    }
    const placed = await this.registry.getPlacement(projectId).catch(() => null)
    const placedId = placed?.hostId ?? localId
    if (placedId) {
      const live = await this.liveHostsShared()
      const liveHit = live.find((h) => h.hostId === placedId)
      if (liveHit) return liveHit
      // Transiently-stale owner: the host is outside the live TTL window right now
      // (a missed heartbeat under load) but we still know where it lives. Fall back
      // to the last-known in-memory entry so a delete/stop/status racing that lapse
      // still reaches the REAL owner instead of silently treating it as gone — the
      // difference between a clean teardown and a leaked snapshot.
      return this.hosts.get(placedId)
    }
    return undefined
  }

  /**
   * Project-scoped runtime status (exists/ready/replicas) — the metal analog of
   * KnativeProjectManager.getStatus, powering the substrate `getStatus()`. Reads
   * the host holding the project; a project placed nowhere live reports absent.
   */
  async getProjectStatus(projectId: string): Promise<{ exists: boolean; ready: boolean; replicas: number; url?: string }> {
    const host = await this.hostForProject(projectId)
    if (!host) return { exists: false, ready: false, replicas: 0 }
    try {
      const res = await this.fetchImpl(`http://${host.meshIp}:${host.agentPort}/status`, {
        method: 'POST',
        headers: this.agentHeaders(),
        body: JSON.stringify({ projectId }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return { exists: false, ready: false, replicas: 0 }
      const b = (await res.json()) as { exists?: boolean; ready?: boolean; replicas?: number; url?: string }
      return { exists: !!b.exists, ready: !!b.ready, replicas: b.replicas ?? 0, url: b.url }
    } catch {
      return { exists: false, ready: false, replicas: 0 }
    }
  }

  /**
   * Stop a project (suspend-to-snapshot, freeing host RAM) — the metal analog of
   * scaling a Knative service to zero. Best-effort and idempotent: no live
   * placement, a down host, or an already-stopped project are all no-ops.
   *
   * Returns whether the project was actually suspended. The node-agent refuses
   * to suspend a project mid-generation (an active agent message) and reports
   * `busy` instead; callers (the per-user open-cap enforcer) use this to leave a
   * busy project running and retry later rather than killing its live turn.
   */
  async stopProject(projectId: string): Promise<StopResult> {
    // A stop suspends the VM (URL goes away) — drop the cached URL up front so a
    // racing resolve can't hand back a soon-to-be-dead endpoint.
    this.urlCache.delete(projectId)
    const host = await this.hostForProject(projectId)
    if (!host) return { suspended: false, busy: false }
    try {
      const res = await this.fetchImpl(`http://${host.meshIp}:${host.agentPort}/stop`, {
        method: 'POST',
        headers: this.agentHeaders(),
        body: JSON.stringify({ projectId }),
        signal: AbortSignal.timeout(ASSIGN_TIMEOUT_MS),
      })
      const body: any = await res.json().catch(() => ({}))
      const busy = body?.busy === true
      // Only treat it as suspended when the agent confirms it (fresh suspend or
      // already-stopped). A busy/ambiguous reply → not suspended.
      const suspended = body?.suspended === true || body?.alreadyStopped === true
      if (busy) {
        console.log(`[MetalPool] stop ${projectId} on ${host.hostId} skipped: busy (active message)`)
      }
      return { suspended, busy }
    } catch (err) {
      console.warn(`[MetalPool] stop ${projectId} on ${host.hostId} failed: ${(err as any)?.message ?? err}`)
      return { suspended: false, busy: false }
    }
  }

  /**
   * Apply an instance-tier change to a project — the metal analog of
   * KnativeProjectManager.patchProjectResources. Firecracker can't hot-resize
   * vCPU/RAM, so those take effect on the project's next cold boot/resume (the
   * assign env, derived from the tier, is re-read then). What we push LIVE to the
   * owning host is the always-on flag (paid tier ⇄ free) so an upgrade stops the
   * idle reaper immediately and a downgrade re-arms it. Best-effort + idempotent:
   * a project placed nowhere live is a no-op (its next boot picks up the tier).
   */
  async resizeProject(
    projectId: string,
    resources: { cpu?: string; memory?: string; disk?: string; minScale?: number },
  ): Promise<void> {
    const host = await this.hostForProject(projectId)
    if (!host) return
    const alwaysOn = (resources.minScale ?? 0) >= 1
    await this.fetchImpl(`http://${host.meshIp}:${host.agentPort}/resize`, {
      method: 'POST',
      headers: this.agentHeaders(),
      body: JSON.stringify({ projectId, alwaysOn }),
      signal: AbortSignal.timeout(ASSIGN_TIMEOUT_MS),
    }).catch((err) => console.warn(`[MetalPool] resize ${projectId} on ${host.hostId} failed: ${(err as any)?.message ?? err}`))
  }

  /**
   * Permanently destroy a project's runtime everywhere on the fleet — the metal
   * analog of KnativeProjectManager.deleteProject. Fans out to EVERY live host
   * (not just the current placement): after a failover a stale local/durable
   * snapshot can linger on another host, and a project delete must leak nothing.
   *
   * Crucially it ALSO targets the project's own placement host even when that
   * host has briefly dropped out of the live TTL window (via hostForProject's
   * stale fallback). A delete very often races exactly such a lapse — a busy box
   * missing a heartbeat right as its project is deleted — and destroying only the
   * *live* set there silently leaves the snapshot behind forever (observed on
   * staging: the delete ran, but only Knative teardown fired and the metal
   * snapshot leaked until GC). Also clears routing/placement/lease. Best-effort.
   */
  async destroyProject(projectId: string): Promise<void> {
    const targets = new Map<string, HostEntry>()
    for (const h of await this.liveHostsShared()) targets.set(h.hostId, h)
    const owner = await this.hostForProject(projectId)
    if (owner) targets.set(owner.hostId, owner)

    await Promise.all(
      [...targets.values()].map((h) =>
        this.fetchImpl(`http://${h.meshIp}:${h.agentPort}/destroy`, {
          method: 'POST',
          headers: this.agentHeaders(),
          body: JSON.stringify({ projectId }),
          signal: AbortSignal.timeout(ASSIGN_TIMEOUT_MS),
        }).catch((err) => console.warn(`[MetalPool] destroy ${projectId} on ${h.hostId} failed: ${(err as any)?.message ?? err}`)),
      ),
    )
    this.projectHost.delete(projectId)
    this.urlCache.delete(projectId)
    await this.registry.clearPlacement(projectId).catch(() => {})
    await this.registry.releaseLease(projectId, this.holderId).catch(() => {})
  }

  /**
   * Every project running or cached on the fleet — the metal analog of
   * KnativeProjectManager.listAllServices, for the admin panel + infra metrics.
   * Queries each live host's /vms; a down host is skipped rather than failing.
   */
  async listProjects(): Promise<Array<{ projectId: string; ready: boolean; url?: string; host?: string; region?: string }>> {
    const hosts = await this.liveHostsShared()
    const out: Array<{ projectId: string; ready: boolean; url?: string; host?: string; region?: string }> = []
    await Promise.all(
      hosts.map(async (h) => {
        try {
          const res = await this.fetchImpl(`http://${h.meshIp}:${h.agentPort}/vms`, {
            headers: this.agentHeaders(),
            signal: AbortSignal.timeout(5000),
          })
          if (!res.ok) return
          const b = (await res.json()) as {
            assigned?: Array<{ projectId: string; url?: string }>
            suspended?: Array<{ projectId: string }>
          }
          for (const a of b.assigned ?? []) out.push({ projectId: a.projectId, ready: true, url: a.url, host: h.hostId, region: h.region })
          for (const s of b.suspended ?? []) out.push({ projectId: s.projectId, ready: false, host: h.hostId, region: h.region })
        } catch {
          /* skip a host that didn't answer */
        }
      }),
    )
    return out
  }

  private async assignOnHost(host: HostEntry, projectId: string, env: Record<string, string>): Promise<AssignResult> {
    const base = `http://${host.meshIp}:${host.agentPort}`
    const res = await this.fetchImpl(`${base}/assign`, {
      method: 'POST',
      headers: this.agentHeaders(),
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

  // --- published site runtime (published:{id} key) -------------------------
  // A server-backed published app runs as its OWN always-on microVM, distinct
  // from the project's editing VM. These wrap the generic runtime lifecycle with
  // the `published:{id}` key + published-mode env, and mirror the subdomain →
  // placement into the registry so the API `/api/published` proxy + wake can
  // route the edge's `/api/*` to the live box.

  /**
   * Resolve (waking/booting if needed) the live published microVM for a project
   * and publish its subdomain placement. Throws (NoMetalHostError / assign
   * failure) exactly like getMetalProjectUrl so the substrate can surface a
   * retryable state.
   */
  async getMetalPublishedUrl(
    projectId: string,
    subdomain: string,
    opts?: { alwaysOn?: boolean },
  ): Promise<{ url: string; hostId?: string; region?: string }> {
    const key = publishedRuntimeKey(projectId)
    const url = await this.resolveRuntime(key, () => this.publishedEnvBuilder(projectId, subdomain, opts))
    const hostId = this.projectHost.get(key)
    const host = hostId ? this.hosts.get(hostId) : undefined
    await this.registry
      .setPublishedPlacement(subdomain, {
        projectId,
        hostId: hostId ?? '',
        region: host?.region ?? '',
        alwaysOn: !!opts?.alwaysOn,
      })
      .catch(() => {})
    return { url, hostId, region: host?.region }
  }

  /** Runtime status of a project's published microVM (substrate.getStatus). */
  async getPublishedStatus(projectId: string) {
    return this.getProjectStatus(publishedRuntimeKey(projectId))
  }

  /** Suspend a published microVM (allowed only when not always-on). */
  async stopPublished(projectId: string): Promise<StopResult> {
    return this.stopProject(publishedRuntimeKey(projectId))
  }

  /**
   * Permanently tear down a project's published microVM fleet-wide and clear its
   * subdomain placement. Best-effort + idempotent (used on unpublish/delete).
   */
  async destroyPublished(projectId: string, subdomain?: string): Promise<void> {
    await this.destroyProject(publishedRuntimeKey(projectId))
    if (subdomain) await this.registry.clearPublishedPlacement(subdomain).catch(() => {})
  }

  /**
   * Push the always-on flag to a running published microVM's host (live) so an
   * enable stops the idle reaper immediately and a disable re-arms it. The new
   * flag also lands in the env on the next cold boot/resume. Refreshes the
   * subdomain placement's alwaysOn marker. Best-effort.
   */
  async setPublishedAlwaysOn(projectId: string, subdomain: string, on: boolean): Promise<void> {
    await this.resizeProject(publishedRuntimeKey(projectId), { minScale: on ? 1 : 0 })
    const existing = await this.registry.getPublishedPlacement(subdomain).catch(() => null)
    if (existing) {
      await this.registry
        .setPublishedPlacement(subdomain, {
          projectId: existing.projectId,
          hostId: existing.hostId,
          region: existing.region,
          alwaysOn: on,
        })
        .catch(() => {})
    }
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
    const warmTotal = this.stats.resumed + this.stats.reused + this.stats.cacheHit
    const warmPlusCold = warmTotal + this.stats.coldMiss
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
          cordoned: this.cordoned.has(h.hostId),
          lastSeenMsAgo: this.now() - h.lastSeenAt,
        })),
      },
      projects: this.projectHost.size,
      stats: {
        ...this.stats,
        // Snapshot hit-rate: fraction of resolutions served by a snapshot resume
        // vs a cold claim. The headline "sleep/wake" effectiveness number.
        snapshotHitRate: resumedPlusCold > 0 ? +(this.stats.resumed / resumedPlusCold).toFixed(3) : null,
        // Warm hit-rate: fraction of resolutions that avoided a cold boot
        // altogether — a resume, an already-running reuse, or a URL-cache hit.
        warmHitRate: warmPlusCold > 0 ? +(warmTotal / warmPlusCold).toFixed(3) : null,
      },
      config: { hostTtlMs: HOST_TTL_MS, assignTimeoutMs: ASSIGN_TIMEOUT_MS, urlCacheTtlMs: URL_CACHE_TTL_MS },
    }
  }

  /**
   * Fleet status merged across all API replicas (registry-aware) for the
   * super-admin panel. Unlike getStatus() (this replica's in-memory view only),
   * this reflects every live host any replica has heard from, plus cordon state.
   */
  async getFleetStatus() {
    const live = await this.liveHostsShared() // also refreshes this.cordoned
    const cordoned = this.cordoned
    const resumedPlusCold = this.stats.resumed + this.stats.coldMiss
    const warmTotal = this.stats.resumed + this.stats.reused + this.stats.cacheHit
    const warmPlusCold = warmTotal + this.stats.coldMiss
    return {
      hosts: live
        .map((h) => ({
          hostId: h.hostId,
          region: h.region,
          arch: h.arch,
          meshIp: h.meshIp,
          agentPort: h.agentPort,
          capacity: h.capacity,
          load: h.load,
          disk: h.disk,
          live: true,
          overWatermark: overWatermark(h),
          cordoned: cordoned.has(h.hostId),
          utilPct: utilizationPct(h),
        }))
        .sort((a, b) => a.region.localeCompare(b.region) || a.hostId.localeCompare(b.hostId)),
      stats: {
        ...this.stats,
        snapshotHitRate: resumedPlusCold > 0 ? +(this.stats.resumed / resumedPlusCold).toFixed(3) : null,
        warmHitRate: warmPlusCold > 0 ? +(warmTotal / warmPlusCold).toFixed(3) : null,
      },
      config: { hostTtlMs: HOST_TTL_MS, assignTimeoutMs: ASSIGN_TIMEOUT_MS, diskHighPct: DISK_HIGH_PCT, urlCacheTtlMs: URL_CACHE_TTL_MS },
    }
  }

  /** Cordon (drain) or uncordon a host. Shared so all replicas honor it. */
  async setHostCordon(hostId: string, cordoned: boolean): Promise<void> {
    if (cordoned) this.cordoned.add(hostId)
    else this.cordoned.delete(hostId)
    await this.registry.setCordon(hostId, cordoned).catch(() => {})
  }
}

/** assigned/capacity load ratio (0 = idle). Used only to order hosts
 * lightest-first for NEW placements; with a flat per-host capacity this ranks by
 * absolute assigned count, so an empty host is preferred. */
function loadRatio(h: HostEntry): number {
  return (h.load?.assigned ?? 0) / MAX_VMS_PER_HOST
}

/** True if the host is at/over the disk high-watermark (GC is shedding). */
function overWatermark(h: HostEntry): boolean {
  return typeof h.disk?.usedPct === 'number' && h.disk.usedPct >= DISK_HIGH_PCT
}

/** assigned/MAX_VMS_PER_HOST as a whole-number percent. */
function utilizationPct(h: HostEntry): number {
  return Math.round(((h.load?.assigned ?? 0) / MAX_VMS_PER_HOST) * 100)
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
  ensureFleetGauges()
  getMetalWarmPoolController().registerHost(reg)
}

export async function getMetalProjectUrl(projectId: string): Promise<string> {
  return getMetalWarmPoolController().getMetalProjectUrl(projectId)
}

/** Project-scoped runtime status on metal (substrate.getStatus). */
export async function getMetalProjectStatus(projectId: string) {
  return getMetalWarmPoolController().getProjectStatus(projectId)
}

/** Suspend a project on metal, freeing host RAM (substrate.stop). */
export async function stopMetalProject(projectId: string): Promise<StopResult> {
  return getMetalWarmPoolController().stopProject(projectId)
}

/** Permanently destroy a project's metal runtime fleet-wide (substrate.destroy). */
export async function destroyMetalProject(projectId: string): Promise<void> {
  return getMetalWarmPoolController().destroyProject(projectId)
}

/** Every project running/cached on the metal fleet (substrate.listAll). */
export async function listMetalProjects() {
  return getMetalWarmPoolController().listProjects()
}

/** Resolve + wake a project's live published microVM (substrate.publish/wake). */
export async function getMetalPublishedUrl(
  projectId: string,
  subdomain: string,
  opts?: { alwaysOn?: boolean },
) {
  return getMetalWarmPoolController().getMetalPublishedUrl(projectId, subdomain, opts)
}

/** Status of a project's published microVM. */
export async function getMetalPublishedStatus(projectId: string) {
  return getMetalWarmPoolController().getPublishedStatus(projectId)
}

/** Tear down a project's published microVM + subdomain placement (unpublish). */
export async function destroyMetalPublished(projectId: string, subdomain?: string): Promise<void> {
  return getMetalWarmPoolController().destroyPublished(projectId, subdomain)
}

/** Flip a project's published microVM always-on state. */
export async function setMetalPublishedAlwaysOn(projectId: string, subdomain: string, on: boolean): Promise<void> {
  return getMetalWarmPoolController().setPublishedAlwaysOn(projectId, subdomain, on)
}

/** Registry-aware fleet status for the super-admin panel (all replicas). */
export async function getMetalFleetStatus() {
  return getMetalWarmPoolController().getFleetStatus()
}

/** Cordon (drain) or uncordon a metal host from the super-admin panel. */
export async function setMetalHostCordon(hostId: string, cordoned: boolean): Promise<void> {
  return getMetalWarmPoolController().setHostCordon(hostId, cordoned)
}

// Eligibility gating lives in the dependency-free metal-eligibility module so
// resolveProjectPodUrl can probe it cheaply. Re-exported here for convenience.
export { isMetalEnabled, isMetalEligibleProject } from './metal-eligibility'
