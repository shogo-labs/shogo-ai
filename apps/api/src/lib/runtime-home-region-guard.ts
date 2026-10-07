// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime home-region guard.
 *
 * A workspace's runtime (metal microVM / Knative service) must only run in the
 * workspace's `homeRegion`. Runtime placement is per-region (each region has
 * its own placement registry), but every region shares one source-backup
 * bucket — so a second runtime booted in a peer region serves a stale tree,
 * and its periodic backup overwrites the home runtime's work.
 *
 * Request paths are proxied to the home region before they resolve a runtime
 * (`pinChatToHomeRegion`). This guard is the backstop for everything that
 * isn't: background schedulers, service-to-service callers, WebSocket bridges
 * (handled before Hono, so they can't be proxied), and any route that forgot
 * to pin. It refuses to boot or claim a runtime outside the home region.
 *
 * Fails open (allows the local runtime) when: single-region / local mode, the
 * guard is disabled (`RUNTIME_HOME_REGION_GUARD=off`), the workspace has no
 * home region (legacy null row — the request pin also serves those locally),
 * the home region isn't a configured peer (nowhere to defer to), or the
 * lookup fails.
 */

import { RAW_REGION_ID, REGION_PEERS } from './region'

export class RuntimeNotInHomeRegionError extends Error {
  readonly code = 'runtime_not_in_home_region'

  constructor(
    readonly workspaceId: string,
    readonly homeRegion: string,
    readonly region: string,
  ) {
    super(
      `workspace ${workspaceId} runtime belongs to home region ${homeRegion}; ` +
        `refusing to start it in ${region}`,
    )
    this.name = 'RuntimeNotInHomeRegionError'
  }
}

export interface RuntimeHomeRegionGuardDeps {
  /** This pod's region. Defaults to `REGION_ID` (null in single-region/local). */
  region?: string | null
  /** Configured peer region ids. Defaults to `REGION_PEERS`. */
  peerIds?: string[]
  /** Uncached home-region lookup. Defaults to a cached `workspace.homeRegion` read. */
  lookupHomeRegion?: (workspaceId: string) => Promise<string | null>
}

function guardEnabled(): boolean {
  const v = (process.env.RUNTIME_HOME_REGION_GUARD || '').toLowerCase()
  return v !== 'off' && v !== '0' && v !== 'false'
}

// homeRegion only changes on a deliberate workspace migration; a short TTL
// keeps the hot resolver path off the database.
const HOME_REGION_TTL_MS = 60_000
const homeRegionCache = new Map<string, { homeRegion: string | null; expiresAt: number }>()

async function cachedWorkspaceHomeRegion(workspaceId: string): Promise<string | null> {
  const hit = homeRegionCache.get(workspaceId)
  if (hit && hit.expiresAt > Date.now()) return hit.homeRegion
  const { prisma } = await import('./prisma')
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { homeRegion: true },
  })
  const homeRegion = ws?.homeRegion ?? null
  homeRegionCache.set(workspaceId, { homeRegion, expiresAt: Date.now() + HOME_REGION_TTL_MS })
  return homeRegion
}

/** @internal test hook */
export function _resetRuntimeHomeRegionCache(): void {
  homeRegionCache.clear()
}

/**
 * Throw `RuntimeNotInHomeRegionError` when `workspaceId` is homed in a peer
 * region. Call before booting or claiming the workspace's runtime.
 */
export async function assertRuntimeInHomeRegion(
  workspaceId: string,
  deps: RuntimeHomeRegionGuardDeps = {},
): Promise<void> {
  const region = 'region' in deps ? deps.region : RAW_REGION_ID
  const peerIds = deps.peerIds ?? REGION_PEERS.map((p) => p.id)
  if (!region || peerIds.length === 0 || !guardEnabled()) return

  let homeRegion: string | null
  try {
    homeRegion = deps.lookupHomeRegion
      ? await deps.lookupHomeRegion(workspaceId)
      : await cachedWorkspaceHomeRegion(workspaceId)
  } catch (err: any) {
    console.warn(
      `[RuntimeHomeRegionGuard] home-region lookup failed for workspace ${workspaceId} (allowing):`,
      err?.message || err,
    )
    return
  }

  if (!homeRegion || homeRegion === region) return
  if (!peerIds.includes(homeRegion)) return

  throw new RuntimeNotInHomeRegionError(workspaceId, homeRegion, region)
}
