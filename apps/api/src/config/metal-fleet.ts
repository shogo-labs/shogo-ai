// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Baseline metal fleet — the committed, declarative source of truth for the
 * bare-metal Firecracker hosts the control plane expects to exist.
 *
 * We deliberately do NOT manage bare-metal server lifecycle in Terraform: hosts
 * are provisioned/destroyed on demand (baseline monthly + burst hourly) against
 * the provider API, so a `terraform apply` is the wrong unit of change. Instead
 * this file declares the DESIRED steady-state fleet per environment/region and a
 * burst policy; a reconciler (and the super-admin fleet panel) diff it against
 * the live registry (heartbeats) to surface drift and, later, to provision the
 * missing baseline hosts and scale burst capacity up/down automatically.
 *
 * Editing this file is the sanctioned way to change the baseline fleet SHAPE.
 *
 * NOTE: This file is committed to a PUBLIC repo, so it holds only non-sensitive
 * desired-state (hostId, region, site, billing, role). Provider identity and
 * operational details — the Latitude `serverId`, the box `publicIp`, an
 * enable/disable flag, notes — are stored in the DATABASE (super-admin managed,
 * see lib/metal-fleet-hosts.ts) and merged into the fleet view at runtime. The
 * live IP a host serves on always comes from its heartbeat.
 */

export interface MetalFleetHost {
  /** Stable host id the node-agent registers with (METAL_HOST_ID). */
  hostId: string
  /** Logical region this host serves (matches REGION_ID: us | eu | in). */
  region: string
  /** Provider site/facility code (Latitude: DAL, FRA, ...). */
  site: string
  /** Billing term for this host. */
  billing: 'monthly' | 'hourly'
  /** Free-form role note (e.g. "staging", "primary"). */
  role?: string
}

export interface MetalBurstPolicy {
  /** When true the reconciler may add hourly hosts above baseline on load. */
  enabled: boolean
  plan: string
  billing: 'hourly'
  /** Max burst hosts to add per region on top of baseline. */
  maxPerRegion: number
  /** Add a host when region utilization exceeds this. Utilization is live
   * assigned microVMs ÷ real capacity (liveHosts × MAX_VMS_PER_HOST), NOT the
   * warm-pool poolSize. */
  scaleUpUtilPct: number
  /** Remove the newest burst host when utilization drops below this. */
  scaleDownUtilPct: number
  /** Minimum seconds between scale actions per region (anti-flap). */
  cooldownSec: number
}

export interface MetalFleetEnv {
  baseline: MetalFleetHost[]
  burst: MetalBurstPolicy
}

export interface MetalFleetConfig {
  version: number
  provider: 'latitude'
  /** Defaults applied to newly provisioned hosts (informational for the panel). */
  defaults: { plan: string; os: string; billing: 'monthly'; swapGiB: number }
  environments: Record<string, MetalFleetEnv>
}

export const METAL_FLEET: MetalFleetConfig = {
  version: 1,
  provider: 'latitude',
  defaults: {
    plan: 's3-large-x86', // 24c AMD EPYC 7443P, 512 GB RAM, 2x3.8 TB + 480 GB NVMe
    os: 'ubuntu_24_04_x64_lts',
    billing: 'monthly',
    swapGiB: 256, // NVMe swap OOM safety net (scripts/metal-agent/host-bootstrap.sh)
  },
  environments: {
    staging: {
      baseline: [
        {
          hostId: 'latitude-dal-1',
          region: 'us',
          site: 'DAL',
          billing: 'monthly',
          role: 'staging',
        },
      ],
      burst: {
        enabled: false, // staging runs a single baseline host
        plan: 's3-large-x86',
        billing: 'hourly',
        maxPerRegion: 1,
        scaleUpUtilPct: 70,
        scaleDownUtilPct: 40,
        cooldownSec: 900,
      },
    },
    // Production target: 2 regions (US=Dallas, EU=Frankfurt), 2 monthly hosts
    // each. Provider identity (serverId/publicIp) for each host is recorded in
    // the DB (super-admin fleet panel); a host shows as drift "missing" until it
    // registers a heartbeat.
    production: {
      baseline: [
        { hostId: 'latitude-dal-1', region: 'us', site: 'DAL', billing: 'monthly', role: 'primary' },
        { hostId: 'latitude-dal-2', region: 'us', site: 'DAL', billing: 'monthly', role: 'primary' },
        { hostId: 'latitude-fra-1', region: 'eu', site: 'FRA', billing: 'monthly', role: 'primary' },
        { hostId: 'latitude-fra-2', region: 'eu', site: 'FRA', billing: 'monthly', role: 'primary' },
      ],
      burst: {
        enabled: true,
        plan: 's3-large-x86',
        billing: 'hourly',
        maxPerRegion: 2,
        scaleUpUtilPct: 70,
        scaleDownUtilPct: 40,
        cooldownSec: 900,
      },
    },
  },
}

/** Environment key for fleet lookups (staging|production), from NODE/APP env. */
export function fleetEnvKey(): string {
  const e = (process.env.SHOGO_ENV || process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase()
  return e === 'production' || e === 'prod' ? 'production' : 'staging'
}

/** Desired fleet for the current environment (defaults to staging). */
export function getFleetEnv(envKey: string = fleetEnvKey()): MetalFleetEnv {
  return METAL_FLEET.environments[envKey] ?? METAL_FLEET.environments.staging
}

/** Every fleet-region token declared across all environments (us | eu | ...). */
function knownFleetRegions(): Set<string> {
  const regions = new Set<string>()
  for (const env of Object.values(METAL_FLEET.environments)) {
    for (const b of env.baseline) regions.add(b.region)
  }
  return regions
}

/**
 * The fleet region THIS control plane owns (us | eu | ...), or undefined when
 * it can't be determined.
 *
 * Each production region runs its OWN control plane (separate DB + registry),
 * and a node-agent only ever heartbeats to its region's control plane. So a
 * control plane must diff the committed baseline against ONLY its own region —
 * otherwise every OTHER region's baseline hosts look like permanent "drift"
 * (they're live and healthy, just registered to a different control plane). That
 * cross-region phantom is exactly what made a healthy EU fleet read as "down" on
 * the US control plane.
 *
 * Resolution order:
 *   1. explicit METAL_FLEET_REGION override (operator-set, trusted as-is);
 *   2. derived from the OCI REGION_ID prefix (us-ashburn-1 → us,
 *      eu-frankfurt-1 → eu), but ONLY if that prefix is a region we actually
 *      declare a baseline for — an unrecognized value returns undefined so we
 *      fail SAFE (fall back to the full multi-region baseline) rather than
 *      silently manage nothing.
 *
 * Returns undefined for staging/tests/local (no region env) → callers use the
 * full baseline, preserving the original behavior.
 */
export function homeFleetRegion(): string | undefined {
  const explicit = (process.env.METAL_FLEET_REGION || '').trim().toLowerCase()
  if (explicit) return explicit
  const rid = (process.env.REGION_ID || '').trim().toLowerCase()
  const prefix = rid.split('-')[0]
  return prefix && knownFleetRegions().has(prefix) ? prefix : undefined
}

/**
 * Desired fleet scoped to THIS control plane's region (see homeFleetRegion).
 * Use this — not getFleetEnv — for baseline-drift, region telemetry, and burst
 * actuation, so a regional control plane never reports another region's
 * (live-elsewhere) baseline hosts as missing.
 *
 * Falls back to the FULL multi-region env when the region is unknown
 * (staging/tests) or when scoping would leave an empty baseline (a region env
 * that declares nothing for us) — better to over-report drift than to silently
 * stop managing the whole fleet.
 */
export function getHomeFleetEnv(envKey: string = fleetEnvKey()): MetalFleetEnv {
  const full = getFleetEnv(envKey)
  const region = homeFleetRegion()
  if (!region) return full
  const baseline = full.baseline.filter((b) => b.region === region)
  if (baseline.length === 0) return full
  return { ...full, baseline }
}
