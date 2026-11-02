// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One user (SHO-285): a paired desktop's local user *is* the cloud account.
 *
 * A desktop is created with a local user under a local id. Pairing asks the
 * cloud who the device key belongs to (`GET /api/machines/:id/identity`) and,
 * once, rewrites every reference to the local id in the desktop's SQLite to the
 * cloud id. After that both databases name the same person by the same id, the
 * rows sync without translation, and the cloud's tunnelled requests act as a
 * user the desktop has.
 *
 * The rewrite is a plain text replace over every TEXT column of every table:
 * ids are cuids/uuids, so a match is that id and nothing else, and JSON columns
 * that embed it (`parts`, `metadata`, mention lists) are covered without a list
 * of them to keep up to date. It runs in one transaction with foreign keys
 * deferred, after a `VACUUM INTO` backup next to the database.
 */

import { CHANGE_TABLE } from './triggers'

const SKIP_TABLES = new Set(['_prisma_migrations', 'sqlite_sequence', CHANGE_TABLE])

export interface AdoptResult {
  changed: boolean
  fromUserId?: string
  toUserId: string
  tables?: number
  backupPath?: string | null
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Rewrite `fromId` to `toId` in every TEXT column of the database. */
export async function rewriteUserId(prisma: any, fromId: string, toId: string): Promise<number> {
  const tables = (await prisma.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  )) as Array<{ name: string }>
  let touched = 0
  await prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON')
    for (const { name } of tables) {
      if (SKIP_TABLES.has(name)) continue
      const columns = (await tx.$queryRawUnsafe(`PRAGMA table_info(${quote(name)})`)) as Array<{
        name: string
        type: string
      }>
      const text = columns.filter((column) => /CHAR|CLOB|TEXT|JSON/i.test(column.type) || column.type === '')
      if (!text.length) continue
      let tableTouched = false
      for (const column of text) {
        const col = quote(column.name)
        const changed = await tx.$executeRawUnsafe(
          `UPDATE ${quote(name)} SET ${col} = REPLACE(${col}, ?, ?) WHERE ${col} LIKE ?`,
          fromId,
          toId,
          `%${fromId}%`,
        )
        if (Number(changed) > 0) tableTouched = true
      }
      if (tableTouched) touched++
    }
  }, { timeout: 10 * 60_000, maxWait: 60_000 })
  return touched
}

async function backup(prisma: any): Promise<string | null> {
  const url = process.env.DATABASE_URL ?? ''
  const file = url.startsWith('file:') ? url.slice('file:'.length) : null
  if (!file || file === ':memory:') return null
  const target = `${file}.pre-sho285-${Date.now()}.bak`
  try {
    await prisma.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    return target
  } catch {
    return null
  }
}

/**
 * Make this desktop's user the cloud account `cloudUserId`.
 *
 * A no-op once done (a user with that id exists). Otherwise the oldest local
 * user — the desktop's single person — takes the cloud id, and the pusher is
 * reset so its next push is a fresh snapshot under the new id.
 */
export async function adoptCloudIdentity(
  prisma: any,
  cloudUserId: string,
  log: (line: string) => void = () => {},
): Promise<AdoptResult> {
  const already = await prisma.user.findUnique({ where: { id: cloudUserId }, select: { id: true } })
  if (already) return { changed: false, toUserId: cloudUserId }
  const local = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (!local) return { changed: false, toUserId: cloudUserId }

  const backupPath = await backup(prisma)
  log(`[HostSync] adopting cloud identity: ${local.id} → ${cloudUserId} (backup: ${backupPath ?? 'none'})`)
  const tables = await rewriteUserId(prisma, local.id, cloudUserId)

  // Everything changed under a new id: the next push is a full snapshot, and
  // the change log the rewrite produced is not needed.
  await prisma.$executeRawUnsafe(`DELETE FROM ${quote(CHANGE_TABLE)}`).catch(() => {})
  await prisma.machineSyncState
    .deleteMany({ where: { NOT: { instanceId: { startsWith: 'host-feed:' } } } })
    .catch(() => {})
  log(`[HostSync] identity adopted across ${tables} table(s)`)
  return { changed: true, fromUserId: local.id, toUserId: cloudUserId, tables, backupPath }
}

/** Ask the cloud who this device key belongs to. Null when it cannot say. */
export async function fetchCloudIdentity(opts: {
  cloudUrl: string
  apiKey: string
  instanceId: string
  fetchImpl?: typeof fetch
}): Promise<{ id: string; email?: string | null; name?: string | null } | null> {
  const url = `${opts.cloudUrl.replace(/\/$/, '')}/api/machines/${encodeURIComponent(opts.instanceId)}/identity`
  try {
    const response = await (opts.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { user?: { id?: string; email?: string; name?: string } }
    return body.user?.id ? { id: body.user.id, email: body.user.email, name: body.user.name } : null
  } catch {
    return null
  }
}
