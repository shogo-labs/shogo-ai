// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Local SQLite migration "doctor" for the Shogo desktop app.
//
// The packaged desktop app stores its database at
// `<userData>/data/shogo.db` and applies schema with
// `prisma migrate deploy` on every launch. When a migration throws
// mid-way it leaves a row in `_prisma_migrations` with
// `finished_at = NULL`, and Prisma's P3009 check then refuses to run
// ANY further migrations — the app is wedged until that ledger row is
// cleared. The desktop app surfaces a recovery dialog when this happens
// on boot (see apps/desktop/src/db-recovery.ts), but a user whose app
// won't open, or who is being walked through a fix by support, has no
// way to trigger that repair from a terminal.
//
// `shogo doctor` (this module) is that terminal entry point. It performs
// the SAME safe, dependency-free repair the desktop dialog does:
//
//   1. detectFailedMigrations()  — find stuck `_prisma_migrations` rows.
//   2. backupDatabase()          — snapshot `shogo.db` (+ -wal/-shm)
//                                  before touching anything.
//   3. repairFailedMigrations()  — delete the stuck rows (equivalent to
//                                  `prisma migrate resolve --rolled-back`).
//
// It deliberately does NOT re-run `prisma migrate deploy` itself — the
// CLI doesn't ship the Prisma schema/migration history that lives inside
// the desktop app bundle. Instead it clears the wedge and tells the user
// to relaunch Shogo, which re-applies migrations on its next boot.
//
// Why shell out to bun rather than link a SQLite driver
// -----------------------------------------------------
// The worker CLI runs under Node (npm install) OR Bun (tarball release),
// and we don't want a native `better-sqlite3` build step. The desktop
// app already ships a `bun` binary with `bun:sqlite` statically linked,
// and that's the exact SQLite version Prisma's bun-sqlite adapter uses at
// runtime — so running `bun -e "<small script>"` against it is both
// dependency-free and driver-version-matched. This mirrors
// apps/desktop/src/db-recovery.ts (kept as a separate copy there because
// the Electron main process is bundled in a different runtime context).

import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';

export interface FailedMigration {
  name: string;
  /** Epoch milliseconds the migration was attempted. */
  startedAt: number;
  /** First 600 chars of the Prisma error log row, for display. */
  errorExcerpt: string;
}

/**
 * Run a one-shot bun script against the given DB and parse its stdout
 * as JSON. The script reads the DB path from `process.env.DBP` so we
 * don't have to escape paths (which can contain spaces) through shell
 * quoting. Throws if bun isn't usable or the script bails — we do NOT
 * swallow these, since a broken recovery layer should surface its own
 * defect rather than a misleading "database looks fine".
 */
function runBunScript<T>(bunPath: string, dbPath: string, script: string): T {
  const out = execFileSync(bunPath, ['-e', script], {
    env: { ...process.env, DBP: dbPath },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
  });
  const trimmed = out.trim();
  if (!trimmed) {
    throw new Error(`bun script returned empty output for ${dbPath}`);
  }
  return JSON.parse(trimmed) as T;
}

/**
 * Return `_prisma_migrations` rows that are still failed (`finished_at`
 * NULL) and not yet recovered (`rolled_back_at` NULL). Returns an empty
 * array when the DB doesn't exist, the table hasn't been created, or no
 * failures are present.
 */
export function detectFailedMigrations(bunPath: string, dbPath: string): FailedMigration[] {
  if (!existsSync(dbPath)) return [];

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
  `;

  return runBunScript<FailedMigration[]>(bunPath, dbPath, script);
}

/**
 * Snapshot `shogo.db` (plus `-wal`/`-shm` sidecars if present) to a
 * timestamped sibling file. Returns the backup path of the main DB.
 * Uses plain copies (not SQLite's online backup) because the DB is not
 * open at this point and `copyFileSync` works even on a DB SQLite would
 * refuse to open. Throws on any I/O failure — the caller MUST treat that
 * as "do not proceed with repair".
 */
export function backupDatabase(dbPath: string): string {
  if (!existsSync(dbPath)) {
    throw new Error(`Database does not exist at ${dbPath} — refusing to back up nothing`);
  }
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `${base}.bak-${stamp}`);
  copyFileSync(dbPath, backupPath);

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      copyFileSync(sidecar, `${backupPath}${suffix}`);
    }
  }
  return backupPath;
}

/**
 * Delete the named failed-migration rows from `_prisma_migrations`. This
 * is the equivalent of `prisma migrate resolve --rolled-back <name>` for
 * each, but without needing the schema-engine binary. Only deletes rows
 * that are actually still failed (defends against a stale name list).
 * Returns the number of rows deleted.
 *
 * The caller is expected to have run `backupDatabase()` first. After this,
 * the next `prisma migrate deploy` (on the desktop app's next launch)
 * re-attempts the migration.
 */
export function repairFailedMigrations(
  bunPath: string,
  dbPath: string,
  migrationNames: string[],
): number {
  if (migrationNames.length === 0) return 0;
  if (!existsSync(dbPath)) {
    throw new Error(`Cannot repair: database does not exist at ${dbPath}`);
  }

  const namesJson = JSON.stringify(migrationNames);
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
      const stmt = db.prepare(
        \`DELETE FROM _prisma_migrations WHERE migration_name IN (\${placeholders}) AND finished_at IS NULL AND rolled_back_at IS NULL\`
      );
      const result = stmt.run(...names);
      console.log(JSON.stringify({ deleted: Number(result.changes) }));
    } catch (e) {
      console.error(String(e?.stack || e));
      process.exit(3);
    }
  `;

  const out = runBunScript<{ deleted: number }>(bunPath, dbPath, script);
  return out.deleted;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export type DoctorStatus = 'healthy' | 'no-database' | 'repaired' | 'failed';

export interface DoctorResult {
  status: DoctorStatus;
  /** Migrations found in a failed state before repair. */
  detected: FailedMigration[];
  /** Path of the backup written before repair, if any. */
  backupPath?: string;
  /** Names of migration rows actually cleared. */
  cleared: string[];
  /** Migrations still failed after the repair attempt (should be empty on success). */
  remaining: FailedMigration[];
  /** Human-readable summary of what happened. */
  message: string;
}

export interface DoctorOptions {
  bunPath: string;
  dbPath: string;
  /** Skip the pre-repair backup (default: false). Discouraged. */
  skipBackup?: boolean;
  /** Logger for progress lines (default: no-op). */
  log?: (line: string) => void;
}

/**
 * Run the full safe repair sequence against a local SQLite DB:
 * detect → backup → clear stuck ledger rows → re-detect. Idempotent:
 * a healthy DB is a no-op. Never re-runs `migrate deploy` (that's the
 * desktop app's job on next launch).
 */
export function runDatabaseDoctor(opts: DoctorOptions): DoctorResult {
  const log = opts.log ?? (() => {});
  const { bunPath, dbPath } = opts;

  if (!existsSync(dbPath)) {
    return {
      status: 'no-database',
      detected: [],
      cleared: [],
      remaining: [],
      message: `No database found at ${dbPath}. Nothing to repair — launch Shogo once to create it.`,
    };
  }

  const detected = detectFailedMigrations(bunPath, dbPath);
  if (detected.length === 0) {
    return {
      status: 'healthy',
      detected: [],
      cleared: [],
      remaining: [],
      message: 'No failed migrations detected — the local database looks healthy.',
    };
  }

  log(`Found ${detected.length} failed migration(s): ${detected.map((m) => m.name).join(', ')}`);

  let backupPath: string | undefined;
  if (!opts.skipBackup) {
    backupPath = backupDatabase(dbPath);
    log(`Backed up database to ${backupPath}`);
  }

  const names = detected.map((m) => m.name);
  const deleted = repairFailedMigrations(bunPath, dbPath, names);
  log(`Cleared ${deleted} failed migration row(s).`);

  const remaining = detectFailedMigrations(bunPath, dbPath);
  const status: DoctorStatus = remaining.length === 0 ? 'repaired' : 'failed';
  const message =
    status === 'repaired'
      ? 'Cleared the failed migration record. Relaunch Shogo to re-apply migrations cleanly.'
      : `Repair incomplete — ${remaining.length} migration(s) still failed: ${remaining
          .map((m) => m.name)
          .join(', ')}.`;

  return {
    status,
    detected,
    backupPath,
    cleared: names.slice(0, deleted),
    remaining,
    message,
  };
}

// ---------------------------------------------------------------------------
// Path / binary resolution (for the standalone CLI)
// ---------------------------------------------------------------------------

/**
 * Resolve the desktop app's per-user data directory, mirroring
 * Electron's `app.getPath('userData')` + the `data/` subdir used by
 * apps/desktop/src/paths.ts. `productName` is "Shogo".
 *
 *   macOS:   ~/Library/Application Support/Shogo/data
 *   Windows: %APPDATA%/Shogo/data        (Roaming)
 *   Linux:   $XDG_CONFIG_HOME/Shogo/data  (or ~/.config/Shogo/data)
 */
export function resolveDesktopDataDir(): string {
  const home = homedir();
  const plat = platform();
  let appData: string;
  if (plat === 'darwin') {
    appData = path.join(home, 'Library', 'Application Support');
  } else if (plat === 'win32') {
    appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  } else {
    appData = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  }
  return path.join(appData, 'Shogo', 'data');
}

/** Default path of the desktop app's local SQLite database. */
export function resolveDesktopDbPath(): string {
  return path.join(resolveDesktopDataDir(), 'shogo.db');
}

/**
 * Candidate locations of the `bun` binary the installed desktop app
 * ships in its `resources/bun/` directory. Best-effort and
 * platform-specific; missing entries are filtered out by the caller.
 */
function bundledBunCandidates(): string[] {
  const plat = platform();
  const exe = plat === 'win32' ? 'bun.exe' : 'bun';
  const home = homedir();
  const candidates: string[] = [];
  if (plat === 'darwin') {
    candidates.push(
      path.join('/Applications', 'Shogo.app', 'Contents', 'Resources', 'bun', exe),
      path.join(home, 'Applications', 'Shogo.app', 'Contents', 'Resources', 'bun', exe),
    );
  } else if (plat === 'linux') {
    candidates.push(
      path.join('/opt', 'Shogo', 'resources', 'bun', exe),
      path.join('/usr', 'lib', 'shogo', 'resources', 'bun', exe),
    );
  }
  // Windows installs under a version-stamped Squirrel dir
  // (%LOCALAPPDATA%/shogo/app-<ver>/resources/bun/bun.exe) which we can't
  // resolve without globbing; rely on --bun / PATH there.
  return candidates;
}

/** True if the given binary can be executed and reports a version. */
function bunIsUsable(bunPath: string): boolean {
  try {
    execFileSync(bunPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a usable `bun` binary for the repair scripts, in priority order:
 *   1. explicit `override` (the `--bun` flag)
 *   2. the bun currently running this CLI (tarball release)
 *   3. the desktop app's bundled bun
 *   4. `bun` on PATH
 * Returns null if none are usable.
 */
export function resolveBunBinary(override?: string): string | null {
  if (override) return bunIsUsable(override) ? override : null;
  if (process.versions.bun && process.execPath) return process.execPath;
  for (const candidate of bundledBunCandidates()) {
    if (existsSync(candidate) && bunIsUsable(candidate)) return candidate;
  }
  if (bunIsUsable('bun')) return 'bun';
  return null;
}
