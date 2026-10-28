// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A machine workspace the cloud has heard of but has no copy of yet.
 *
 * Since SHO-185 a machine workspace's reads are answered from the cloud copy.
 * When the copy does not exist — the first sync is still running, sync is off,
 * or it is broken — those reads found no `Workspace` row and no `Member` row and
 * answered `403 "No access to this workspace"`. That is a lie the client cannot
 * act on: the workspace is the caller's own machine's, and the fix is to read it
 * through the relay (SHO-241).
 *
 * So a 403 for a workspace id that appears in one of the caller's machine
 * snapshots is rewritten to `409 machine_copy_pending`, and the client retries
 * the read through the relay once. Doing it *after* the response keeps the happy
 * path free of extra queries: only a request that was about to fail pays for it.
 */

import type { Context, Next } from 'hono'
import { prisma } from './prisma'
import { resolveTouchedWorkspaceId } from './machine-workspace'

export const MACHINE_COPY_PENDING = 'machine_copy_pending'

/**
 * How long a pod reuses one person's pending-workspace map.
 *
 * Only consulted on a 403, but a broken copy makes *every* read a 403, so it is
 * cached: the map is small, changes only when a machine's workspace list does,
 * and 30 s is well inside the window in which a person would retry.
 */
const PENDING_TTL_MS = 30_000

const cache = new Map<string, { at: number; ids: Map<string, string> }>()

function snapshotWorkspaceIds(metadata: unknown): Array<{ id: string; instanceId: string }> {
  const workspaces = (metadata as any)?.machine?.workspaces
  if (!Array.isArray(workspaces)) return []
  return workspaces
    .filter((entry: any) => typeof entry?.id === 'string' && entry.id)
    .map((entry: any) => ({ id: entry.id as string, instanceId: String((metadata as any)?.machine?.id ?? '') }))
}

/**
 * Workspace id → machine instance id, for every workspace in this user's machine
 * snapshots. That snapshot is the machine's own list of its workspaces, which is
 * exactly the set whose rows live on the desktop rather than in the cloud.
 */
export async function pendingMachineWorkspaceIds(userId: string): Promise<Map<string, string>> {
  const cached = cache.get(userId)
  if (cached && Date.now() - cached.at < PENDING_TTL_MS) return cached.ids
  const ids = new Map<string, string>()
  try {
    const instances = (await prisma.instance.findMany({
      where: { userId },
      select: { id: true, metadata: true },
    })) as Array<{ id: string; metadata: unknown }>
    for (const instance of instances) {
      for (const entry of snapshotWorkspaceIds(instance.metadata)) {
        // The snapshot's own `machine.id` is the desktop's device id, not the
        // cloud instance id; the row it arrived on is what the relay needs.
        ids.set(entry.id, instance.id)
      }
    }
  } catch {
    return ids
  }
  cache.set(userId, { at: Date.now(), ids })
  return ids
}

/** Forget one person's map, e.g. after a copy is deleted or created. */
export function invalidatePendingMachineWorkspaceIds(userId?: string): void {
  if (userId) cache.delete(userId)
  else cache.clear()
}

/** The response body's error message, when there is one. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.clone().json()
    const message = (body as any)?.error?.message
    return typeof message === 'string' ? message : ''
  } catch {
    return ''
  }
}

/**
 * Middleware: turn "no access to this workspace" into "the copy is not here yet".
 *
 * Mounted for `/api/*` after the routes. A read is the only thing that can be
 * served another way, so writes are left alone — a write to a workspace with no
 * copy is a real error, and the machine relay's own codes already explain it.
 */
export function machineCopyPendingGuard() {
  return async (c: Context, next: Next) => {
    await next()
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return
    if (c.res.status !== 403) return
    const auth = c.get('auth') as any
    if (!auth?.userId) return

    const workspaceId = await resolveTouchedWorkspaceId(c).catch(() => null)
    if (!workspaceId) return

    const pending = await pendingMachineWorkspaceIds(auth.userId)
    const instanceId = pending.get(workspaceId)
    if (!instanceId) return

    // A row means the copy exists; then the 403 is a real permission answer and
    // is left exactly as it was.
    const exists = await prisma.workspace
      .findUnique({ where: { id: workspaceId }, select: { id: true } })
      .catch(() => null)
    if (exists) return

    const message = await errorMessage(c.res)
    // Only the two "you may not read this workspace" answers: anything else is
    // the route's own decision and must keep its wording.
    if (message && !/no access to this workspace|not a member of this workspace/i.test(message)) return

    c.res = c.json(
      {
        error: {
          code: MACHINE_COPY_PENDING,
          message:
            'This workspace lives on your machine and the cloud has no copy of it yet — read it through the machine relay',
          instanceId,
          workspaceId,
        },
      },
      409,
    )
  }
}
