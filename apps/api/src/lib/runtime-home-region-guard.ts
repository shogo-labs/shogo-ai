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

import type { Context } from 'hono'
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

/**
 * 409 for a request that reached a region which may not run its workspace's
 * runtime. Routes that resolve a runtime are proxied to the home region
 * first, so this only answers callers nothing pinned.
 */
export function runtimeNotInHomeRegionResponse(c: Context, err: RuntimeNotInHomeRegionError): Response {
  return c.json(notInHomeRegionBody(err), 409)
}

function notInHomeRegionBody(err: RuntimeNotInHomeRegionError) {
  return {
    error: {
      code: err.code,
      message: `This workspace is served from ${err.homeRegion}; retry against that region.`,
      homeRegion: err.homeRegion,
      region: err.region,
    },
  }
}

/**
 * The same 409, for the pre-Hono WebSocket bridges (terminal PTY, port tunnel,
 * preview). They are upgraded in `server.ts` before Hono runs, so they cannot be
 * proxied to the home region and have no `Context` to answer through — they used
 * to reply a bare `503 Runtime unavailable`, which a client cannot tell apart
 * from a host that is merely down, so one workspace retried a terminal session
 * against the wrong region forever (3105 rows / 24h). Same body as the HTTP
 * contract, so a client already handling `runtime_not_in_home_region` on REST
 * needs no second code path — it just has to reconnect to `homeRegion`.
 */
export function runtimeNotInHomeRegionUpgradeResponse(err: RuntimeNotInHomeRegionError): Response {
  return Response.json(notInHomeRegionBody(err), { status: 409 })
}

/**
 * Is this error the guard's refusal, whichever module instance produced it?
 *
 * The WebSocket bridges import the guard lazily inside their catch blocks, while
 * `server.ts` imports it at module load. Two instances of the module (a second
 * copy in the graph, a query-string import in a test) make `instanceof` silently
 * false — which is exactly how this path answered `503` for months. Match the
 * documented `code` too, and require the fields the 409 body needs.
 */
export function isNotInHomeRegion(err: unknown): err is RuntimeNotInHomeRegionError {
  if (err instanceof RuntimeNotInHomeRegionError) return true
  if (!err || typeof err !== 'object') return false
  const e = err as Partial<RuntimeNotInHomeRegionError>
  return (
    e.code === 'runtime_not_in_home_region' &&
    typeof e.homeRegion === 'string' &&
    typeof e.region === 'string'
  )
}

/**
 * Which origin a workspace's runtime is reachable on, from this pod's point of
 * view: its own when the workspace is homed here (or has no home region at all —
 * legacy rows and single-region mode), the peer's URL when it is homed in a
 * known peer, and its own again when the home region is not a configured peer
 * (nowhere to defer to, so the local answer is the only one there is).
 *
 * Pure so the decision can be tested without booting `server.ts`.
 */
export function runtimeOriginFor(
  homeRegion: string | null,
  opts: {
    region?: string | null
    selfOrigin: string
    peerUrl?: (regionId: string) => string | undefined
  },
): string {
  const region = 'region' in opts ? opts.region : RAW_REGION_ID
  if (!homeRegion || homeRegion === region) return opts.selfOrigin
  return opts.peerUrl?.(homeRegion) ?? opts.selfOrigin
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

/**
 * A workspace's home region (cached), or null when it has none — a legacy row,
 * or single-region mode. Read by `GET /api/projects/:projectId/runtime-origin`
 * so a client that cannot be proxied (the terminal WebSocket) can learn which
 * origin to reconnect to.
 */
export function getWorkspaceHomeRegion(workspaceId: string): Promise<string | null> {
  return cachedWorkspaceHomeRegion(workspaceId)
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
