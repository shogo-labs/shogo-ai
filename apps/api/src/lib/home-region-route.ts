// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Home-region routing for writes that carry no Shogo session to proxy.
 * Kept apart from `region-peer-proxy.ts` so that module's import surface (and
 * the many tests that mock `./region` narrowly) stays unchanged.
 */

import { getPeer, isMultiRegionActive, PRIMARY_REGION, RAW_REGION_ID } from './region'
import { callPeerInternal } from './region-peer-proxy'

export type HomeRouteOutcome = 'local' | 'forwarded' | 'unavailable'

export interface HomeRouteResult<T = unknown> {
  outcome: HomeRouteOutcome
  /** The home region's JSON reply when `outcome` is `forwarded`. */
  data?: T | null
}

/**
 * Run a workspace-scoped write in the workspace's home region.
 *
 * For writes that arrive without a Shogo session to proxy (provider webhooks,
 * account-link callbacks), so the home-region write router can't forward them.
 * Resolves `workspace.homeRegion` (null means the primary region, matching the
 * router) and then:
 *   - `local`: single-region mode, or this IS the home region (or the
 *     workspace is unknown here): the caller handles it itself.
 *   - `forwarded`: the home region accepted it over `callPeerInternal`.
 *   - `unavailable`: the home region is known but unreachable or rejected the
 *     call. Callers must NOT fall back to a local write (that is the
 *     cross-region collision this exists to prevent); they should ask the
 *     sender to retry.
 *
 * The receiving `/api/internal/*` handler runs the work locally and never
 * routes again, so a forwarded call cannot ping-pong.
 */
export async function routeToHomeRegion<T = unknown>(
  workspaceId: string,
  path: string,
  body: unknown,
): Promise<HomeRouteResult<T>> {
  if (!isMultiRegionActive() || !RAW_REGION_ID) return { outcome: 'local' }

  let homeRegion: string
  try {
    const { prisma } = await import('./prisma')
    const ws = await (prisma as any).workspace.findUnique({
      where: { id: workspaceId },
      select: { homeRegion: true },
    })
    if (!ws) return { outcome: 'local' }
    homeRegion = ws.homeRegion || PRIMARY_REGION
  } catch (err: any) {
    console.warn(`[HomeRoute] home-region lookup failed for workspace ${workspaceId}:`, err?.message || err)
    return { outcome: 'unavailable' }
  }

  if (homeRegion === RAW_REGION_ID) return { outcome: 'local' }
  if (!getPeer(homeRegion)) {
    console.warn(`[HomeRoute] no peer configured for home region ${homeRegion} (workspace ${workspaceId})`)
    return { outcome: 'unavailable' }
  }

  try {
    const res = await callPeerInternal<T>(homeRegion, path, body)
    if (res.ok) return { outcome: 'forwarded', data: res.data }
    console.warn(`[HomeRoute] ${homeRegion} rejected ${path} with ${res.status}`)
    return { outcome: 'unavailable' }
  } catch (err: any) {
    console.warn(`[HomeRoute] ${homeRegion} unreachable for ${path}:`, err?.message || err)
    return { outcome: 'unavailable' }
  }
}
