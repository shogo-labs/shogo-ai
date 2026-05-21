// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Database recovery — turn "Prisma is stuck on a failed migration" from a
// silent-startup-exit into a recoverable error the user can fix from a
// dialog.
//
// Background
// ----------
// `prisma migrate deploy` records every migration in `_prisma_migrations`
// with `started_at` and (on success) `finished_at`. When a migration
// throws mid-way it leaves the row with `finished_at = NULL` and on every
// subsequent run Prisma's P3009 check refuses to do *any* further work:
//
//   migrate found failed migrations in the target database, new
//   migrations will not be applied. Read more about how to resolve
//   migration issues in a production database: https://pris.ly/d/migrate-resolve
//
// The packaged desktop app, faced with that error, propagates it up to
// `startLocalServer()`, which currently calls `app.quit()` — leaving the
// user staring at a dock icon that does nothing. (See main.ts ~L1013.)
//
// This module provides three primitives that let main.ts handle that
// case interactively instead:
//
//   1. `detectFailedMigrations()` — pre-flight query of
//      `_prisma_migrations` that catches the stuck state BEFORE shelling
//      out to `prisma migrate deploy`, giving us a structured error
//      (name + timestamp + error log excerpt) instead of having to
//      pattern-match P3009 out of Prisma's text output.
//
//   2. `backupDatabase()` — defensive snapshot of `shogo.db` to a
//      timestamped sibling file. ALWAYS called before any repair
//      attempt; we'd rather leave the user with two databases (one
//      broken, one to recover from) than silently mutate the only copy.
//
//   3. `repairFailedMigrations()` — clears the offending row(s) from
//      `_prisma_migrations` (the equivalent of
//      `prisma migrate resolve --rolled-back <name>`, but without
//      requiring a writable schema-engine sidecar in the packaged app).
//      The caller is expected to re-run `prisma migrate deploy` after
//      this to let the migration retry.
//
// Why shell out to bun instead of linking better-sqlite3
// ------------------------------------------------------
// The desktop main process runs under Electron's bundled Node, which
// doesn't ship with a SQLite driver, and adding `better-sqlite3` would
// introduce a native module that needs to be rebuilt per-Electron-ABI
// per-platform — a real maintenance cost for ~30 lines of SQL. The
// packaged app already ships `resources/bun/bun.exe` (used to run
// `prisma migrate deploy`), and `bun:sqlite` is statically linked into
// it. Running `bun -e "<small script>"` against the existing binary is
// dependency-free and uses the exact same SQLite version as the
// `prisma-adapter-bun-sqlite` driver Prisma uses at runtime, so there's
// zero risk of a driver-version mismatch corrupting the DB during
// repair.

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

/**
 * Tagged error thrown when the database is in a state that requires user
 * intervention. main.ts catches this specifically and surfaces a
 * recovery dialog rather than the generic "failed to start local
 * server" path that ends in silent app.quit().
 */
export class DatabaseRecoveryError extends Error {
  readonly kind: 'failed_migration'
  readonly failures: FailedMigration[]
  readonly dbPath: string

  constructor(failures: FailedMigration[], dbPath: string) {
    const names = failures.map((f) => f.name).join(', ')
    super(`Database has ${failures.length} failed migration(s): ${names}`)
    this.name = 'DatabaseRecoveryError'
    this.kind = 'failed_migration'
    this.failures = failures
    this.dbPath = dbPath
  }
}

export interface FailedMigration {
  name: string
  /** Epoch milliseconds the migration was attempted. */
  startedAt: number
  /** First 600 chars of the Prisma error log row, for the dialog body. */
  errorExcerpt: string
}

/**
 * Run a one-shot bun script against the given DB and parse its stdout
 * as JSON. Throws if bun isn't on disk or the script bails. We
 * deliberately do NOT swallow these errors — if the recovery layer
 * itself is broken, the user should see the underlying problem rather
 * than a useless "couldn't check the database" message.
 */
function runBunScript<T>(bunPath: string, dbPath: string, script: string): T {
  // bun's -e flag takes a single string. The script reads DBP from the
  // environment so we don't have to worry about escaping the path
  // through two layers of shell quoting (it can contain spaces on
  // Windows like `C:\Users\My Name\AppData\...`).
  const out = execFileSync(bunPath, ['-e', script], {
    env: { ...process.env, DBP: dbPath },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // 5s is generous — these queries touch one row of one table.
    timeout: 5000,
  })
  const trimmed = out.trim()
  if (!trimmed) {
    throw new Error(`bun script returned empty output for ${dbPath}`)
  }
  return JSON.parse(trimmed) as T
}

/**
 * Return rows from `_prisma_migrations` whose `finished_at` is NULL
 * (still-failed) and `rolled_back_at` is NULL (not yet recovered).
 * Returns an empty array when the DB doesn't exist yet, the
 * `_prisma_migrations` table hasn't been created, or no failures are
 * present.
 *
 * Implemented as a pre-flight so we can surface a structured error
 * BEFORE Prisma's P3009 text wall reaches the user. P3009's body is
 * 12 lines of Rust panic traces with the migration name buried in the
 * middle; this function gives main.ts the same info in a typed shape
 * that a dialog can render cleanly.
 */
export function detectFailedMigrations(bunPath: string, dbPath: string): FailedMigration[] {
  if (!fs.existsSync(dbPath)) return []

  const script = `
    import { Database } from 'bun:sqlite';
    try {
      const db = new Database(process.env.DBP, { readonly: true });
      const hasTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'").get();
      if (!hasTable) { console.log('[]'); process.exit(0); }
      const rows = db
        .query("SELECT migration_name as name, started_at as startedAt, substr(coalesce(logs, ''), 1, 600) as errorExcerpt FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at")
        .all();
      console.log(JSON.stringify(rows));
    } catch (e) {
      console.error(String(e?.stack || e));
      process.exit(2);
    }
  `

  return runBunScript<FailedMigration[]>(bunPath, dbPath, script)
}

/**
 * Snapshot `shogo.db` (plus its `-wal` and `-shm` sidecars if present)
 * to a timestamped sibling file. The returned path is the backup of
 * the main DB file; sidecars are named `<base>-wal.bak`, `<base>-shm.bak`
 * relative to it. We use plain `fs.copyFileSync` instead of SQLite's
 * online backup API because:
 *
 *   * The DB is closed at this point (the API process isn't running
 *     yet on the failed-migration path), so there are no concurrent
 *     writers to coordinate with.
 *   * `copyFileSync` works even if SQLite would otherwise refuse to
 *     open the DB (e.g. mid-corruption). Recovery should not be
 *     blocked by the same defect that broke the DB in the first place.
 *
 * Throws on any I/O failure. The caller MUST treat a thrown error as
 * "do not proceed with repair" — corrupting the only copy of a user's
 * DB is the worst possible outcome here.
 */
export function backupDatabase(dbPath: string): string {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database does not exist at ${dbPath} — refusing to back up nothing`)
  }
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(dir, `${base}.bak-${stamp}`)
  fs.copyFileSync(dbPath, backupPath)

  // SQLite's WAL journal mode keeps in-flight transactions in `<db>-wal`
  // and shared-memory locks in `<db>-shm`. They can be safely deleted
  // by SQLite on next open, but for a forensic backup we want them too
  // — without them, the .bak is missing any writes that hadn't been
  // checkpointed at the time of the failure.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`
    if (fs.existsSync(sidecar)) {
      fs.copyFileSync(sidecar, `${backupPath}${suffix}`)
    }
  }
  return backupPath
}

/**
 * Mark the named failed migrations as resolved by deleting their rows
 * from `_prisma_migrations`. This is the equivalent of running
 *
 *     prisma migrate resolve --rolled-back <name>
 *
 * for each one, except we don't need the schema-engine binary to be
 * present and writable — which matters because the packaged app has to
 * copy the engine to a writable location at startup (see local-server.ts
 * ~L908), a step that can itself fail in low-disk-space or AV-blocked
 * scenarios. Recovery should work even when the engine is unavailable.
 *
 * The caller is expected to back up the DB first via `backupDatabase()`.
 * This function refuses to operate if the named migrations are not
 * actually in a failed state (defends against a stale `failures` list
 * being passed in if the user manually fixed the DB between dialog and
 * click).
 *
 * After calling this, the next `prisma migrate deploy` invocation will
 * re-attempt the same migration. Recovery only succeeds if the
 * underlying SQL has been fixed in the new release (i.e. the user
 * upgraded to a version where the missing prerequisite migration
 * exists). If the migration fails for the same reason again, the user
 * sees the same dialog on the next launch — they're no worse off than
 * before, and they have the backup.
 */
export function repairFailedMigrations(
  bunPath: string,
  dbPath: string,
  migrationNames: string[],
): void {
  if (migrationNames.length === 0) return
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cannot repair: database does not exist at ${dbPath}`)
  }

  // Serialize names as JSON inside the script literal so a malicious
  // (or unexpected) migration name with quotes/backslashes can't break
  // out of the SQL string. The names parse as a JS array of strings
  // inside bun, then bind into the SQL as parameters.
  const namesJson = JSON.stringify(migrationNames)
  const script = `
    import { Database } from 'bun:sqlite';
    const names = ${namesJson};
    if (!Array.isArray(names) || names.some(n => typeof n !== 'string')) {
      console.error('Invalid migration name list');
      process.exit(2);
    }
    try {
      const db = new Database(process.env.DBP, { create: false, readwrite: true });
      const placeholders = names.map(() => '?').join(',');
      // Only delete rows that are actually failed — defensive against a
      // stale 'failures' list having been passed in. If the row is
      // already succeeded or already rolled back, we leave it alone.
      const stmt = db.prepare(
        \`DELETE FROM _prisma_migrations WHERE migration_name IN (\${placeholders}) AND finished_at IS NULL AND rolled_back_at IS NULL\`
      );
      const result = stmt.run(...names);
      console.log(JSON.stringify({ deleted: Number(result.changes) }));
    } catch (e) {
      console.error(String(e?.stack || e));
      process.exit(3);
    }
  `

  const out = runBunScript<{ deleted: number }>(bunPath, dbPath, script)
  if (out.deleted === 0) {
    // Not an error — the rows may have been cleared by a concurrent
    // launch attempt, by manual repair, or the failure list was stale.
    // We log and return; the caller will re-run migrate deploy either
    // way.
    console.warn(
      `[db-recovery] repairFailedMigrations: no rows deleted (names=${migrationNames.join(',')}). ` +
        `DB may already be in a clean state.`,
    )
  } else {
    console.log(`[db-recovery] Cleared ${out.deleted} failed migration row(s).`)
  }
}
