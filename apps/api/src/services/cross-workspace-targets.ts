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
 * `reachable` is about the *transport this API can use*. A cloud API reaches a
 * workspace hosted on a paired desktop over that host's tunnel (SHO-493): the
 * workspace is `source: 'desktop'`, `reachable: true`, and carries its `host`
 * so a report can name the machine and say whether it is online. The host being
 * offline is **reported**, not used as a gate — the call itself wakes the
 * tunnel and the API answers `device_offline` only when that wake fails. A
 * desktop's own API cannot forward like that, so for it a hosted workspace is
 * `reachable: false` with `unreachableReason: 'desktop_hosted'` — never silently
 * omitted, so a report can say it skipped one and why.
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
  /**
   * The paired desktop whose compute the workspace lives on, when the API can
   * forward to it (cloud mode). Reported so a call that comes back
   * `device_offline` can name the machine and its last-seen time.
   */
  host?: CrossWorkspaceTargetHost
}

export interface CrossWorkspaceTargetHost {
  instanceId: string
  name: string | null
  /** The instance's own last heartbeat, not this call's reachability. */
  online: boolean
  lastSeenAt: string | null
}

/**
 * How stale an instance's `lastSeenAt` may be and still count as online. The
 * same two-minute window `GET /api/internal/devices` uses, so the two answers
 * about the same machine cannot disagree.
 */
const HOST_FRESH_MS = 2 * 60_000

function hostSummary(
  instance: { id: string; name: string | null; status: string; lastSeenAt: Date | null } | undefined,
): CrossWorkspaceTargetHost | undefined {
  if (!instance) return undefined
  const lastSeenAt = instance.lastSeenAt ? new Date(instance.lastSeenAt) : null
  return {
    instanceId: instance.id,
    name: instance.name ?? null,
    online: instance.status === 'online' && !!lastSeenAt && lastSeenAt.getTime() > Date.now() - HOST_FRESH_MS,
    lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
  }
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
  // One read for every host, not one per row: the list is built on every
  // `workspace` resolution, and a person may have a dozen workspaces.
  const hostInstanceIds = [...new Set(rows.map((row) => row.hostInstanceId).filter(Boolean))] as string[]
  const hostRows: Array<{ id: string; name: string | null; status: string; lastSeenAt: Date | null }> =
    hostInstanceIds.length
      ? await db.instance
          .findMany({
            where: { id: { in: hostInstanceIds } },
            select: { id: true, name: true, status: true, lastSeenAt: true },
          })
          .catch(() => [])
      : []
  const hosts = new Map(hostRows.map((row) => [row.id, row]))
  for (const row of rows) {
    const host = row.hostInstanceId ? hostSummary(hosts.get(row.hostInstanceId)) : undefined
    targets.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      kind: row.kind === 'personal' ? 'personal' : 'team',
      // This API answers a workspace directly when its compute is here: the
      // desktop's SQLite workspaces locally, the cloud's own pods there. A
      // workspace hosted on a paired desktop is reached over that host's
      // tunnel from the cloud — and not at all from a desktop's own API.
      source: row.hostInstanceId ? 'desktop' : localMode ? 'local' : 'cloud',
      reachable: !row.hostInstanceId || !localMode,
      ...(row.hostInstanceId && localMode
        ? { unreachableReason: 'desktop_hosted' as const }
        : {}),
      ...(host ? { host } : {}),
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
