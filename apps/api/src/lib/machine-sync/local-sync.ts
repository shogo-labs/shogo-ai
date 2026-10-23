// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Starts and stops the machine copy on the desktop (SHO-185).
 *
 * Kept apart from `local-server.ts` so the app composer stays a list of what
 * runs, and so a test can drive the same wiring without booting a server.
 *
 * Two pieces:
 *   • **`MachineSyncPusher`** — installs the change-log triggers and pushes
 *     rows to the cloud over HTTPS, off every request path.
 *   • **`x-shogo-sync-seq`** — a response header on the desktop's own mutations
 *     carrying the change-log position after the write, so the cloud can wait the
 *     few milliseconds for the copy to catch up before answering the Studio.
 *     That is what makes read-your-writes work for a machine workspace.
 */

import type { MiddlewareHandler } from 'hono'
import { prisma } from '../prisma'
import { getShogoCloudUrl } from '../cloud-urls'
import { getInstanceId } from '../instance-tunnel'
import { MachineSyncPusher } from './pusher'

let pusher: MachineSyncPusher | null = null

export function getMachineSyncPusher(): MachineSyncPusher | null {
  return pusher
}

/**
 * Start the pusher. A no-op without a device key: an unpaired desktop has no
 * copy to keep, and asking for one would only log noise.
 */
export async function startMachineSync(): Promise<void> {
  if (!process.env.SHOGO_API_KEY) return
  if (pusher) return
  pusher = new MachineSyncPusher({
    prisma,
    getCloudUrl: () => getShogoCloudUrl(),
    getApiKey: () => process.env.SHOGO_API_KEY ?? null,
    // The instance row is created by the first heartbeat, so this stays null
    // for the first second or two of a launch; the pusher waits.
    getInstanceId: () => getInstanceId(),
  })
  await pusher.start()
}

export function stopMachineSync(): void {
  pusher?.stop()
  pusher = null
}

/**
 * The position of the change log *after* a mutation.
 *
 * Read after the handler runs, so the sequence covers the write. One indexed
 * `SELECT max(seq)`; the alternative — every route remembering to stamp a
 * header — is the kind of thing that silently stops being true.
 */
export async function currentSyncSeq(): Promise<number> {
  try {
    const row = await (prisma as any).machineSyncChange.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    return row?.seq ?? 0
  } catch {
    // No change-log table (an old database mid-migration): no header rather
    // than a broken response.
    return 0
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Stamp `x-shogo-sync-seq` on a mutation, then let the desktop push it. */
export function machineSyncSeqHeader(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (!MUTATING.has(c.req.method)) return
    if (c.res.status >= 400) return
    const seq = await currentSyncSeq()
    if (seq > 0) c.header('x-shogo-sync-seq', String(seq))
    // Nudge the pusher so the cloud copy is fresh before the Studio reads it.
    void pusher?.syncNow().catch(() => {})
  }
}
