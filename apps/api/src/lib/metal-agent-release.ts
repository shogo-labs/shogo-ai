// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Desired-version control plane for the bare-metal node-agent fleet.
 *
 * The scalable deploy model is PULL, not push: CI publishes an immutable,
 * versioned agent bundle to object storage and records a per-region, per-channel
 * pointer here; each host learns its desired version from the heartbeat response
 * (routes/metal.ts) and self-updates (apps/metal-agent/src/self-update.ts) with a
 * graceful restart that keeps live microVMs running. This module owns the
 * pointer: the pure resolver (unit-tested) + its DB-backed storage.
 *
 * Stored as one JSON object under the `metal.fleet.channels` PlatformSetting key
 * (same pattern as metal.fleet.hosts): { [region]: { [channel]: AgentRelease } }.
 * A host's channel comes from its MetalHostRecord (default 'stable'); a couple of
 * hosts pinned to 'canary' get a new build first, and promotion is just copying
 * canary → stable. Rollback is flipping the pointer — no CI, no SSH.
 */

import { getMetalHostRecordMap } from './metal-fleet-hosts'
import { prisma } from './prisma'

export const METAL_FLEET_CHANNELS_KEY = 'metal.fleet.channels'

export interface AgentRelease {
  /** Short git sha / tag the host stamps as its running version. */
  version: string
  /** Where to pull the immutable bundle: https:// or s3://bucket/key. */
  bundleUrl: string
  /** Hex sha256 of the bundle tgz; the agent verifies before applying. */
  sha256: string
  /** When the golden rootfs (runtime image) changed too, not just agent code. */
  rebuildRootfs?: boolean
  /**
   * Immutable runtime image tag the rebuild must bake (`...:<env>-multiarch-<sha>`),
   * so a rebuild that runs before the image is published fails and retries
   * instead of baking whatever `-latest` points at. Only kept on rebuild releases.
   */
  runtimeImage?: string
  /** Commit the rebuilt rootfs must report in /etc/shogo-runtime-revision. */
  runtimeRevision?: string
}

const REVISION_RE = /^[0-9a-f]{7,64}$/

/** The rebuild fields of a release, normalized. Dropped when it doesn't rebuild. */
function rootfsFields(rel: Partial<AgentRelease>): Partial<AgentRelease> {
  if (!rel.rebuildRootfs) return {}
  const out: Partial<AgentRelease> = { rebuildRootfs: true }
  if (typeof rel.runtimeImage === 'string' && rel.runtimeImage.trim()) out.runtimeImage = rel.runtimeImage.trim()
  if (typeof rel.runtimeRevision === 'string' && rel.runtimeRevision.trim()) {
    out.runtimeRevision = rel.runtimeRevision.trim().toLowerCase()
  }
  return out
}

/** region → channel → release. */
export type FleetChannels = Record<string, Record<string, AgentRelease>>

export interface DesiredAgent extends AgentRelease {
  /** The channel this resolved from (may differ from requested if it fell back). */
  channel: string
}

/**
 * Pure resolver: what version should a host in `region` on `channel` run?
 * Falls back region '*' → the requested region's 'stable' → null. A release is
 * only returned when it has a version + bundleUrl (an unpublished channel yields
 * null, i.e. "stay put"). No I/O so it's fully unit-testable.
 */
export function resolveDesiredAgent(region: string, channel: string, channels: FleetChannels): DesiredAgent | null {
  const byChannel = channels[region] ?? channels['*']
  if (!byChannel) return null
  const wanted = byChannel[channel]
  const rel = wanted ?? byChannel['stable']
  if (!rel?.version || !rel?.bundleUrl) return null
  return {
    version: rel.version,
    bundleUrl: rel.bundleUrl,
    sha256: rel.sha256,
    ...rootfsFields(rel),
    channel: wanted ? channel : 'stable',
  }
}

// --- DB-backed storage -------------------------------------------------------

export async function getFleetChannels(): Promise<FleetChannels> {
  try {
    const row = (await prisma.platformSetting.findUnique({
      where: { key: METAL_FLEET_CHANNELS_KEY },
    })) as { value: string } | null
    if (!row?.value) return {}
    const parsed = JSON.parse(row.value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FleetChannels) : {}
  } catch {
    return {}
  }
}

/** Publish a release to a region/channel pointer; returns the full updated map. */
export async function setFleetChannelRelease(
  region: string,
  channel: string,
  release: AgentRelease,
  updatedBy?: string | null,
): Promise<FleetChannels> {
  if (!region || !channel) throw new Error('region and channel required')
  if (!release?.version || !release?.bundleUrl || !release?.sha256) {
    throw new Error('release requires version, bundleUrl and sha256')
  }
  if (release.runtimeRevision && !REVISION_RE.test(String(release.runtimeRevision).trim().toLowerCase())) {
    throw new Error('runtimeRevision must be a hex commit sha')
  }
  const channels = await getFleetChannels()
  channels[region] = {
    ...(channels[region] ?? {}),
    [channel]: {
      version: release.version,
      bundleUrl: release.bundleUrl,
      sha256: release.sha256,
      ...rootfsFields(release),
    },
  }
  const value = JSON.stringify(channels)
  await prisma.platformSetting.upsert({
    where: { key: METAL_FLEET_CHANNELS_KEY },
    update: { value, updatedBy: updatedBy ?? null },
    create: { key: METAL_FLEET_CHANNELS_KEY, value, updatedBy: updatedBy ?? null },
  })
  invalidateReleaseCache()
  return channels
}

// --- Heartbeat-path resolution (cached) --------------------------------------
// Every host heartbeats ~every 30s; resolving desired-version must not hit the
// DB on each one. A short TTL cache of channels + host records is plenty fresh
// for a deploy pointer (converges within one TTL of a publish) and is
// invalidated immediately on a local publish.

const RELEASE_CACHE_MS = parseInt(process.env.METAL_RELEASE_CACHE_MS || '10000', 10)
let cache: { at: number; channels: FleetChannels; hosts: Map<string, { region?: string; channel?: string }> } | null = null

export function invalidateReleaseCache(): void {
  cache = null
}

async function loadCached() {
  const now = Date.now()
  if (cache && now - cache.at < RELEASE_CACHE_MS) return cache
  const [channels, hosts] = await Promise.all([getFleetChannels(), getMetalHostRecordMap()])
  cache = { at: now, channels, hosts }
  return cache
}

/**
 * Desired version for a heartbeating host: its record's channel (default
 * 'stable') + region resolved against the published channels. Returns null when
 * nothing is published for it (the agent then stays on its current version).
 */
export async function resolveDesiredForHost(hostId: string, region: string): Promise<DesiredAgent | null> {
  const { channels, hosts } = await loadCached()
  const rec = hosts.get(hostId)
  return resolveDesiredAgent(rec?.region ?? region, rec?.channel ?? 'stable', channels)
}
