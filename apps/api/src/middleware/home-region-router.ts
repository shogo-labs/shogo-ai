// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Home-region write router.
 *
 * Shogo Cloud runs three active-active regions that all replicate to each other.
 * Writing the same workspace's rows in two regions at once is what produced the
 * split-brain that poison-pilled logical replication. This middleware makes each
 * workspace single-writer: a mutating request that targets a workspace owned by
 * a *different* region is transparently proxied to that home region, which
 * writes to its own local primary. Reads stay local off the replica.
 *
 * Gated by `HOME_REGION_ROUTING`:
 *   - `off`     (default): no-op.
 *   - `shadow`: log what *would* be proxied (resolved workspace + target) but
 *               still handle locally — used to validate resolution before
 *               enabling enforcement.
 *   - `enforce`: actually proxy non-home writes.
 *
 * Must be registered AFTER `requireProjectAccess` so project routes have already
 * cached `c.get('workspaceId')` (cheap resolve) and access is verified first.
 */

import type { Context, Next } from 'hono'
import { prisma } from '../lib/prisma'
import { RAW_REGION_ID, PRIMARY_REGION, getPeer } from '../lib/region'
import { proxyToPeer, isProxiedRequest } from '../lib/region-peer-proxy'
import { resolveWorkspaceIdForRequest } from '../lib/resolve-workspace-id'

export type HomeRegionRoutingMode = 'off' | 'shadow' | 'enforce'

export function getHomeRegionRoutingMode(): HomeRegionRoutingMode {
  const v = (process.env.HOME_REGION_ROUTING || 'off').toLowerCase()
  return v === 'shadow' || v === 'enforce' ? v : 'off'
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Prefixes that must never be proxied here:
 *   - auth/identity/global surfaces (no single home region),
 *   - webhooks / internal / provider callbacks (no Shogo session to forward,
 *     and they target this region deliberately),
 *   - the admin region console (already its own cross-region proxy),
 *   - self-authenticating public APIs.
 */
const SKIP_PREFIXES = [
  '/api/auth/',
  '/api/webhooks/',
  '/api/internal/',
  '/api/integrations/',
  '/api/admin/regions/',
  '/api/health',
  '/api/version',
  '/api/config',
  '/api/ai/',
  '/api/v1/',
  '/api/tools/',
  '/api/local/',
  '/api/vm/',
  '/api/marketplace',
  '/api/cli/login/',
]

function warn(message: string, fields: Record<string, unknown>) {
  console.warn(`[home-region-router] ${message}`, fields)
}

export async function homeRegionWriteProxy(c: Context, next: Next) {
  const mode = getHomeRegionRoutingMode()
  if (mode === 'off') return next()

  // Single-region / local / desktop: nothing to route.
  if (!RAW_REGION_ID) return next()

  // Already proxied from a sibling region — handle it here, never re-proxy.
  if (isProxiedRequest(c)) return next()

  if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) return next()

  const path = new URL(c.req.url).pathname
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return next()

  let workspaceId: string | null = null
  try {
    workspaceId = await resolveWorkspaceIdForRequest(c)
  } catch (err) {
    warn('workspace resolution failed; handling locally', {
      path,
      error: err instanceof Error ? err.message : String(err),
    })
    return next()
  }
  // Identity/global write (no workspace) — stays local.
  if (!workspaceId) return next()

  let homeRegion: string | null = null
  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { homeRegion: true },
    })
    if (!ws) return next() // unknown workspace — let the handler 404 it locally.
    homeRegion = ws.homeRegion
  } catch (err) {
    warn('homeRegion lookup failed; handling locally', {
      path,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    return next()
  }

  // Null homeRegion (legacy/unassigned) is owned by the primary region.
  const effectiveHome = homeRegion || PRIMARY_REGION
  if (effectiveHome === RAW_REGION_ID) return next()

  const peer = getPeer(effectiveHome)
  if (!peer) {
    // We don't know how to reach the home region — fail open (local) rather
    // than 502 the user. Surfaced in logs so misconfig is visible.
    warn('no peer configured for homeRegion; handling locally', {
      path,
      workspaceId,
      homeRegion: effectiveHome,
      from: RAW_REGION_ID,
    })
    return next()
  }

  if (mode === 'shadow') {
    console.log('[home-region-router] would-proxy', {
      method: c.req.method,
      path,
      workspaceId,
      homeRegion: effectiveHome,
      from: RAW_REGION_ID,
    })
    return next()
  }

  console.log('[home-region-router] proxy', {
    method: c.req.method,
    path,
    workspaceId,
    homeRegion: effectiveHome,
    from: RAW_REGION_ID,
  })
  return proxyToPeer(c, effectiveHome)
}
