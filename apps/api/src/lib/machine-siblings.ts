// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One machine, one `instances` row (SHO-241 §C).
 *
 * The cloud files a machine under the workspace its device key was issued in, so
 * before SHO-241 a desktop opened one tunnel per stored key and held one row per
 * workspace it was signed into — nine rows, nine heartbeats and nine sockets for
 * one Mac, and a `/machines` id that changed every few seconds. Desktops now open
 * a single tunnel; this retires the rows older ones left behind the first time
 * each machine heartbeats, so the fleet converges without a desktop update.
 *
 * Nothing is dropped: a sibling may be the row that owns the cloud copy (the
 * pusher resolved its id from whichever tunnel answered first), so its mirror
 * rows and sync state move to the row we keep.
 */
import { prisma, InstanceKind, type InstanceKind as InstanceKindType } from './prisma'
import { duplicateMachineRowIds } from './instance-identity'

/**
 * Machines already swept in this process.
 *
 * A viewed desktop heartbeats every 5 s; the sweep is a findMany plus (usually)
 * nothing, but it does not need to run 17,000 times a day per machine. Once a
 * machine has been swept there is nothing left to find — a row is only created
 * again by a desktop that still fans out, and `/machines` groups those anyway.
 */
const swept = new Set<string>()

/** Test seam: forget which machines were swept. */
export function _resetMachineSiblingSweep(): void {
  swept.clear()
}

export interface RetireResult {
  /** Rows deleted. Zero is the normal answer for a machine that is up to date. */
  retired: number
}

/**
 * Delete this machine's sibling rows, keeping `instanceId`.
 *
 * Runs once per process per machine; see `swept`.
 */
export async function retireMachineSiblings(params: {
  instanceId: string
  workspaceId: string
  userId: string | null
  hostname: string
  kind: InstanceKindType
  /** Stable per-machine id: the real identity of a desktop row (SHO-276). */
  deviceId?: string | null
  /** The heartbeat's metadata, for the pre-device-id duplicates. */
  metadata?: unknown
}): Promise<RetireResult> {
  const { instanceId, workspaceId, userId, hostname, kind, deviceId, metadata } = params
  if (!userId || (!hostname && !deviceId)) return { retired: 0 }

  // Keyed on the machine, not the hostname: a hostname-keyed sweep is blind to
  // the duplicate a *rename* created, which is exactly the row that keeps every
  // push refused `409 mirror_ownership` (SHO-276).
  const key = `${userId}\u0000${deviceId ?? hostname}\u0000${kind}`
  if (swept.has(key)) return { retired: 0 }

  const siblings = await prisma.instance.findMany({
    where: {
      userId,
      kind,
      id: { not: instanceId },
      // A `cli_worker` is a workspace's dev box, not the person's machine: the
      // same host running one in two workspaces is two registrations, and both
      // stay. Only a desktop's rows are one machine.
      ...(kind === InstanceKind.cli_worker ? { workspaceId } : {}),
      ...(deviceId ? { OR: [{ deviceId }, { hostname }] } : { hostname }),
    },
    select: { id: true, metadata: true },
  })
  const duplicateIds = await duplicateMachineRowIds({
    tx: prisma,
    instanceId,
    workspaceId,
    userId,
    kind: kind as string,
    deviceId: deviceId ?? null,
    metadata,
  })
  const ids = [...new Set([...siblings.map((row) => row.id), ...duplicateIds])]
  // Nothing to do: remember it so the next heartbeat goes straight to its answer.
  if (!ids.length) {
    swept.add(key)
    return { retired: 0 }
  }

  await prisma.$transaction(async (tx) => {
    // A project pinned to a sibling keeps its machine, not a dangling id.
    await tx.project.updateMany({
      where: { preferredInstanceId: { in: ids } },
      data: { preferredInstanceId: instanceId },
    })

    // A machine workspace is marked by the row that made it (`machineInstanceId`
    // has no FK, so nothing re-points it for us). Left alone it names the row we
    // are about to delete: the client then builds relay paths from a dead id and
    // every write retries into a 404.
    await tx.workspace.updateMany({
      where: { machineInstanceId: { in: ids } },
      data: { machineInstanceId: instanceId },
    })

    // (instanceId, pushToken) is unique, so a token this row already has would
    // collide on the re-point: those duplicates go rather than the survivor.
    const kept = await tx.pushSubscription.findMany({
      where: { instanceId },
      select: { pushToken: true },
    })
    const keptTokens = new Set(kept.map((row) => row.pushToken))
    if (keptTokens.size) {
      const siblingSubs = await tx.pushSubscription.findMany({
        where: { instanceId: { in: ids } },
        select: { id: true, pushToken: true },
      })
      const duplicates = siblingSubs
        .filter((row) => keptTokens.has(row.pushToken))
        .map((row) => row.id)
      if (duplicates.length) {
        await tx.pushSubscription.deleteMany({ where: { id: { in: duplicates } } })
      }
    }
    await tx.pushSubscription.updateMany({
      where: { instanceId: { in: ids } },
      data: { instanceId },
    })

    await tx.remoteAction.updateMany({
      where: { instanceId: { in: ids } },
      data: { instanceId },
    })

    // The copy moves with the row: mirror rows keep their (model, recordId), and
    // the sync state moves only when the kept row has none — two states for one
    // machine is a copy the desktop would have to choose between.
    await tx.machineMirrorRow.updateMany({
      where: { instanceId: { in: ids } },
      data: { instanceId },
    })
    const keptState = await tx.machineSyncState.findUnique({ where: { instanceId } })
    if (!keptState) {
      const best = await tx.machineSyncState.findFirst({
        where: { instanceId: { in: ids } },
        orderBy: [{ lastIngestAt: 'desc' }, { cursor: 'desc' }],
      })
      if (best) {
        await tx.machineSyncState.create({
          data: {
            instanceId,
            epoch: best.epoch,
            cursor: best.cursor,
            lastIngestAt: best.lastIngestAt,
            enabled: best.enabled,
          },
        })
      }
    } else {
      // Keep whichever of the two has the freshest accepted copy.
      const best = await tx.machineSyncState.findFirst({
        where: { instanceId: { in: ids }, lastIngestAt: { not: null } },
        orderBy: { lastIngestAt: 'desc' },
      })
      if (best?.lastIngestAt && (!keptState.lastIngestAt || best.lastIngestAt > keptState.lastIngestAt)) {
        await tx.machineSyncState.update({
          where: { instanceId },
          data: { epoch: best.epoch, cursor: best.cursor, lastIngestAt: best.lastIngestAt },
        })
      }
    }
    await tx.machineSyncState.deleteMany({ where: { instanceId: { in: ids } } })

    await tx.instance.deleteMany({ where: { id: { in: ids } } })
  })

  swept.add(key)
  console.log(
    `[Instances] Retired ${ids.length} extra row(s) for ${hostname} — one machine, one heartbeat`,
  )
  return { retired: ids.length }
}
