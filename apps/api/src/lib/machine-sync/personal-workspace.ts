// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One Personal workspace per account, on every device (SHO-285 Update 2).
 *
 * Before this, a person with a cloud account and two desktops had three
 * Personals: the cloud's (created at signup) and one per desktop (seeded by
 * `bootstrapLocalDatabase`, then pushed up as a hosted workspace). The cloud's
 * Personal is now *the* Personal — same id everywhere, `hostInstanceId` null,
 * synced both ways — and this module holds the two operations that make that
 * true on a device:
 *
 *   • `adoptCloudPersonal` — a signed-in desktop takes the account's Personal
 *     instead of seeding its own (called at pairing, right after
 *     `adoptCloudIdentity`).
 *   • `mergePersonalWorkspace` — a Personal that already exists on a device (or
 *     in the cloud, from before this change) is folded into the winner: every
 *     row that carries its `workspaceId` is rewritten, its workspace-root files
 *     move to `merged/<device>/`, and the empty row is removed. Nothing is
 *     deleted, and a rerun is a no-op.
 *
 * The cloud's name, agent profile and workspace-root files win (Russell,
 * 2026-11-04), so the merge never copies the duplicate's identity over.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface PersonalWorkspaceRef {
  id: string
  name: string
  slug: string
}

/**
 * Tables that carry a `workspaceId` column, read from the live database — and
 * the dialect they came from.
 *
 * The dialect is asked of the database, not of `process.env.DATABASE_URL`: a
 * test process, a script and a desktop all reach this module with whatever env
 * they happen to have, and mis-guessing it here means querying
 * `information_schema` on SQLite (or the reverse) and failing the merge. The
 * SQLite probe runs first — `sqlite_master` exists on every SQLite database and
 * nowhere else — and it is deliberately called outside the transaction below,
 * so a Postgres error on it costs nothing.
 */
async function workspaceScopedTables(db: any): Promise<{ tables: string[]; dialect: 'sqlite' | 'postgres' }> {
  try {
    const tables = (await db.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )) as Array<{ name: string }>
    const out: string[] = []
    for (const { name } of tables) {
      const columns = (await db.$queryRawUnsafe(`PRAGMA table_info("${name.replace(/"/g, '""')}")`)) as Array<{
        name: string
      }>
      if (columns.some((column) => column.name === 'workspaceId')) out.push(name)
    }
    return { tables: out, dialect: 'sqlite' }
  } catch {
    const rows = (await db.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'workspaceId'`,
    )) as Array<{ table_name: string }>
    return { tables: rows.map((row) => row.table_name), dialect: 'postgres' }
  }
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Fold `fromId` into `toId`: rewrite every row that names the duplicate, move
 * its workspace-root files under `merged/<device>/`, then remove the empty row.
 *
 * Idempotent — a second run finds no `fromId` row and does nothing.
 */
export async function mergePersonalWorkspace(
  db: any,
  opts: {
    fromId: string
    toId: string
    deviceName?: string | null
    /** Pin the duplicate's jobs here, so they keep running where they ran (SHO-285 Update 2). */
    pinToInstanceId?: string | null
    log?: (line: string) => void
  },
): Promise<{ merged: boolean; rows: number; files: number }> {
  const log = opts.log ?? (() => {})
  const { fromId, toId } = opts
  if (!fromId || !toId || fromId === toId) return { merged: false, rows: 0, files: 0 }

  const duplicate = await db.workspace.findUnique({ where: { id: fromId }, select: { id: true, kind: true } })
  if (!duplicate) return { merged: false, rows: 0, files: 0 }
  const winner = await db.workspace.findUnique({ where: { id: toId }, select: { id: true } })
  if (!winner) return { merged: false, rows: 0, files: 0 }

  // Heartbeat placement hangs off the project, not the workspace, so the ids
  // have to be read before the rewrite moves them.
  const projectIds = (
    (await db.project.findMany({ where: { workspaceId: fromId }, select: { id: true } })) as Array<{ id: string }>
  ).map((row) => row.id)

  const { tables, dialect } = await workspaceScopedTables(db)
  let rows = 0
  await db.$transaction(async (tx: any) => {
    if (dialect === 'sqlite') await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON')
    // A job keeps running where it was requested: anything the duplicate had
    // without an explicit placement was running on this device (a merge only
    // happens because a device pushed the duplicate up), so it is pinned here
    // rather than silently moving to the cloud.
    if (opts.pinToInstanceId) {
      await tx.agentSchedule.updateMany({
        where: { workspaceId: fromId, runOnInstanceId: null },
        data: { runOnInstanceId: opts.pinToInstanceId },
      })
      if (projectIds.length) {
        await tx.agentConfig.updateMany({
          where: { projectId: { in: projectIds }, runOnInstanceId: null },
          data: { runOnInstanceId: opts.pinToInstanceId },
        })
      }
    }
    // The duplicate's members go first: rewriting them would leave two member
    // rows for the same person on the winner, and the winner already has the
    // owner (a Personal has no other members).
    await tx.member.deleteMany({ where: { workspaceId: fromId } })
    for (const table of tables) {
      // `workspaces` itself is handled below: its id is the thing being merged,
      // not a reference to it.
      if (table === 'workspaces' || table === 'members') continue
      const changed = await tx.$executeRawUnsafe(
        `UPDATE ${quote(table)} SET "workspaceId" = ? WHERE "workspaceId" = ?`,
        toId,
        fromId,
      )
      rows += Number(changed) || 0
    }
    await tx.workspaceAgentProfile.deleteMany({ where: { workspaceId: fromId } }).catch(() => {})
    await tx.workspace.delete({ where: { id: fromId } })
  }, { timeout: 10 * 60_000, maxWait: 60_000 })

  const files = moveWorkspaceRoot(fromId, toId, opts.deviceName ?? 'device')
  log(`[Personal] merged ${fromId} into ${toId}: ${rows} row(s), ${files} file(s)`)
  return { merged: true, rows, files }
}

/**
 * The duplicate's workspace root (`AGENTS.md`, `MEMORY.md`, `memory/`, skills)
 * goes to `merged/<device>/` inside the winner's root. The cloud's files win, so
 * nothing is overwritten — a name that already exists gets a numeric suffix.
 */
function moveWorkspaceRoot(fromId: string, toId: string, deviceName: string): number {
  const roots = workspaceRoots()
  if (!roots.length) return 0
  let moved = 0
  for (const root of roots) {
    const from = path.join(root, fromId)
    const to = path.join(root, toId, 'merged', safeSegment(deviceName))
    if (!fs.existsSync(from)) continue
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from)) {
      const source = path.join(from, entry)
      let target = path.join(to, entry)
      let suffix = 1
      while (fs.existsSync(target)) {
        target = path.join(to, `${entry}.${suffix++}`)
      }
      try {
        fs.renameSync(source, target)
        moved++
      } catch {
        // A cross-device rename fails; copy then remove.
        try {
          fs.cpSync(source, target, { recursive: true })
          fs.rmSync(source, { recursive: true, force: true })
          moved++
        } catch {
          /* leave it: a file we cannot move is not worth failing the merge */
        }
      }
    }
    try {
      fs.rmdirSync(from)
    } catch {
      /* not empty, or already gone */
    }
  }
  return moved
}

function safeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'device'
}

/** Where workspace roots live, in the order the runtime looks for them. */
function workspaceRoots(): string[] {
  const roots: string[] = []
  const configured = process.env.SHOGO_WORKSPACE_ROOTS
  if (configured) roots.push(...configured.split(path.delimiter).filter(Boolean))
  const cwd = process.cwd()
  roots.push(path.join(cwd, '.workspace-roots'), path.join(cwd, '..', '.workspace-roots'))
  return [...new Set(roots)].filter((root) => fs.existsSync(root))
}

/**
 * Fold every duplicate Personal in a database into the account's Personal.
 *
 * This is the cloud-side half of the merge (SHO-285 Update 2): prod already has
 * accounts with a cloud Personal plus one hosted Personal per desktop, and the
 * desktops that created them are not going to re-pair on their own. Idempotent —
 * a second run finds one Personal per account and does nothing.
 */
export async function mergeDuplicatePersonals(
  db: any,
  opts: { log?: (line: string) => void; dryRun?: boolean } = {},
): Promise<Array<{ userId: string; winner: string; merged: string[] }>> {
  const log = opts.log ?? (() => {})
  const personals = (await db.workspace.findMany({
    where: { kind: 'personal' },
    select: { id: true, name: true, createdAt: true, personalOwnerId: true, hostInstanceId: true },
    orderBy: { createdAt: 'asc' },
  })) as Array<{
    id: string
    name: string
    createdAt: Date
    personalOwnerId: string | null
    hostInstanceId: string | null
  }>

  const byOwner = new Map<string, typeof personals>()
  for (const personal of personals) {
    const owner = personal.personalOwnerId ?? (await ownerOf(db, personal.id))
    if (!owner) continue
    const list = byOwner.get(owner) ?? []
    list.push(personal)
    byOwner.set(owner, list)
  }

  const results: Array<{ userId: string; winner: string; merged: string[] }> = []
  for (const [userId, list] of byOwner) {
    if (list.length < 2) continue
    // The cloud's Personal wins (Russell, 2026-11-04): the one the unique index
    // already names, else the oldest.
    const winner = list.find((row) => row.personalOwnerId) ?? list[0]
    const merged: string[] = []
    for (const duplicate of list) {
      if (duplicate.id === winner.id) continue
      if (opts.dryRun) {
        merged.push(duplicate.id)
        continue
      }
      const result = await mergePersonalWorkspace(db, {
        fromId: duplicate.id,
        toId: winner.id,
        deviceName: duplicate.name,
        // A hosted Personal's jobs ran on the desktop that hosted it, so they
        // stay there rather than silently moving to the cloud.
        pinToInstanceId: duplicate.hostInstanceId,
        log,
      })
      if (result.merged) merged.push(duplicate.id)
    }
    if (!winner.personalOwnerId && !opts.dryRun) {
      await db.workspace.update({ where: { id: winner.id }, data: { personalOwnerId: userId } }).catch(() => {})
    }
    if (merged.length) results.push({ userId, winner: winner.id, merged })
  }
  return results
}

/** The owner of a workspace, from its owner member row. */
async function ownerOf(db: any, workspaceId: string): Promise<string | null> {
  const member = await db.member.findFirst({
    where: { workspaceId, role: 'owner' },
    select: { userId: true },
  })
  return member?.userId ?? null
}

/**
 * A signed-in desktop takes the account's Personal instead of seeding one.
 *
 * Creates the row locally when it is not here yet (same id, same slug, same
 * name — the cloud's), then folds any Personal this device already had into it.
 * Returns the id the device should treat as its Personal.
 */
export async function adoptCloudPersonal(
  prisma: any,
  personal: PersonalWorkspaceRef,
  opts: { userId: string; deviceName?: string | null; instanceId?: string | null; log?: (line: string) => void },
): Promise<{ id: string; created: boolean; merged: string[] }> {
  const log = opts.log ?? (() => {})
  const existing = await prisma.workspace.findUnique({ where: { id: personal.id }, select: { id: true } })
  let created = false
  if (!existing) {
    await prisma.workspace.create({
      data: {
        id: personal.id,
        name: personal.name,
        slug: personal.slug,
        kind: 'personal',
        personalOwnerId: opts.userId || null,
        hostInstanceId: null,
      },
    })
    created = true
    log(`[Personal] adopted the account's Personal ${personal.id}`)
  }
  if (opts.userId) {
    await prisma.member
      .create({
        data: { userId: opts.userId, workspaceId: personal.id, role: 'owner', isBillingAdmin: true },
      })
      .catch(() => {})
  }

  // Every other Personal on this device is a duplicate of the account's.
  const duplicates = (await prisma.workspace.findMany({
    where: { kind: 'personal', NOT: { id: personal.id } },
    select: { id: true },
  })) as Array<{ id: string }>
  const merged: string[] = []
  for (const duplicate of duplicates) {
    const result = await mergePersonalWorkspace(prisma, {
      fromId: duplicate.id,
      toId: personal.id,
      deviceName: opts.deviceName ?? null,
      pinToInstanceId: opts.instanceId ?? null,
      log,
    })
    if (result.merged) merged.push(duplicate.id)
  }
  return { id: personal.id, created, merged }
}
