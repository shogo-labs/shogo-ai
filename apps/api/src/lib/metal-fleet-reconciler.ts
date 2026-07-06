// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Metal Fleet Reconciler — the actuator that keeps the live bare-metal fleet in
 * line with the declared desired state (config/metal-fleet.ts).
 *
 * Two responsibilities:
 *   1. BASELINE DRIFT (observe only): surface desired monthly hosts that aren't
 *      live. It does NOT auto-buy baseline capacity — a monthly commitment is a
 *      human decision (raise the Latitude cap, edit metal-fleet.ts). Drift shows
 *      up as a metric + log + the super-admin panel.
 *   2. BURST (actuate, gated): add short-lived HOURLY hosts when a region runs
 *      hot, and remove them (drain-first) when it cools. This is the auto-scaling
 *      the plan called for. Bounded by maxPerRegion, gated by a per-region
 *      cooldown (anti-flap), and only ever destroys reconciler-created burst
 *      hosts (tracked in the registry) — never a baseline host.
 *
 * SAFETY. Actuation is OFF by default and layered:
 *   - METAL_FLEET_RECONCILER_ENABLED must be true for the loop to run at all;
 *   - METAL_FLEET_ACTUATE must ALSO be true to make provider calls (else the
 *     reconciler logs the plan it WOULD execute — "observe mode");
 *   - a Latitude token must be present (LatitudeClient.isConfigured());
 *   - exactly one API replica actuates per tick (Redis leader lease).
 * So it is safe to deploy enabled-but-observing: it computes and reports plans
 * without spending a cent until actuation is deliberately turned on.
 *
 * Scale-down is two-phase so we never kill live projects: cordon the newest
 * burst host (it stops taking new placements and drains as projects idle), then
 * destroy it on a later tick once it reports 0 assigned.
 */

import { metrics } from '@opentelemetry/api'
import { getFleetEnv, type MetalFleetEnv } from '../config/metal-fleet'
import { getMetalWarmPoolController, type MetalWarmPoolController } from './metal-warm-pool-controller'
import { getMetalPlacementRegistry, type BurstHostRecord, type MetalPlacementRegistry } from './metal-placement-registry'
import { getLatitudeClient, type LatitudeClient } from './latitude-client'
import { buildBurstUserData } from './metal-cloud-init'

const meter = metrics.getMeter('shogo-metal-fleet')
const scaleActionsCounter = meter.createCounter('metal.fleet.scale_actions', {
  description: 'Fleet reconciler scale actions, labelled by kind (scale_up|cordon|destroy) and region',
})
const reconcileErrorsCounter = meter.createCounter('metal.fleet.reconcile_errors', {
  description: 'Fleet reconciler errors, labelled by phase',
})

const RECONCILE_INTERVAL_MS = parseInt(process.env.METAL_FLEET_RECONCILE_INTERVAL_MS || '60000', 10)
const LEADER_LEASE_MS = parseInt(process.env.METAL_FLEET_LEADER_LEASE_MS || '120000', 10)
const ENABLED = process.env.METAL_FLEET_RECONCILER_ENABLED === 'true'
const ACTUATE = process.env.METAL_FLEET_ACTUATE === 'true'

/** Latitude provisioning inputs pulled from env (same account as staging). */
const LAT_PROJECT = process.env.LATITUDESH_PROJECT_ID || ''
const LAT_SSH_KEY = process.env.LATITUDESH_SSH_KEY_ID || ''

/**
 * Read an env value with an optional per-region override. EU hosts must use the
 * EU S3 bucket/endpoint for data residency, so callers can set e.g.
 * METAL_FLEET_S3_ENDPOINT_EU alongside the default METAL_FLEET_S3_ENDPOINT.
 */
function regionEnv(base: string, region: string, fallback = ''): string {
  const suffixed = process.env[`${base}_${region.toUpperCase()}`]
  return (suffixed ?? process.env[base] ?? fallback) as string
}

/**
 * Assemble the cloud-init user_data for a new burst host from env-sourced
 * provisioning inputs. Throws (with a clear message) if a required secret/ref is
 * missing so we never create a server we can't actually bootstrap.
 */
function burstUserDataFor(hostId: string, region: string): string {
  const required = {
    controlPlaneUrl: process.env.METAL_FLEET_CONTROL_PLANE_URL || process.env.METAL_CONTROL_PLANE_URL || '',
    registerToken: process.env.METAL_REGISTER_TOKEN || process.env.SHOGO_INTERNAL_SECRET || '',
    fwdAllowCidr: process.env.METAL_FLEET_FWD_ALLOW_CIDR || '',
    s3Endpoint: regionEnv('METAL_FLEET_S3_ENDPOINT', region, process.env.S3_ENDPOINT || ''),
    s3Bucket: regionEnv('METAL_FLEET_S3_BUCKET', region, process.env.METAL_SNAP_BUCKET || ''),
    s3AccessKeyId: regionEnv('METAL_FLEET_S3_ACCESS_KEY_ID', region, process.env.AWS_ACCESS_KEY_ID || ''),
    s3SecretAccessKey: regionEnv('METAL_FLEET_S3_SECRET_ACCESS_KEY', region, process.env.AWS_SECRET_ACCESS_KEY || ''),
    ocirDockerConfigB64: process.env.METAL_FLEET_OCIR_CONFIG_B64 || '',
    runtimeImage: process.env.METAL_FLEET_RUNTIME_IMAGE || '',
    bundleUrl: process.env.METAL_FLEET_BUNDLE_URL || '',
  }
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) {
    throw new Error(`burst provisioning env incomplete: missing ${missing.join(', ')}`)
  }
  return buildBurstUserData({
    hostId,
    region,
    controlPlaneUrl: required.controlPlaneUrl,
    registerToken: required.registerToken,
    fwdAllowCidr: required.fwdAllowCidr,
    s3Endpoint: required.s3Endpoint,
    s3Region: regionEnv('METAL_FLEET_S3_REGION', region, process.env.S3_REGION || 'us-ashburn-1'),
    s3Bucket: required.s3Bucket,
    s3Prefix: process.env.METAL_FLEET_S3_PREFIX || 'metal-snapshots/',
    s3AccessKeyId: required.s3AccessKeyId,
    s3SecretAccessKey: required.s3SecretAccessKey,
    ocirDockerConfigB64: required.ocirDockerConfigB64,
    runtimeImage: required.runtimeImage,
    bundleUrl: required.bundleUrl,
  })
}

// A live host as seen by the controller's registry-aware fleet status.
export interface LiveHost {
  hostId: string
  region: string
  capacity?: { poolSize: number }
  load?: { assigned: number }
  cordoned?: boolean
}

export interface ReconcileSnapshot {
  now: number
  desired: MetalFleetEnv
  live: LiveHost[]
  burst: BurstHostRecord[]
  /** last scale action epoch-ms per region (cooldown source). */
  lastScaleAt: Record<string, number>
}

export type ReconcileAction =
  | { kind: 'baseline_missing'; hostId: string; region: string; site: string }
  | { kind: 'scale_up'; region: string; site: string; reason: string }
  | { kind: 'cordon_for_drain'; region: string; hostId: string; reason: string }
  | { kind: 'destroy_drained'; region: string; hostId: string; serverId: string }

export interface RegionAssessment {
  region: string
  utilPct: number
  liveCount: number
  burstCount: number
  cooldownRemainingMs: number
}

export interface ReconcilePlan {
  actions: ReconcileAction[]
  regions: RegionAssessment[]
}

/** assigned/poolSize as a whole-number percent across a region's live hosts. */
function regionUtilPct(live: LiveHost[]): number {
  let assigned = 0
  let cap = 0
  for (const h of live) {
    assigned += h.load?.assigned ?? 0
    cap += h.capacity?.poolSize ?? 0
  }
  if (cap <= 0) return 0
  return Math.round((assigned / cap) * 100)
}

/** Map a region to its provider site from the desired baseline (first match). */
function siteForRegion(desired: MetalFleetEnv, region: string): string | undefined {
  return desired.baseline.find((b) => b.region === region)?.site
}

/**
 * PURE planning function — no I/O, fully unit-testable. Turns a snapshot of
 * desired + live + burst state into the list of actions to take this tick.
 * Actuation (or observe-mode logging) is the caller's job.
 */
export function planReconcile(snap: ReconcileSnapshot): ReconcilePlan {
  const { now, desired, live, burst } = snap
  const actions: ReconcileAction[] = []
  const regions: RegionAssessment[] = []

  // 1. Baseline drift (observe): desired hosts with no live registration.
  const liveIds = new Set(live.map((h) => h.hostId))
  for (const b of desired.baseline) {
    if (!liveIds.has(b.hostId)) {
      actions.push({ kind: 'baseline_missing', hostId: b.hostId, region: b.region, site: b.site })
    }
  }

  // 2. Burst per region.
  const policy = desired.burst
  const burstByRegion = new Map<string, BurstHostRecord[]>()
  for (const rec of burst) {
    const arr = burstByRegion.get(rec.region) ?? []
    arr.push(rec)
    burstByRegion.set(rec.region, arr)
  }

  // Regions in play: those with desired baseline + those already carrying burst.
  const regionSet = new Set<string>([
    ...desired.baseline.map((b) => b.region),
    ...burst.map((b) => b.region),
  ])

  for (const region of regionSet) {
    const regionLive = live.filter((h) => h.region === region)
    const regionBurst = (burstByRegion.get(region) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt)
    const utilPct = regionUtilPct(regionLive)
    const cooldownMs = policy.cooldownSec * 1000
    const sinceScale = now - (snap.lastScaleAt[region] ?? 0)
    const cooldownRemainingMs = Math.max(0, cooldownMs - sinceScale)
    const cooldownOk = cooldownRemainingMs === 0

    regions.push({
      region,
      utilPct,
      liveCount: regionLive.length,
      burstCount: regionBurst.length,
      cooldownRemainingMs,
    })

    if (!policy.enabled) continue

    // First: finish any drain-in-progress. A burst host we already cordoned and
    // that now reports 0 assigned (or is no longer live) is safe to destroy.
    for (const rec of regionBurst) {
      if (rec.drainingSince) {
        const stillLive = regionLive.find((h) => h.hostId === rec.hostId)
        const drained = !stillLive || (stillLive.load?.assigned ?? 0) === 0
        if (drained) {
          actions.push({ kind: 'destroy_drained', region, hostId: rec.hostId, serverId: rec.serverId })
        }
      }
    }

    if (!cooldownOk) continue

    const activeBurst = regionBurst.filter((r) => !r.drainingSince)

    // Scale UP: hot region, room under the per-region cap.
    if (utilPct >= policy.scaleUpUtilPct && activeBurst.length < policy.maxPerRegion) {
      const site = siteForRegion(desired, region)
      if (site) {
        actions.push({
          kind: 'scale_up',
          region,
          site,
          reason: `util ${utilPct}% >= ${policy.scaleUpUtilPct}% (burst ${activeBurst.length}/${policy.maxPerRegion})`,
        })
        continue // one scale action per region per tick
      }
    }

    // Scale DOWN: cool region, drain the NEWEST active burst host first.
    if (utilPct <= policy.scaleDownUtilPct && activeBurst.length > 0) {
      const newest = activeBurst[activeBurst.length - 1]
      actions.push({
        kind: 'cordon_for_drain',
        region,
        hostId: newest.hostId,
        reason: `util ${utilPct}% <= ${policy.scaleDownUtilPct}%`,
      })
    }
  }

  return { actions, regions }
}

export class MetalFleetReconciler {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly holderId = `metal-recon-${process.env.HOSTNAME || crypto.randomUUID()}`

  constructor(
    private controller: MetalWarmPoolController = getMetalWarmPoolController(),
    private registry: MetalPlacementRegistry = getMetalPlacementRegistry(),
    private latitude: LatitudeClient = getLatitudeClient(),
    private now: () => number = Date.now,
  ) {}

  /** Build the current snapshot from live registry state. */
  private async snapshot(): Promise<ReconcileSnapshot> {
    const desired = getFleetEnv()
    const fleet = await this.controller.getFleetStatus()
    const burst = await this.registry.listBurstHosts()
    const regions = new Set<string>([...desired.baseline.map((b) => b.region), ...burst.map((b) => b.region)])
    const lastScaleAt: Record<string, number> = {}
    for (const region of regions) lastScaleAt[region] = await this.registry.getLastScaleAt(region)
    return {
      now: this.now(),
      desired,
      live: fleet.hosts as LiveHost[],
      burst,
      lastScaleAt,
    }
  }

  /** One reconcile pass. Returns the plan (for tests / observability). */
  async reconcileOnce(): Promise<ReconcilePlan | null> {
    // Leader election: only one replica actuates per tick.
    const isLeader = await this.registry.acquireReconcileLease(this.holderId, LEADER_LEASE_MS)
    if (!isLeader) return null

    let snap: ReconcileSnapshot
    try {
      snap = await this.snapshot()
    } catch (err: any) {
      reconcileErrorsCounter.add(1, { phase: 'snapshot' })
      console.error('[metal-fleet] snapshot failed:', err?.message ?? err)
      return null
    }

    const plan = planReconcile(snap)

    // Always surface baseline drift (observe-only, no actuation).
    for (const a of plan.actions) {
      if (a.kind === 'baseline_missing') {
        console.warn(`[metal-fleet] baseline drift: desired host ${a.hostId} (${a.region}/${a.site}) not live`)
      }
    }
    for (const r of plan.regions) {
      console.log(
        `[metal-fleet] region=${r.region} util=${r.utilPct}% live=${r.liveCount} burst=${r.burstCount}` +
          (r.cooldownRemainingMs > 0 ? ` cooldown=${Math.round(r.cooldownRemainingMs / 1000)}s` : ''),
      )
    }

    const canActuate = ACTUATE && this.latitude.isConfigured()
    for (const a of plan.actions) {
      if (a.kind === 'baseline_missing') continue
      if (!canActuate) {
        console.log(`[metal-fleet] OBSERVE (actuation off) would ${a.kind} ${JSON.stringify(a)}`)
        continue
      }
      try {
        await this.execute(a, snap)
      } catch (err: any) {
        reconcileErrorsCounter.add(1, { phase: a.kind })
        console.error(`[metal-fleet] ${a.kind} failed:`, err?.message ?? err)
      }
    }

    return plan
  }

  /** Execute a single actuation action against the provider + registry. */
  private async execute(a: ReconcileAction, snap: ReconcileSnapshot): Promise<void> {
    switch (a.kind) {
      case 'scale_up': {
        if (!LAT_PROJECT || !LAT_SSH_KEY) {
          throw new Error('LATITUDESH_PROJECT_ID / LATITUDESH_SSH_KEY_ID not set — cannot provision burst host')
        }
        const stamp = new Date(snap.now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
        const hostname = `shogo-fc-burst-${a.region}-${stamp}`
        // Generate cloud-init BEFORE creating the server: if provisioning env is
        // incomplete this throws and we never create an un-bootstrappable box.
        const userData = burstUserDataFor(hostname, a.region)
        const server = await this.latitude.createServer({
          project: LAT_PROJECT,
          plan: snap.desired.burst.plan,
          site: a.site,
          operatingSystem: process.env.METAL_FLEET_OS || 'ubuntu_24_04_x64_lts',
          hostname,
          sshKeys: [LAT_SSH_KEY],
          billing: 'hourly',
          userData,
        })
        await this.registry.recordBurstHost({
          hostId: hostname,
          serverId: server.id,
          region: a.region,
          site: a.site,
          createdAt: snap.now,
        })
        await this.registry.setLastScaleAt(a.region, snap.now)
        scaleActionsCounter.add(1, { kind: 'scale_up', region: a.region })
        console.log(`[metal-fleet] scaled UP ${a.region}: created ${server.id} (${hostname}) — ${a.reason}`)
        break
      }
      case 'cordon_for_drain': {
        await this.controller.setHostCordon(a.hostId, true)
        const rec = snap.burst.find((b) => b.hostId === a.hostId)
        if (rec) await this.registry.recordBurstHost({ ...rec, drainingSince: snap.now })
        await this.registry.setLastScaleAt(a.region, snap.now)
        scaleActionsCounter.add(1, { kind: 'cordon', region: a.region })
        console.log(`[metal-fleet] scaling DOWN ${a.region}: cordoned ${a.hostId} to drain — ${a.reason}`)
        break
      }
      case 'destroy_drained': {
        await this.latitude.deleteServer(a.serverId)
        await this.registry.removeBurstHost(a.hostId)
        scaleActionsCounter.add(1, { kind: 'destroy', region: a.region })
        console.log(`[metal-fleet] destroyed drained burst host ${a.hostId} (${a.serverId}) in ${a.region}`)
        break
      }
    }
  }

  start(): void {
    if (!ENABLED) {
      console.log('[metal-fleet] reconciler disabled (METAL_FLEET_RECONCILER_ENABLED != true)')
      return
    }
    const mode = ACTUATE && this.latitude.isConfigured() ? 'ACTUATE' : 'OBSERVE'
    console.log(`[metal-fleet] reconciler starting (${mode}, every ${RECONCILE_INTERVAL_MS}ms)`)
    const tick = () => {
      this.reconcileOnce().catch((err) => {
        reconcileErrorsCounter.add(1, { phase: 'tick' })
        console.error('[metal-fleet] tick error:', err?.message ?? err)
      })
    }
    this.timer = setInterval(tick, RECONCILE_INTERVAL_MS)
    // Kick one off shortly after boot (let heartbeats land first).
    setTimeout(tick, Math.min(15_000, RECONCILE_INTERVAL_MS))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

let reconciler: MetalFleetReconciler | null = null

export function startMetalFleetReconciler(): void {
  if (reconciler) return
  reconciler = new MetalFleetReconciler()
  reconciler.start()
}

export function stopMetalFleetReconciler(): void {
  reconciler?.stop()
  reconciler = null
}
