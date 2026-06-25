// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Region configuration shared across the API.
 *
 * Shogo Cloud runs three active-active regions (US / EU / India). Each pod is
 * told which region it is via `REGION_ID` and where its sibling regions live
 * via `REGION_PEERS` (a JSON array). This module centralizes that config so the
 * write-ownership router, the workspace-create path, and the admin region proxy
 * all agree on region identity instead of each re-parsing the environment.
 *
 * In single-region / local / desktop mode `REGION_ID` is unset. In that case:
 *   - `RAW_REGION_ID` is `null` (so we never stamp a bogus homeRegion on new
 *     workspaces), and
 *   - `REGION_ID` falls back to the string "unknown" for logging/identity.
 */

export interface RegionPeer {
  id: string
  label: string
  url: string
}

/**
 * The primary region. Workspaces with no explicit `homeRegion` (legacy rows
 * created before this column, or anything the backfill couldn't classify) are
 * treated as owned by the primary, matching the backfill's default.
 */
export const PRIMARY_REGION = 'us-ashburn-1'

/** The raw `REGION_ID` env value, or null when unset (local/desktop). */
export const RAW_REGION_ID: string | null = process.env.REGION_ID || null

/** This region's id, defaulting to "unknown" for logging when unset. */
export const REGION_ID = RAW_REGION_ID || 'unknown'

/** Human-readable label for this region (falls back to the id). */
export const REGION_LABEL = process.env.REGION_LABEL || REGION_ID

/** Sibling regions this pod can proxy writes to. Empty in single-region mode. */
export const REGION_PEERS: RegionPeer[] = (() => {
  try {
    const parsed = JSON.parse(process.env.REGION_PEERS || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
})()

/**
 * Host header to present to peer regions. The peers sit behind the same public
 * hostname, so cross-region fetches must spoof Host/Origin to pass CORS + the
 * Better Auth trusted-origin check on the receiving side.
 */
export const HOST_HEADER_FOR_PEERS = process.env.HOST_HEADER_FOR_PEERS || 'studio.shogo.ai'

/** Look up a peer region by id. */
export function getPeer(regionId: string): RegionPeer | undefined {
  return REGION_PEERS.find((p) => p.id === regionId)
}

/** True when `regionId` is this region or a known peer. */
export function isKnownRegion(regionId: string): boolean {
  return regionId === RAW_REGION_ID || REGION_PEERS.some((p) => p.id === regionId)
}

/**
 * The homeRegion value to stamp on a workspace created in this region. Null in
 * single-region/local mode, where the router treats null as "primary / local".
 */
export function homeRegionForNewWorkspace(): string | null {
  return RAW_REGION_ID
}

/**
 * The homeRegion value to stamp on a user created (signed up) in this region.
 * Pins the user's identity-scoped writes to the region they signed up in. Null
 * in single-region/local mode, where the router treats null as "primary /
 * local".
 */
export function homeRegionForNewUser(): string | null {
  return RAW_REGION_ID
}
