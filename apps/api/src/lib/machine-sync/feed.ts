// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read side of the cloud → desktop change feed (SHO-285).
 *
 * `GET /api/machines/:id/changes?cursor=N` answers the `HostSyncChange` entries
 * after `N` for the workspaces that machine hosts, with each changed row's
 * *current* state (so a row written three times is sent once), in the same
 * parents-first order the pusher uses. Rows the desktop may not have yet —
 * a teammate's `User` row named by a message — come along, ahead of the rows
 * that point at them.
 */

import { foreignKeys } from './schema-model'
import { MIRROR_MODELS, delegateName, rewrittenFields } from './models'
import { loadMetadata } from './ingest'

/**
 * An entry is served only once it is this old, so a change logged by a write
 * whose transaction has not committed yet is not read before it is visible.
 */
const SETTLE_MS = Math.max(0, Number(process.env.SHOGO_HOST_FEED_SETTLE_MS ?? 1_500) || 0)
const DEFAULT_LIMIT = 500
/** Entries kept after they are served; the desktop acks by asking past them. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface HostFeedPage {
  cursor: number
  more: boolean
  /** The desktop's user is this cloud account (one user, SHO-285). */
  userId: string
  models: Array<{ model: string; rows: Array<Record<string, unknown>> }>
  deletes: Array<{ model: string; recordId: string }>
}

const USER_FIELDS = { id: true, name: true, email: true, image: true, createdAt: true, updatedAt: true }

export async function readHostFeed(
  db: any,
  opts: { instanceId: string; ownerUserId: string; cursor: number; limit?: number; now?: number },
): Promise<HostFeedPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), 2_000)
  // The workspaces this desktop hosts, plus the account's Personal (SHO-285
  // Update 2): the Personal is the cloud's row on every surface, so it comes
  // down to each device the same way a hosted workspace's rows do.
  const hosted = (
    (await db.workspace.findMany({
      where: {
        OR: [{ hostInstanceId: opts.instanceId }, { personalOwnerId: opts.ownerUserId }],
      },
      select: { id: true },
    })) as Array<{ id: string }>
  ).map((row) => row.id)
  const empty: HostFeedPage = { cursor: opts.cursor, more: false, userId: opts.ownerUserId, models: [], deletes: [] }
  if (!hosted.length) return empty

  const settledBefore = new Date((opts.now ?? Date.now()) - SETTLE_MS)
  const entries = (await db.hostSyncChange.findMany({
    where: { workspaceId: { in: hosted }, id: { gt: opts.cursor }, createdAt: { lt: settledBefore } },
    orderBy: { id: 'asc' },
    take: limit + 1,
  })) as Array<{ id: number; model: string; recordId: string; op: string }>
  const more = entries.length > limit
  const page = entries.slice(0, limit)
  if (!page.length) return empty

  // The last word on each row wins: an upsert then a delete is a delete.
  const last = new Map<string, { model: string; recordId: string; op: string }>()
  for (const entry of page) last.set(`${entry.model}\u0000${entry.recordId}`, entry)

  const upserts = new Map<string, string[]>()
  const deletes: HostFeedPage['deletes'] = []
  for (const entry of last.values()) {
    if (entry.op === 'delete') {
      deletes.push({ model: entry.model, recordId: entry.recordId })
    } else {
      const ids = upserts.get(entry.model) ?? []
      ids.push(entry.recordId)
      upserts.set(entry.model, ids)
    }
  }

  const meta = loadMetadata()
  const models: HostFeedPage['models'] = []
  const userIds = new Set<string>()
  for (const model of MIRROR_MODELS) {
    const ids = upserts.get(model)
    if (!ids?.length) continue
    const rows = (await db[delegateName(model)].findMany({ where: { id: { in: ids } } })) as Array<
      Record<string, unknown>
    >
    if (!rows.length) continue
    const strip = rewrittenFields(model)
    const parsed = meta.get(model)?.model
    const userColumns = parsed
      ? foreignKeys(parsed)
          .filter((fk) => fk.to === 'User.id')
          .map((fk) => fk.from.split('.')[1])
      : []
    for (const row of rows) {
      for (const field of strip) delete row[field]
      for (const column of userColumns) {
        const value = row[column]
        if (typeof value === 'string' && value) userIds.add(value)
      }
    }
    models.push({ model, rows })
  }

  if (userIds.size) {
    const users = (await db.user.findMany({ where: { id: { in: [...userIds] } }, select: USER_FIELDS })) as Array<
      Record<string, unknown>
    >
    if (users.length) models.unshift({ model: 'User', rows: users })
  }

  return { cursor: page[page.length - 1].id, more, userId: opts.ownerUserId, models, deletes }
}

/** Drop served entries past retention. Cheap and idempotent; called now and then. */
export async function pruneHostFeed(db: any, now = Date.now()): Promise<number> {
  const result = await db.hostSyncChange.deleteMany({ where: { createdAt: { lt: new Date(now - RETENTION_MS) } } })
  return result.count ?? 0
}
