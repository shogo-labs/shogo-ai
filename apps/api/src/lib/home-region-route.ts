// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Home-region routing for writes that carry no Shogo session to proxy.
 * Kept apart from `region-peer-proxy.ts` so that module's import surface (and
 * the many tests that mock `./region` narrowly) stays unchanged.
 */

import { getPeer, isMultiRegionActive, PRIMARY_REGION, RAW_REGION_ID } from './region'
import { callPeerInternal } from './region-peer-proxy'

export type HomeRouteOutcome = 'local' | 'forwarded' | 'rejected' | 'unavailable'

export interface HomeRouteResult<T = unknown> {
  outcome: HomeRouteOutcome
  /** The home region's JSON reply when `outcome` is `forwarded`. */
  data?: T | null
  /** The home region's HTTP status when `outcome` is `rejected`. */
  status?: number
  /** The home region's error body when `outcome` is `rejected`. */
  error?: unknown
}

/**
 * 4xx answers that mean "try again", not "this write is refused".
 *
 * A rejection is only definitive when the home region understood the write and
 * said no: retrying can't change that answer, so the caller should surface it
 * instead of a generic retryable failure. These are the exceptions — 401/403 are
 * a stale internal secret mid-rollout, 404 is a peer pod that predates the
 * route, 408/429 are timeouts and backpressure; all are healthy on retry.
 */
const RETRYABLE_CLIENT_STATUSES = new Set([401, 403, 404, 408, 429])

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
 *   - `rejected`: the home region understood the write and refused it (a 409
 *     "already handled", a 400 "nothing to reply to"). `status` and `error`
 *     carry its answer, which is the caller's answer — do NOT retry, and do not
 *     dress it up as `unavailable`, or a definitive refusal looks transient and
 *     the sender re-sends forever.
 *   - `unavailable`: the home region is known but unreachable or rejected the
 *     call for a retryable reason. Callers must NOT fall back to a local write
 *     (that is the cross-region collision this exists to prevent); they should
 *     ask the sender to retry.
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
    if (res.status >= 400 && res.status < 500 && !RETRYABLE_CLIENT_STATUSES.has(res.status)) {
      // The home region understood the write and said no. Hand its answer back
      // unchanged: it is what the caller has to act on (or show the person).
      console.warn(`[HomeRoute] ${homeRegion} refused ${path} with ${res.status}`)
      return { outcome: 'rejected', status: res.status, error: res.data }
    }
    console.warn(`[HomeRoute] ${homeRegion} rejected ${path} with ${res.status}`)
    return { outcome: 'unavailable' }
  } catch (err: any) {
    console.warn(`[HomeRoute] ${homeRegion} unreachable for ${path}:`, err?.message || err)
    return { outcome: 'unavailable' }
  }
}
