// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One running copy per published site, fleet-wide.
 *
 * Each region keeps its own metal placements, so a region can't see a copy of
 * a site that another region booted. Two copies both export to the site's one
 * published-data archive and overwrite each other's writes. Published requests
 * are pinned to the workspace's home region; on top of that, the home region
 * asks every peer to retire any copy it still runs (one booted before the pin,
 * or an always-on copy that never sees another request there).
 */

import { prisma } from './prisma'
import { RAW_REGION_ID, REGION_PEERS } from './region'
import { callPeerInternal } from './region-peer-proxy'

export const PUBLISHED_RELEASE_PATH = '/api/internal/published/release'

const ASK_INTERVAL_MS = parseInt(process.env.METAL_FOREIGN_PUBLISHED_RELEASE_INTERVAL_MS || '300000', 10)
const askedAt = new Map<string, number>()

/** Ask each peer region to retire its copy of a site this region is home for. Throttled per site. */
export async function askPeersToReleasePublished(projectId: string, subdomain: string, now = Date.now()): Promise<void> {
  const last = askedAt.get(projectId)
  if (last !== undefined && now - last < ASK_INTERVAL_MS) return
  askedAt.set(projectId, now)
  await Promise.all(
    REGION_PEERS.map(async (peer) => {
      try {
        const r = await callPeerInternal(peer.id, PUBLISHED_RELEASE_PATH, { projectId, subdomain })
        if (!r.ok) console.warn(`[published] ${peer.id} refused to release ${subdomain}: HTTP ${r.status}`)
      } catch (err: any) {
        console.warn(`[published] asking ${peer.id} to release ${subdomain} failed: ${err?.message ?? err}`)
      }
    }),
  )
}

export function _resetPublishedReleaseAsks(): void {
  askedAt.clear()
}

/**
 * Peer side of `askPeersToReleasePublished`. Never releases a copy in the
 * site's home region, whoever asks. The release itself runs in the background.
 */
export async function releasePublishedForPeer(
  body: unknown,
  release: (projectId: string, subdomain: string, homeRegion: string) => Promise<unknown>,
): Promise<{ status: 202 | 400 | 404 | 409; body: Record<string, unknown> }> {
  const { projectId, subdomain } = (body ?? {}) as { projectId?: unknown; subdomain?: unknown }
  if (typeof projectId !== 'string' || typeof subdomain !== 'string' || !projectId || !subdomain) {
    return { status: 400, body: { error: 'projectId and subdomain required' } }
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { publishedSubdomain: true, workspace: { select: { homeRegion: true } } },
  })
  if (!project || project.publishedSubdomain !== subdomain) {
    return { status: 404, body: { error: 'no such published site' } }
  }
  const homeRegion = project.workspace?.homeRegion
  if (!homeRegion || homeRegion === RAW_REGION_ID) {
    return { status: 409, body: { error: 'this region is the site home region' } }
  }
  void release(projectId, subdomain, homeRegion).catch((err) =>
    console.warn(`[published] release ${subdomain} for ${homeRegion} failed: ${err?.message ?? err}`),
  )
  return { status: 202, body: { ok: true } }
}
