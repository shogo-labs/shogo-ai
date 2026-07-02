// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat-session region pinning.
 *
 * A chat turn is region-affine in a way ordinary requests are not: the
 * runtime pod that owns the turn keeps its `streamBufferStore` in process
 * memory, and the freshly-written `ChatSession` / `ChatMessage` rows are only
 * guaranteed to exist in the region that served the turn. If a follow-up
 * request (resume `/stream`, `/turn` probe, `/stop`) lands in a different
 * region — because the Cloudflare `__cflb` affinity cookie was dropped or a
 * pool health-flap re-steered the reconnect — that region has neither the
 * buffer (best case: 204) nor, until replication catches up, the project row
 * (`requireProjectAccess` → 404). That 404 is what produced the observed
 * "50-75 stream 404s/min" resume storm.
 *
 * The home-region write router (`home-region-router.ts`) only pins *mutating*
 * methods, and only when `HOME_REGION_ROUTING=enforce`. This helper pins the
 * whole chat session — including the affine GET reads — to the workspace's
 * `homeRegion`, independent of that global flag, so the buffer-owning region
 * always serves the session. It reuses `proxyToPeer` (already SSE-streaming)
 * and the loop-guard header so a proxied request is handled locally on the
 * receiving side and never ping-pongs.
 *
 * Returns a `Response` when the request was proxied (or failed closed), or
 * `null` when the caller should handle it locally.
 */

import type { Context } from 'hono'
import { prisma } from './prisma'
import { RAW_REGION_ID, getPeer } from './region'
import { proxyToPeer, isProxiedRequest } from './region-peer-proxy'

/**
 * Kill switch. Pinning is on by default in multi-region mode; set
 * `CHAT_REGION_PIN=off` (or `0` / `false`) to disable and fall back to
 * serving chat locally wherever the edge lands it.
 */
function chatRegionPinEnabled(): boolean {
  const v = (process.env.CHAT_REGION_PIN || '').toLowerCase()
  return v !== 'off' && v !== '0' && v !== 'false'
}

/** Resolve a project's workspace home region, or null if unknown. */
async function resolveProjectHomeRegion(projectId: string): Promise<string | null> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    })
    if (!project) return null
    const ws = await prisma.workspace.findUnique({
      where: { id: project.workspaceId },
      select: { homeRegion: true },
    })
    return ws?.homeRegion ?? null
  } catch (err: any) {
    console.warn(`[ChatRegionPin] home-region lookup failed for project ${projectId}:`, err?.message || err)
    return null
  }
}

/** Retryable 503 the P0 client treats as terminal-with-Retry (never a resume loop). */
function homeRegionUnavailable(c: Context, homeRegion: string): Response {
  console.warn(
    `[ChatRegionPin] home region ${homeRegion} unreachable from ${RAW_REGION_ID} — failing closed (503 retryable)`
  )
  return c.json(
    {
      error: {
        code: 'home_region_unavailable',
        message: 'Your session\'s home region is temporarily unreachable. Please retry.',
        retryable: true,
      },
    },
    503,
  )
}

/**
 * Pin a chat request to its session's home region. Call at the top of every
 * chat route forwarder (POST /chat, GET /stream, GET /turn, POST /stop).
 *
 * - Returns `null` (handle locally) when: single-region/local mode, the pin is
 *   disabled, the request is already a cross-region proxy (loop guard), the
 *   home region can't be resolved, or this region already IS the home region.
 * - Returns a streamed `proxyToPeer` `Response` when the session lives in a
 *   peer region.
 * - Returns a retryable 503 (fail closed) when the home region is known but
 *   unreachable, rather than serving a bufferless local region.
 */
export async function pinChatToHomeRegion(
  c: Context,
  projectId: string,
): Promise<Response | null> {
  // Single-region / local / desktop: nothing to pin.
  if (!RAW_REGION_ID) return null
  if (!chatRegionPinEnabled()) return null
  // Already proxied here from a sibling region — handle locally, never re-proxy.
  if (isProxiedRequest(c)) return null

  const homeRegion = await resolveProjectHomeRegion(projectId)
  // Unknown home region (missing project, lookup error, or legacy null row):
  // fall through to local handling. The local handler validates access and
  // will 404/serve as appropriate — we don't want to fail closed on an
  // unresolvable home region.
  if (!homeRegion) return null
  // We ARE the home region — serve locally (the buffer + rows live here).
  if (homeRegion === RAW_REGION_ID) return null

  // The session lives in a peer region. Fail closed if we can't reach it so
  // the client retries instead of getting a bufferless 204/404 locally.
  const peer = getPeer(homeRegion)
  if (!peer) return homeRegionUnavailable(c, homeRegion)

  console.log(
    `[ChatRegionPin] ${c.req.method} ${new URL(c.req.url).pathname} → proxying to home region ${homeRegion} (from ${RAW_REGION_ID})`
  )
  const resp = await proxyToPeer(c, homeRegion)
  // proxyToPeer returns 502 when the peer is unconfigured or the cross-region
  // fetch failed. For chat, surface that as a retryable 503 so the client's
  // hardened resume handler shows Retry rather than treating it as terminal
  // stream data.
  if (resp.status === 502) return homeRegionUnavailable(c, homeRegion)
  return resp
}
