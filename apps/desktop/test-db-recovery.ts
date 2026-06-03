// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Integration test for src/db-recovery.ts.
//
// We can't unit-test db-recovery.ts under the normal `bun test` runner
// because the production module shells out to bun.exe — and the test
// process *is* bun, so the obvious "patch require('child_process')"
// approach buys nothing. Instead we drive the real shell-out path
// against a synthesized broken database and observe the side effects.
//
// What this test asserts (run with `bun apps/desktop/test-db-recovery.ts`):
//
//   1. detectFailedMigrations() on a fresh DB containing one row with
//      finished_at = NULL returns exactly that row, with the right
//      name and error excerpt.
//   2. detectFailedMigrations() on a fully-applied DB returns [].
//   3. detectFailedMigrations() on a DB with no _prisma_migrations
//      table (e.g. first-ever launch) returns [] (doesn't throw).
//   4. backupDatabase() produces a sibling .bak file containing
//      byte-for-byte the same contents as the original.
//   5. repairFailedMigrations() removes failed rows but leaves
//      succeeded rows alone.
//   6. After repair, detectFailedMigrations() returns [] for the same
//      DB.
//
// This script exits 0 on success, 1 on any assertion failure, 2 on
// setup error. It's intentionally not wired into CI yet — the desktop
// package has its own npm-managed lifecycle separate from the bun
// workspace tests. Add it to ci.yml when desktop tests start running
// there.

import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  DatabaseRecoveryError,
  backupDatabase,
  detectFailedMigrations,
  repairFailedMigrations,
} from './src/db-recovery'

const BUN_PATH = process.execPath

function makeDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-recovery-test-'))
  return path.join(dir, 'shogo.db')
}

/**
 * Windows holds file handles briefly after a child process exits, so
 * the immediate `fs.rmSync` after each test trips EBUSY. Instead of
 * trying to clean up between tests (which on Windows requires either
 * an `await` or a busy-wait long enough for the kernel to flush the
 * handle table), we queue every temp dir up front and rm them all at
 * the end via the process `exit` handler — by which point the OS
 * has long since released the handles.
 */
const tempDirsToClean: string[] = []
function queueCleanup(dir: string): void {
  tempDirsToClean.push(dir)
}
process.on('exit', () => {
  for (const dir of tempDirsToClean) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort. Anything still locked at process exit is OS-temp
      // and will be reaped on the next reboot.
    }
  }
})

function seed(dbPath: string, rows: Array<{
  name: string
  startedAt: number
  finishedAt: number | null
  rolledBackAt?: number | null
  logs?: string
}>): void {
  const db = new Database(dbPath, { create: true })
  db.exec(`
    CREATE TABLE _prisma_migrations (
      id TEXT PRIMARY KEY,
      migration_name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      finished_at INTEGER,
      started_at INTEGER NOT NULL,
      rolled_back_at INTEGER,
      logs TEXT,
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    );
  `)
  const stmt = db.prepare(
    'INSERT INTO _prisma_migrations (id, migration_name, checksum, started_at, finished_at, rolled_back_at, logs) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const r of rows) {
    stmt.run(
      crypto.randomUUID(),
      r.name,
      'fake-checksum',
      r.startedAt,
      r.finishedAt,
      r.rolledBackAt ?? null,
      r.logs ?? null,
    )
  }
  db.close()
}

function emptyDb(dbPath: string): void {
  const db = new Database(dbPath, { create: true })
  db.exec("CREATE TABLE other_table (id INTEGER PRIMARY KEY);")
  db.close()
}

interface Assertion {
  name: string
  ok: boolean
  detail?: string
}

const results: Assertion[] = []

function check(name: string, cond: boolean, detail?: string): void {
  results.push({ name, ok: cond, detail })
  const tag = cond ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`)
}

// =============================================================================
// Test 1: detect on broken DB
// =============================================================================
console.log('\n── Test 1: detectFailedMigrations on broken DB ──')
{
  const dbPath = makeDb()
  seed(dbPath, [
    { name: '0000_baseline', startedAt: 1_000, finishedAt: 1_100 },
    {
      name: '20260516000000_marketplace_versioning_audit',
      startedAt: 2_000,
      finishedAt: null,
      logs: 'A migration failed to apply.\nMigration name: 20260516000000_marketplace_versioning_audit\nDatabase error code: 1\nDatabase error: no such table: marketplace_installs\n',
    },
  ])

  const failures = detectFailedMigrations(BUN_PATH, dbPath)
  check('returns exactly one failure', failures.length === 1, `got ${failures.length}`)
  check(
    'failure name matches',
    failures[0]?.name === '20260516000000_marketplace_versioning_audit',
    `got "${failures[0]?.name}"`,
  )
  check(
    'startedAt is preserved',
    failures[0]?.startedAt === 2_000,
    `got ${failures[0]?.startedAt}`,
  )
  check(
    'error excerpt contains the underlying message',
    failures[0]?.errorExcerpt.includes('no such table: marketplace_installs') ?? false,
    failures[0]?.errorExcerpt?.slice(0, 80),
  )

  queueCleanup(path.dirname(dbPath))
}

// =============================================================================
// Test 2: detect on healthy DB
// =============================================================================
console.log('\n── Test 2: detectFailedMigrations on healthy DB ──')
{
  const dbPath = makeDb()
  seed(dbPath, [
    { name: '0000_baseline', startedAt: 1_000, finishedAt: 1_100 },
    { name: '0001_add_users', startedAt: 1_200, finishedAt: 1_300 },
  ])

  const failures = detectFailedMigrations(BUN_PATH, dbPath)
  check('returns empty array', failures.length === 0, `got ${failures.length}`)

  queueCleanup(path.dirname(dbPath))
}

// =============================================================================
// Test 3: detect on DB with no _prisma_migrations table
// =============================================================================
console.log('\n── Test 3: detectFailedMigrations on first-launch DB ──')
{
  const dbPath = makeDb()
  emptyDb(dbPath)

  const failures = detectFailedMigrations(BUN_PATH, dbPath)
  check(
    'returns empty array without throwing',
    failures.length === 0,
    `got ${failures.length}`,
  )

  queueCleanup(path.dirname(dbPath))
}

// =============================================================================
// Test 4: detect on missing DB file
// =============================================================================
console.log('\n── Test 4: detectFailedMigrations on missing DB ──')
{
  const missing = path.join(os.tmpdir(), `shogo-nonexistent-${Date.now()}.db`)
  const failures = detectFailedMigrations(BUN_PATH, missing)
  check('returns empty array', failures.length === 0)
}

// =============================================================================
// Test 5: backupDatabase produces a faithful copy
// =============================================================================
console.log('\n── Test 5: backupDatabase ──')
{
  const dbPath = makeDb()
  seed(dbPath, [{ name: 'm1', startedAt: 1, finishedAt: 2 }])
  const originalSize = fs.statSync(dbPath).size
  const originalHash = require('node:crypto')
    .createHash('sha256')
    .update(fs.readFileSync(dbPath))
    .digest('hex')

  const backupPath = backupDatabase(dbPath)
  check('returned backup path exists', fs.existsSync(backupPath), backupPath)
  check(
    'backup is sibling of original',
    path.dirname(backupPath) === path.dirname(dbPath),
  )
  check('backup name matches .bak-<ts> pattern', /\.bak-/.test(path.basename(backupPath)))

  const backupSize = fs.statSync(backupPath).size
  check(
    'backup byte size matches original',
    backupSize === originalSize,
    `original=${originalSize} backup=${backupSize}`,
  )

  const backupHash = require('node:crypto')
    .createHash('sha256')
    .update(fs.readFileSync(backupPath))
    .digest('hex')
  check('backup sha256 matches original', backupHash === originalHash)

  queueCleanup(path.dirname(dbPath))
}

// =============================================================================
// Test 6: repair clears only the failed rows
// =============================================================================
console.log('\n── Test 6: repairFailedMigrations ──')
{
  const dbPath = makeDb()
  seed(dbPath, [
    { name: 'good_one', startedAt: 1_000, finishedAt: 1_100 },
    { name: 'bad_one', startedAt: 2_000, finishedAt: null, logs: 'oops' },
    { name: 'also_good', startedAt: 3_000, finishedAt: 3_100 },
  ])

  repairFailedMigrations(BUN_PATH, dbPath, ['bad_one'])

  const db = new Database(dbPath, { readonly: true })
  const allRows = db
    .query('SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at')
    .all() as Array<{ migration_name: string; finished_at: number | null }>
  db.close()

  check('two rows remain', allRows.length === 2, `got ${allRows.length}`)
  check(
    'good rows untouched',
    allRows[0]?.migration_name === 'good_one' &&
      allRows[1]?.migration_name === 'also_good',
    JSON.stringify(allRows.map((r) => r.migration_name)),
  )

  const stillFailing = detectFailedMigrations(BUN_PATH, dbPath)
  check('no failed migrations remain', stillFailing.length === 0)

  queueCleanup(path.dirname(dbPath))
}

// =============================================================================
// Test 7: repair refuses to touch already-resolved rows
// =============================================================================
console.log('\n── Test 7: repair is a no-op on already-resolved rows ──')
{
  const dbPath = makeDb()
  seed(dbPath, [
    {
      name: 'previously_rolled_back',
      startedAt: 1_000,
      finishedAt: null,
      rolledBackAt: 1_200,
    },
  ])

  repairFailedMigrations(BUN_PATH, dbPath, ['previously_rolled_back'])

  const db = new Database(dbPath, { readonly: true })
  const rows = db.query('SELECT COUNT(*) as n FROM _prisma_migrations').all() as Array<{ n: number }>
  db.close()
  check(
    'rolled-back row was not deleted',
    rows[0]?.n === 1,
    `count=${rows[0]?.n}`,
  )

  queueCleanup(path.dirname(dbPath))
}

// =============================================================================
// Test 8: end-to-end on a copy of the user's actual broken DB (if present)
// =============================================================================
const realDb = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'Shogo',
  'data',
  'shogo.db',
)
if (fs.existsSync(realDb)) {
  console.log('\n── Test 8: end-to-end against real user DB ──')
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-real-'))
  const scratchDb = path.join(scratchDir, 'shogo.db')
  fs.copyFileSync(realDb, scratchDb)

  // Re-introduce the failed-migration state in the copy (the original
  // may or may not be in the failed state — depends on whether the
  // user has run any repair commands).
  const db = new Database(scratchDb)
  db.exec(
    "UPDATE _prisma_migrations SET finished_at = NULL WHERE migration_name = '20260516000000_marketplace_versioning_audit'",
  )
  db.close()

  const failures = detectFailedMigrations(BUN_PATH, scratchDb)
  check(
    'detected the marketplace_versioning_audit failure on real DB',
    failures.some((f) => f.name === '20260516000000_marketplace_versioning_audit'),
    JSON.stringify(failures.map((f) => f.name)),
  )

  const backupPath = backupDatabase(scratchDb)
  check('backup succeeded', fs.existsSync(backupPath))

  repairFailedMigrations(
    BUN_PATH,
    scratchDb,
    failures.map((f) => f.name),
  )
  const after = detectFailedMigrations(BUN_PATH, scratchDb)
  check('no failures after repair', after.length === 0)

  queueCleanup(scratchDir)
} else {
  console.log('\n── Test 8: SKIPPED (no real user DB at ' + realDb + ') ──')
}

// =============================================================================
// Test 9: DatabaseRecoveryError shape
// =============================================================================
console.log('\n── Test 9: DatabaseRecoveryError shape ──')
{
  const err = new DatabaseRecoveryError(
    [{ name: 'm1', startedAt: 1, errorExcerpt: 'oops' }],
    'C:\\fake.db',
  )
  check('instanceof DatabaseRecoveryError', err instanceof DatabaseRecoveryError)
  check('instanceof Error', err instanceof Error)
  check('kind is failed_migration', err.kind === 'failed_migration')
  check('name is DatabaseRecoveryError', err.name === 'DatabaseRecoveryError')
  check('preserves failures', err.failures.length === 1 && err.failures[0]?.name === 'm1')
  check('preserves dbPath', err.dbPath === 'C:\\fake.db')
  check(
    'message lists the failed migration names',
    err.message.includes('m1'),
    err.message,
  )
}

// =============================================================================
// Test 10: on-demand "Repair Local Database" composition
// =============================================================================
// main.ts's repairLocalDatabaseInteractive() / performDatabaseRepair() are
// electron-coupled (dialogs + app.relaunch), so we can't drive them directly
// here. This asserts the exact primitive sequence they run: detect → (back up
// + clear) → re-detect-empty. A healthy DB short-circuits to "nothing to do".
console.log('\n── Test 10: on-demand repair composition ──')
{
  // Healthy DB: detection returns [] so the helper would show the
  // "database is healthy" dialog and make no changes.
  const healthy = makeDb()
  seed(healthy, [{ name: '0000_baseline', startedAt: 1_000, finishedAt: 1_100 }])
  check(
    'healthy DB short-circuits (no failures detected)',
    detectFailedMigrations(BUN_PATH, healthy).length === 0,
  )
  queueCleanup(path.dirname(healthy))

  // Broken DB: detection finds the stuck row, repair backs up + clears,
  // and a follow-up detection is clean (relaunch would then re-deploy).
  const broken = makeDb()
  seed(broken, [
    { name: 'baseline', startedAt: 1_000, finishedAt: 1_100 },
    { name: 'wedged', startedAt: 2_000, finishedAt: null, logs: 'P3009-ish failure' },
  ])
  const detected = detectFailedMigrations(BUN_PATH, broken)
  check('on-demand: detected the wedged migration', detected.length === 1)

  const backupPath = backupDatabase(broken)
  check('on-demand: backup created before repair', fs.existsSync(backupPath))

  repairFailedMigrations(BUN_PATH, broken, detected.map((f) => f.name))
  check(
    'on-demand: DB is clean after repair',
    detectFailedMigrations(BUN_PATH, broken).length === 0,
  )
  queueCleanup(path.dirname(broken))
}

// =============================================================================
// Report
// =============================================================================
const failed = results.filter((r) => !r.ok)
console.log(`\n${'═'.repeat(60)}`)
if (failed.length === 0) {
  console.log(`PASS: all ${results.length} checks passed`)
  process.exit(0)
} else {
  console.log(`FAIL: ${failed.length} of ${results.length} checks failed:`)
  for (const f of failed) {
    console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`)
  }
  process.exit(1)
}
