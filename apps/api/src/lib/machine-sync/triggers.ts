// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Change capture for the machine copy (SHO-185).
 *
 * SQLite triggers, not a Prisma extension: a Prisma `$extends` hook only sees
 * the calls this process makes through Prisma, so `updateMany`, `deleteMany` and
 * `$executeRaw` — all of which the desktop uses — would change rows nobody
 * recorded. A trigger sees whatever the write path is.
 *
 * The triggers write `(model, recordId, op)` into `machine_sync_changes`. They
 * are installed at boot, idempotently, and are cheap: one insert per changed
 * row. The pusher coalesces by row and prunes acked changes, so the table stays
 * small.
 */

import { MIRROR_MODELS } from './models'
import { MODEL_TABLE } from './tables'

/** The change log table, written only by triggers and the pusher. */
export const CHANGE_TABLE = 'machine_sync_changes'

export function triggerName(model: string, event: 'insert' | 'update' | 'delete'): string {
  return `shogo_sync_${MODEL_TABLE[model]}_${event}`
}

/**
 * The three triggers for one model. Ids are the desktop's own, so a trigger
 * never has to look anything up.
 */
export function triggerStatements(model: string): string[] {
  const table = MODEL_TABLE[model]
  const insertRow = (op: string, id: string) =>
    `INSERT INTO "${CHANGE_TABLE}" ("model", "recordId", "op") VALUES ('${model}', ${id}, '${op}');`
  return [
    `CREATE TRIGGER IF NOT EXISTS "${triggerName(model, 'insert')}" AFTER INSERT ON "${table}" BEGIN ${insertRow('upsert', 'NEW."id"')} END`,
    `CREATE TRIGGER IF NOT EXISTS "${triggerName(model, 'update')}" AFTER UPDATE ON "${table}" BEGIN ${insertRow('upsert', 'NEW."id"')} END`,
    `CREATE TRIGGER IF NOT EXISTS "${triggerName(model, 'delete')}" AFTER DELETE ON "${table}" BEGIN ${insertRow('delete', 'OLD."id"')} END`,
  ]
}

export interface TriggerInstallResult {
  installed: number
  skipped: string[]
}

/**
 * Create the triggers. A model whose table is missing is skipped, not fatal:
 * an older database mid-migration should still boot, and the next start
 * installs what it now can.
 */
export async function installSyncTriggers(
  prisma: { $executeRawUnsafe: (sql: string) => Promise<unknown> },
  log: (message: string) => void = () => {},
): Promise<TriggerInstallResult> {
  let installed = 0
  const skipped: string[] = []
  for (const model of MIRROR_MODELS) {
    try {
      for (const statement of triggerStatements(model)) {
        await prisma.$executeRawUnsafe(statement)
        installed++
      }
    } catch (err) {
      skipped.push(`${model}: ${(err as Error).message}`)
    }
  }
  if (skipped.length) {
    log(`[MachineSync] triggers skipped for ${skipped.length} model(s): ${skipped.slice(0, 3).join('; ')}`)
  }
  return { installed, skipped }
}

/** Drop every trigger this module created (used by tests and by a full reset). */
export function dropTriggerStatements(): string[] {
  const out: string[] = []
  for (const model of MIRROR_MODELS) {
    for (const event of ['insert', 'update', 'delete'] as const) {
      out.push(`DROP TRIGGER IF EXISTS "${triggerName(model, event)}"`)
    }
  }
  return out
}
