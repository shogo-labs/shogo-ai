// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which workspaces one person can reach, for the Personal workspace agent
 * (SHO-389).
 *
 * `resolveTargetWorkspace` in the agent runtime needs this to turn "Samsara
 * Game" into an id without asking the model to guess, and the agent needs it to
 * answer "what is going on in my other workspaces" without one tool call per
 * workspace name it can imagine. The list is the person's own: their
 * memberships, whether each workspace's compute is local, in the cloud, or on a
 * paired desktop.
 *
 * `reachable` is about the *transport this API can use*: a cloud API cannot
 * reach a workspace whose compute is a desktop it does not currently have a
 * tunnel for. Those are reported with `source: 'desktop'` and
 * `reachable: false` rather than silently omitted, so a report can say it
 * skipped one and why.
 */

import { prisma } from '../lib/prisma'

const db = prisma as any

export interface CrossWorkspaceTarget {
  id: string
  name: string
  slug: string | null
  kind: 'personal' | 'team'
  source: 'local' | 'cloud' | 'desktop'
  reachable: boolean
  /** Set when `reachable` is false: why this API can't act there. */
  unreachableReason?: 'cloud_signed_out' | 'cloud_unreachable' | 'desktop_hosted'
}

/**
 * Every workspace `userId` belongs to, plus one flagged as the caller so a
 * report can skip the workspace it is running in.
 */
export async function listCrossWorkspaceTargets(
  userId: string,
  callerWorkspaceId: string,
): Promise<CrossWorkspaceTarget[]> {
  const rows: Array<{ id: string; name: string; slug: string | null; kind: string; hostInstanceId: string | null }> =
    await db.workspace
      .findMany({
        where: {
          OR: [{ members: { some: { userId } } }, { personalOwnerId: userId }],
          movedToWorkspaceId: null,
        },
        select: { id: true, name: true, slug: true, kind: true, hostInstanceId: true },
        orderBy: { createdAt: 'asc' },
      })
      .catch(() => [])

  const targets = new Map<string, CrossWorkspaceTarget>()
  const localMode = process.env.SHOGO_LOCAL_MODE === 'true'
  for (const row of rows) {
    targets.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      kind: row.kind === 'personal' ? 'personal' : 'team',
      // This API answers a workspace directly when its compute is here: the
      // desktop's SQLite workspaces locally, the cloud's own pods there. A
      // workspace hosted on a paired desktop is elsewhere.
      source: row.hostInstanceId ? 'desktop' : localMode ? 'local' : 'cloud',
      reachable: !row.hostInstanceId,
      ...(row.hostInstanceId
        ? { unreachableReason: 'desktop_hosted' as const }
        : {}),
    })
  }

  // A signed-in desktop also belongs to cloud workspaces it doesn't have rows
  // for; the cloud knows its own members and answers the same question itself.
  if (localMode && userId) {
    const { listCloudWorkspaces } = await import('./cloud-workspaces')
    const cloud = await listCloudWorkspaces().catch(() => null)
    for (const ws of cloud?.workspaces ?? []) {
      if (targets.has(ws.id)) continue
      targets.set(ws.id, {
        id: ws.id,
        name: ws.name,
        slug: ws.slug,
        kind: ws.kind,
        source: 'cloud',
        reachable: cloud?.reachable ?? true,
        ...(cloud?.reachable ? {} : { unreachableReason: 'cloud_unreachable' as const }),
      })
    }
  }

  // Stable, readable order: the caller first, then by name.
  return [...targets.values()].sort((a, b) => {
    if (a.id === callerWorkspaceId) return -1
    if (b.id === callerWorkspaceId) return 1
    return a.name.localeCompare(b.name)
  })
}
