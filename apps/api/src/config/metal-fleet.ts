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
 * Editing this file is the sanctioned way to change the baseline fleet. Each
 * `baseline` entry with a `serverId` is already provisioned; entries without one
 * are desired-but-not-yet-provisioned (the reconciler's to-do list).
 */

export interface MetalFleetHost {
  /** Stable host id the node-agent registers with (METAL_HOST_ID). */
  hostId: string
  /** Logical region this host serves (matches REGION_ID: us | eu | in). */
  region: string
  /** Provider site/facility code (Latitude: DAL, FRA, ...). */
  site: string
  /** Provider server id once provisioned (Latitude sv_...); absent = desired. */
  serverId?: string
  /** Public IP once provisioned (informational; live IP comes from heartbeat). */
  publicIp?: string
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
  /** Add a host when fleet assigned/poolSize utilization exceeds this. */
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
          serverId: 'sv_YGwn0V7yDN63J',
          publicIp: '72.46.85.83',
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
    // each. Entries without a serverId are desired-but-not-yet-provisioned — the
    // reconciler's provisioning to-do list (drift shows as "missing" until then).
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
