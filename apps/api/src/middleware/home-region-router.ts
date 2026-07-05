// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Home-region write router.
 *
 * Shogo Cloud runs three active-active regions that all replicate to each other.
 * Writing the same logical row in two regions at once is what produced the
 * split-brain that poison-pilled logical replication. This middleware makes
 * every row single-writer by proxying a mutating request to the region that
 * *owns* the row; that region writes to its own local primary and the change
 * replicates out. Reads stay local off the replica.
 *
 * Three ownership classes (checked in this order):
 *   1. Workspace-owned   → `workspace.homeRegion` (most tenant data).
 *   2. Platform-global   → the primary region (admin/catalog data).
 *   3. Identity-owned    → `users.homeRegion` (the user row, notifications, …).
 * Anything that resolves to none of these is handled locally.
 *
 * Gated by `HOME_REGION_ROUTING`:
 *   - `off`     (default): no-op.
 *   - `shadow`: log what *would* be proxied (resolved owner + target) but still
 *               handle locally — used to validate resolution before enforcing.
 *   - `enforce`: actually proxy non-home writes.
 *
 * Fail behavior: by default we fail *open* (handle locally) when the home
 * region's peer is unconfigured, to avoid 502-ing users on misconfig. For
 * money-sensitive writes (`FAIL_CLOSED_PREFIXES` — billing / usage / license
 * redemption) and region-affine chat writes (`isAffineChatPath`) we fail
 * *closed* with a 503 instead: a wrong-region write to a counter/balance is
 * worse than a transient failure, and a wrong-region chat turn strands its
 * in-memory stream buffer (the client can never resume it).
 *
 * Must be registered AFTER `requireProjectAccess` so project routes have already
 * cached `c.get('workspaceId')` (cheap resolve) and access is verified first.
 */

import type { Context, Next } from 'hono'
import { prisma } from '../lib/prisma'
import { RAW_REGION_ID, PRIMARY_REGION, REGION_PEERS, getPeer } from '../lib/region'
import { proxyToPeer, isProxiedRequest } from '../lib/region-peer-proxy'
import { resolveWorkspaceIdForRequest } from '../lib/resolve-workspace-id'
import { resolveUserHomeRegionUserId } from '../lib/resolve-user-id'

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

/**
 * Platform-global surfaces with no per-tenant / per-user owner (admin console,
 * global catalogs). These are pinned to the primary region so there is exactly
 * one writer. `/api/admin/regions/` is already in `SKIP_PREFIXES` (it is its own
 * cross-region proxy) and is excluded before we reach here.
 */
const PRIMARY_OWNED_PREFIXES = ['/api/admin/']

/**
 * Money-sensitive write surfaces. For these we fail *closed* (503) in `enforce`
 * mode when we can't reach the owning region, rather than the default
 * fail-open: a wrong-region write to a usage counter / wallet balance / license
 * redemption corrupts data that LWW cannot safely reconcile.
 */
const FAIL_CLOSED_PREFIXES = [
  '/api/billing',
  '/api/usage-events',
  '/api/usage-wallets',
]

function isFailClosed(path: string): boolean {
  return (
    FAIL_CLOSED_PREFIXES.some((p) => path.startsWith(p)) ||
    // redeem-license lives under /api/workspaces/:id/redeem-license
    path.includes('/redeem-license')
  )
}

/**
 * Region-affine chat surfaces. A chat turn's stream buffer lives in process
 * memory in exactly one region, and a mutating chat request (start turn via
 * `POST .../chat`, or `POST .../chat/stop`) served in the wrong region creates
 * / targets a buffer the client can never resume from. So — like money writes
 * — we fail *closed* (retryable 503) in enforce mode when the owning region is
 * unreachable, letting the P0-hardened client retry into the correct region
 * rather than silently starting a bufferless turn locally.
 *
 * Chat GET reads (`.../chat/:id/stream`, `.../chat/:id/turn`) are non-mutating
 * and never reach this router (skipped at the MUTATING_METHODS guard); they are
 * pinned separately by `apps/api/src/lib/chat-region-pin.ts`.
 */
function isAffineChatPath(path: string): boolean {
  return /^\/api\/(projects|workspaces)\/[^/]+\/chat(\/|$)/.test(path)
}

type OwnerKind = 'workspace' | 'platform' | 'identity'

interface OwnerDecision {
  targetRegion: string
  ownerKind: OwnerKind
  /** workspaceId / userId / pathname — for logging only. */
  ownerId: string
}

/**
 * Resolve which region owns the write, or null when nothing claims it (handled
 * locally). May throw on a DB error during lookup; the caller decides whether
 * that fails open or closed.
 */
async function resolveOwner(c: Context, path: string): Promise<OwnerDecision | null> {
  // 1. Workspace-owned.
  const workspaceId = await resolveWorkspaceIdForRequest(c)
  if (workspaceId) {
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { homeRegion: true },
    })
    if (!ws) return null // unknown workspace — let the handler 404 it locally.
    return {
      targetRegion: ws.homeRegion || PRIMARY_REGION,
      ownerKind: 'workspace',
      ownerId: workspaceId,
    }
  }

  // 2. Platform-global → primary region.
  if (PRIMARY_OWNED_PREFIXES.some((p) => path.startsWith(p))) {
    return { targetRegion: PRIMARY_REGION, ownerKind: 'platform', ownerId: path }
  }

  // 3. Identity-owned → the user's home region.
  const userId = await resolveUserHomeRegionUserId(c)
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { homeRegion: true },
    })
    if (!user) return null // unknown user — let the handler 404 it locally.
    return {
      targetRegion: user.homeRegion || PRIMARY_REGION,
      ownerKind: 'identity',
      ownerId: userId,
    }
  }

  return null
}

function warn(message: string, fields: Record<string, unknown>) {
  console.warn(`[home-region-router] ${message}`, fields)
}

export async function homeRegionWriteProxy(c: Context, next: Next) {
  const mode = getHomeRegionRoutingMode()
  if (mode === 'off') return next()

  // Single-region / local / desktop: nothing to route.
  if (!RAW_REGION_ID) return next()

  // No peers configured → single-region deployment (e.g. staging with
  // REGION_ID=staging and no REGION_PEERS). There is nowhere to proxy and
  // nothing to fail closed *to*, so every write is necessarily local. Without
  // this short-circuit, a workspace whose homeRegion resolves to a non-local
  // region — a legacy null row defaults to PRIMARY_REGION ('us-ashburn-1'),
  // which differs from a single-region pod's own REGION_ID — would hit an
  // affine-chat/money write, find no peer, and fail closed with a spurious
  // 503 "home region unavailable". This makes the documented single-region
  // "router is inert, every write resolves local" invariant true in code.
  if (REGION_PEERS.length === 0) return next()

  // Already proxied from a sibling region — handle it here, never re-proxy.
  if (isProxiedRequest(c)) return next()

  if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) return next()

  const path = new URL(c.req.url).pathname
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return next()

  // Money-sensitive writes and region-affine chat writes both fail closed:
  // serving them in the wrong region corrupts data (money) or strands the
  // stream buffer (chat). Everything else falls open to local on misconfig.
  const failClosed = isFailClosed(path) || isAffineChatPath(path)

  let decision: OwnerDecision | null
  try {
    decision = await resolveOwner(c, path)
  } catch (err) {
    // Couldn't determine the owner. For money-sensitive writes, refuse rather
    // than risk a wrong-region write; everything else falls open to local.
    warn('owner resolution failed', {
      path,
      failClosed,
      error: err instanceof Error ? err.message : String(err),
    })
    if (mode === 'enforce' && failClosed) {
      return c.json({ error: 'home region routing unavailable' }, 503)
    }
    return next()
  }

  // Nothing owns this write (or it's already owned here) — handle locally.
  if (!decision) return next()
  const { targetRegion, ownerKind, ownerId } = decision
  if (targetRegion === RAW_REGION_ID) return next()

  const peer = getPeer(targetRegion)
  if (!peer) {
    if (mode === 'enforce' && failClosed) {
      // No route to the owning region for a money write — fail closed.
      warn('no peer for home region; failing closed', {
        path,
        ownerKind,
        ownerId,
        homeRegion: targetRegion,
        from: RAW_REGION_ID,
      })
      return c.json({ error: 'home region unavailable' }, 503)
    }
    // We don't know how to reach the home region — fail open (local) rather
    // than 502 the user. Surfaced in logs so misconfig is visible.
    warn('no peer configured for homeRegion; handling locally', {
      path,
      ownerKind,
      ownerId,
      homeRegion: targetRegion,
      from: RAW_REGION_ID,
    })
    return next()
  }

  if (mode === 'shadow') {
    console.log('[home-region-router] would-proxy', {
      method: c.req.method,
      path,
      ownerKind,
      ownerId,
      homeRegion: targetRegion,
      from: RAW_REGION_ID,
    })
    return next()
  }

  console.log('[home-region-router] proxy', {
    method: c.req.method,
    path,
    ownerKind,
    ownerId,
    homeRegion: targetRegion,
    from: RAW_REGION_ID,
  })
  return proxyToPeer(c, targetRegion)
}
