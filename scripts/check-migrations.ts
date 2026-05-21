// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Replay every desktop SQLite migration against synthetic databases that
 * represent real user trajectories, and fail loudly on the first SQL
 * error.
 *
 * Why this exists
 * ---------------
 * The desktop SQLite migration tree (`apps/desktop/prisma/migrations/`) is
 * hand-mirrored from the cloud PG tree (`prisma/migrations/`). The two
 * dialects drift cheaply (enums become TEXT, JSONB becomes TEXT, array
 * columns become JSON-encoded TEXT, etc.) and there is no automated path
 * from one to the other.
 *
 * That hand-mirroring has a specific failure mode worth guarding against:
 * a *follow-up* migration (ALTER, INSERT, UPDATE) gets mirrored to the
 * SQLite tree without its prerequisite *base* migration (the CREATE TABLE
 * that the ALTER attaches to). The migration parses fine, lints fine,
 * passes `check:schema-parity`, and silently passes any local `bun test`
 * run that uses a fresh DB built from the current schema rather than the
 * migration history. It only fails for users *upgrading* an existing
 * SQLite DB to the new release — at which point Prisma records the
 * migration with `finished_at = NULL`, P3009 trips on every subsequent
 * `prisma migrate deploy`, and the packaged desktop app silently exits
 * before showing a window.
 *
 * This script replays the full migration history against the same set of
 * scenarios on every PR. Each scenario is a `Checkpoint`:
 *
 *   * `empty`              — fresh user, no DB yet. Replays *every*
 *                            migration from 0000_baseline.
 *   * `through-<mig-id>`   — upgrading user. Applies every migration up
 *                            through and including `<mig-id>` against an
 *                            empty DB, pre-populates the
 *                            `_prisma_migrations` table to mark them as
 *                            "finished_at = now()", then attempts to
 *                            apply the REMAINING migrations as Prisma's
 *                            `migrate deploy` would.
 *
 * That second family catches the bug class the empty scenario can't:
 * a new migration that references a column or table dropped by an
 * earlier migration. On an empty DB the dropped object never existed
 * so the new migration succeeds spuriously; on a checkpoint DB the
 * dropped object was previously created and then removed, and the new
 * migration fails — matching what real users on that historical
 * release would hit.
 *
 * Adding a new checkpoint
 * -----------------------
 * Append an entry to the CHECKPOINTS table below with the migration ID
 * that corresponds to the last migration shipped in that release. The
 * script auto-discovers what's "remaining" after that point. We don't
 * commit binary `.db` fixtures because (a) git is bad at storing
 * binary blobs and (b) the fixture is exactly reproducible from the
 * checked-in migration files anyway.
 *
 * What it does NOT catch
 * ----------------------
 *   * Data-integrity bugs that depend on real production data shapes
 *     (e.g. `ALTER TABLE foo ALTER COLUMN bar SET NOT NULL` on a DB
 *     with NULLs in `bar`). Our checkpoints have zero rows — we
 *     replay the schema migrations only. A `data.sql` per-checkpoint
 *     hook is a sensible future extension.
 *   * Issues on the PG side. The `prisma/migrations/` tree is not
 *     replayed here because that would require a Postgres server in CI,
 *     and PG migrations go through staging environments before customer
 *     impact. The desktop SQLite tree has no such buffer — every accepted
 *     PR is one `electron-forge make` away from end-users.
 *
 * Usage
 * -----
 *   bun scripts/check-migrations.ts                       # all scenarios
 *   bun scripts/check-migrations.ts --quiet               # suppress success output
 *   bun scripts/check-migrations.ts --verbose             # print each applied migration
 *   bun scripts/check-migrations.ts --checkpoint <name>   # one scenario only (faster)
 *
 * Exit codes
 * ----------
 *   0  all scenarios applied cleanly
 *   1  one or more scenarios failed
 *   2  setup error (missing folder, can't load bun:sqlite, bad CLI args)
 */

import crypto from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

import { Database } from 'bun:sqlite'

interface Cli {
  quiet: boolean
  verbose: boolean
  /** Run only the named checkpoint instead of all of them. */
  checkpoint: string | null
}

interface MigrationFailure {
  migration: string
  /** First few hundred chars of the failing statement, for the error message. */
  statementPreview: string
  /** Underlying SQLite error message. */
  error: string
  /**
   * Best-effort hint about *why* this likely failed and how to fix it.
   * Empty when no specific pattern matched.
   */
  hint: string
}

/**
 * A historical user trajectory we want every PR to replay against.
 *
 * Each entry simulates "user is on release X, upgrades to HEAD". The
 * pre-state is the SQLite schema produced by applying migrations
 * `[0, throughMigration]` in order against an empty DB and marking
 * them as applied in `_prisma_migrations`. The check then asks Prisma
 * (well, our equivalent of it) to apply everything after that.
 *
 * `throughMigration` is the FULL directory name of the last-applied
 * migration. `null` means "empty DB, no migrations pre-applied" — i.e.
 * the fresh-install scenario.
 *
 * Checkpoint selection rationale: pick the last migration shipped in
 * notable historical releases. The current set covers:
 *
 *   * `empty`              — fresh install, no upgrade path.
 *   * `through-v1.2`       — users still on the original v1.2.7 binary
 *                            (which was widely deployed before the
 *                            v1.7 series). Applied migrations stop
 *                            at the last 0xxx_-prefixed one (the
 *                            timestamp-prefixed ones came later).
 *   * `through-v1.5`       — users mid-trajectory; covers the bulk of
 *                            the 20260422-20260508 migration wave.
 *   * `through-v1.7`       — users one release behind HEAD. The
 *                            tightest "did the latest migration break
 *                            people who just updated yesterday" check.
 *
 * When you ship a release tag, add a new checkpoint here with the
 * migration ID that release shipped with as `throughMigration`. The
 * older checkpoints stay because there are always laggards.
 */
interface Checkpoint {
  name: string
  /** Last migration ID applied in the simulated pre-state, or null for empty. */
  throughMigration: string | null
  /** Human-readable description shown on failure. */
  description: string
}

const CHECKPOINTS: Checkpoint[] = [
  {
    name: 'empty',
    throughMigration: null,
    description: 'Fresh install with no prior database.',
  },
  {
    name: 'through-v1.2',
    throughMigration: '0007_add_device_metadata_to_api_keys',
    description:
      'Existing user still on the v1.2.x release line; database has all 0xxx_-prefixed migrations applied.',
  },
  {
    name: 'through-v1.5',
    throughMigration: '20260508001721_add_project_agents_local',
    description:
      'Existing user on a mid-trajectory release; database has migrations through early-May 2026.',
  },
  {
    name: 'through-v1.7',
    throughMigration: '20260515000000_project_preferred_instance',
    description:
      'Existing user one release behind HEAD; database is identical to a v1.7.x install just before the marketplace_versioning_audit ALTER landed.',
  },
]

const REPO_ROOT = resolve(import.meta.dir, '..')
const DESKTOP_MIGRATIONS = 'apps/desktop/prisma/migrations'

function parseCli(): Cli {
  const args = process.argv.slice(2)
  let checkpoint: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--checkpoint') {
      checkpoint = args[++i] ?? null
      if (!checkpoint) {
        console.error('--checkpoint requires a name (e.g. empty, through-v1.7).')
        process.exit(2)
      }
    }
  }
  return {
    quiet: args.includes('--quiet'),
    verbose: args.includes('--verbose'),
    checkpoint,
  }
}

function listMigrationDirs(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((entry) => {
      const full = join(root, entry)
      return statSync(full).isDirectory() && existsSync(join(full, 'migration.sql'))
    })
    .sort()
}

/**
 * Heuristically guess the cause of a migration failure to make the error
 * message immediately actionable. Returns an empty string when no known
 * pattern matches — the raw SQLite error is then the only signal.
 */
function classifyError(error: string, statement: string): string {
  const lower = error.toLowerCase()

  const noSuchTable = /no such table:\s*"?([\w]+)"?/i.exec(error)
  if (noSuchTable) {
    const table = noSuchTable[1]
    return (
      `Statement references table "${table}" but no earlier migration in this tree creates it. ` +
      `Either (a) add a prerequisite migration with an earlier timestamp that does CREATE TABLE "${table}" ... ` +
      `(translating from the corresponding PG migration in prisma/migrations/ — remember enums become TEXT, ` +
      `JSONB becomes TEXT, TEXT[] becomes TEXT DEFAULT '[]'), or (b) remove this statement if "${table}" ` +
      `is intentionally cloud-only.`
    )
  }

  const noSuchColumn = /no such column:\s*"?([\w.]+)"?/i.exec(error)
  if (noSuchColumn) {
    return (
      `Statement references column "${noSuchColumn[1]}" but no earlier migration adds it. ` +
      `Add a prerequisite ALTER TABLE ... ADD COLUMN migration ordered before this one.`
    )
  }

  const duplicateColumn = /duplicate column name:\s*"?([\w]+)"?/i.exec(error)
  if (duplicateColumn) {
    return (
      `Column "${duplicateColumn[1]}" already exists from a prior migration. ` +
      `Either drop the duplicate ADD COLUMN here or split the column into a new name. ` +
      `(Common cause: copy-pasted CREATE TABLE that should have omitted columns added by later migrations.)`
    )
  }

  if (/syntax error/.test(lower)) {
    return (
      `SQLite parser rejected the statement. Likely a PG-only construct that didn't get translated: ` +
      `array types ("text[]"), enum types, JSONB, "ON CONFLICT ... DO UPDATE" with EXCLUDED, ` +
      `partial indexes with PG expressions, etc.`
    )
  }

  if (/unique constraint failed/i.test(error) || /constraint failed/i.test(error)) {
    return (
      `Statement violated a constraint when applied against an empty DB. Almost certainly a bug — ` +
      `migrations should be safe to apply from scratch.`
    )
  }

  if (statement.includes('CREATE INDEX') && /already exists/i.test(error)) {
    return (
      `Index already exists from an earlier migration. Either drop the duplicate or use ` +
      `CREATE INDEX IF NOT EXISTS.`
    )
  }

  return ''
}

/**
 * Replay a single migration.sql against the provided DB connection.
 * Returns null on success, or a populated MigrationFailure on the first
 * statement that throws.
 *
 * We can't just call `db.exec(wholeFile)` because on failure bun:sqlite
 * tells us only the last statement that errored, not which one in the
 * file. Splitting on `;` (with a small amount of string-literal
 * awareness) lets us point at the offending statement for the error
 * message while still applying the rest of the file via bun:sqlite's
 * multi-statement handler underneath when no error occurs.
 */
function applyMigration(db: Database, migrationName: string, sql: string): MigrationFailure | null {
  // Normalize CRLF (Windows checkouts).
  const normalized = sql.replace(/\r\n/g, '\n')

  // Strip block comments and -- line comments so the statement splitter
  // doesn't mis-handle semicolons inside them.
  const stripped = normalized
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')

  // Split into statements. Statement boundaries are semicolons that are
  // not inside single-quoted string literals. This is intentionally
  // simple — Prisma-generated migrations don't use stored procedures,
  // dollar-quoting, or other PG-isms that would defeat this splitter.
  const statements: string[] = []
  let current = ''
  let inString = false
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]
    if (ch === "'") {
      // SQLite uses '' to escape a single quote inside a string literal.
      if (inString && stripped[i + 1] === "'") {
        current += "''"
        i++
        continue
      }
      inString = !inString
    }
    if (ch === ';' && !inString) {
      const trimmed = current.trim()
      if (trimmed) statements.push(trimmed)
      current = ''
      continue
    }
    current += ch
  }
  const tail = current.trim()
  if (tail) statements.push(tail)

  for (const stmt of statements) {
    try {
      db.exec(stmt)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const preview = stmt.length > 240 ? `${stmt.slice(0, 240)}…` : stmt
      return {
        migration: migrationName,
        statementPreview: preview,
        error: message,
        hint: classifyError(message, stmt),
      }
    }
  }
  return null
}

interface CheckpointResult {
  checkpoint: Checkpoint
  /** Migrations that ran successfully on top of the checkpoint state. */
  appliedCount: number
  /** Migrations that were marked as "already applied" before the run. */
  preAppliedCount: number
  /** Populated only when the run failed. */
  failure: MigrationFailure | null
}

/**
 * Run a single checkpoint scenario: apply pre-checkpoint migrations
 * directly (and mark them as applied in `_prisma_migrations`), then
 * attempt to apply the rest as a real upgrade would.
 *
 * The `_prisma_migrations` table is pre-populated to match what
 * Prisma would write on each `migrate deploy` call. We don't actually
 * need those rows for the replay to succeed (Prisma's logic isn't in
 * the loop) — but populating them lets us catch the case where a
 * future migration script reads or writes that table directly.
 */
function runCheckpoint(
  checkpoint: Checkpoint,
  migrations: string[],
  migrationsRoot: string,
  cli: Cli,
): CheckpointResult {
  // `:memory:` is enough — SQLite's full SQL is in-process, and we
  // start fresh for each checkpoint.
  const db = new Database(':memory:')
  // Match the runtime: the packaged app turns FKs on after every
  // migration, but individual migrations toggle them off so they can
  // ALTER tables that other tables reference. We start with FKs OFF to
  // match the typical migration prologue.
  db.exec('PRAGMA foreign_keys = OFF;')

  // Split migrations into pre-checkpoint (will be marked applied) and
  // post-checkpoint (the actual subject under test).
  let cutoff = -1
  if (checkpoint.throughMigration !== null) {
    cutoff = migrations.indexOf(checkpoint.throughMigration)
    if (cutoff === -1) {
      console.error(
        `[migrations] Checkpoint "${checkpoint.name}" references unknown migration "${checkpoint.throughMigration}". ` +
          `Either rename the migration in the CHECKPOINTS table or remove the entry.`,
      )
      db.close()
      process.exit(2)
    }
  }
  const preApplied = checkpoint.throughMigration === null ? [] : migrations.slice(0, cutoff + 1)
  const toApply = checkpoint.throughMigration === null ? migrations : migrations.slice(cutoff + 1)

  if (cli.verbose) {
    console.log(
      `[migrations] [${checkpoint.name}] pre-applying ${preApplied.length}, ` +
        `then testing ${toApply.length} migration(s).`,
    )
  }

  // Phase 1: apply the pre-checkpoint state. A failure here is a bug
  // in the historical migrations themselves (or the checkpoint
  // definition is wrong), not in the PR — but we still need to report
  // it clearly because nothing else in CI will.
  for (const name of preApplied) {
    const sql = readFileSync(join(migrationsRoot, name, 'migration.sql'), 'utf-8')
    const failure = applyMigration(db, name, sql)
    if (failure) {
      db.close()
      console.error(
        `[migrations] [${checkpoint.name}] HISTORICAL migration "${name}" failed during ` +
          `pre-checkpoint setup. This means a previously-shipped migration no longer ` +
          `applies cleanly — either it was edited in-place (NEVER do this; create a new ` +
          `migration that fixes it) or the checkpoint definition references a state that ` +
          `was never actually shipped.`,
      )
      console.error(`  SQLite error: ${failure.error}`)
      return {
        checkpoint,
        appliedCount: 0,
        preAppliedCount: preApplied.indexOf(name),
        failure,
      }
    }
  }

  // Phase 2: bootstrap `_prisma_migrations` to look like Prisma would
  // have written it after applying the pre-checkpoint migrations. This
  // catches the (currently rare) failure mode where a future migration
  // reads/writes that table — and is also good documentation of the
  // schema Prisma assumes.
  if (preApplied.length > 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _prisma_migrations (
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
    const insert = db.prepare(
      'INSERT INTO _prisma_migrations (id, migration_name, checksum, started_at, finished_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)',
    )
    const now = Date.now()
    for (const name of preApplied) {
      insert.run(crypto.randomUUID(), name, 'fixture-checksum', now, now)
    }
  }

  // Phase 3: the actual subject under test. Apply remaining
  // migrations one at a time, stopping at the first failure.
  let appliedCount = 0
  let failure: MigrationFailure | null = null
  for (const name of toApply) {
    const sql = readFileSync(join(migrationsRoot, name, 'migration.sql'), 'utf-8')
    if (cli.verbose) {
      console.log(`[migrations] [${checkpoint.name}] applying ${name} ...`)
    }
    const f = applyMigration(db, name, sql)
    if (f) {
      failure = f
      break
    }
    appliedCount++
  }

  db.close()
  return {
    checkpoint,
    appliedCount,
    preAppliedCount: preApplied.length,
    failure,
  }
}

function reportFailure(result: CheckpointResult): void {
  const { checkpoint, appliedCount, preAppliedCount, failure } = result
  if (!failure) return

  console.error(
    `[migrations] FAIL — checkpoint "${checkpoint.name}": migration ` +
      `"${failure.migration}" failed.\n`,
  )
  console.error(`  Scenario:  ${checkpoint.description}`)
  if (preAppliedCount > 0) {
    console.error(`  Pre-state: ${preAppliedCount} migration(s) marked as already applied`)
    console.error(`             (up through "${checkpoint.throughMigration}").`)
  }
  console.error(
    `  Progress:  applied ${appliedCount} new migration(s) on top before the failure.`,
  )
  console.error(`  SQLite error: ${failure.error}\n`)
  console.error(`  Failing statement:`)
  for (const line of failure.statementPreview.split('\n')) {
    console.error(`    ${line}`)
  }
  if (failure.hint) {
    console.error(`\n  Hint: ${failure.hint}`)
  }
  if (checkpoint.name !== 'empty') {
    console.error(
      `\n  Note: this failure surfaced via the "${checkpoint.name}" checkpoint. ` +
        `If it does NOT also fail under the "empty" checkpoint (run with ` +
        `\`bun scripts/check-migrations.ts --checkpoint empty\`), the regression is ` +
        `specifically in the upgrade path from that historical state — most likely a ` +
        `new migration that references something an older migration dropped.`,
    )
  }
}

function main(): void {
  const cli = parseCli()
  const migrationsRoot = resolve(REPO_ROOT, DESKTOP_MIGRATIONS)
  if (!existsSync(migrationsRoot)) {
    console.error(`[migrations] Could not find ${DESKTOP_MIGRATIONS}. Run from repo root.`)
    process.exit(2)
  }

  const migrations = listMigrationDirs(migrationsRoot)
  if (migrations.length === 0) {
    console.error(`[migrations] No migrations found under ${DESKTOP_MIGRATIONS}.`)
    process.exit(2)
  }

  let checkpoints = CHECKPOINTS
  if (cli.checkpoint !== null) {
    const requested = cli.checkpoint
    checkpoints = CHECKPOINTS.filter((c) => c.name === requested)
    if (checkpoints.length === 0) {
      console.error(
        `[migrations] Unknown checkpoint "${requested}". ` +
          `Valid names: ${CHECKPOINTS.map((c) => c.name).join(', ')}.`,
      )
      process.exit(2)
    }
  }

  const results: CheckpointResult[] = []
  for (const checkpoint of checkpoints) {
    const result = runCheckpoint(checkpoint, migrations, migrationsRoot, cli)
    results.push(result)
    // First failure aborts the whole run — chasing cascading errors
    // from a single root cause is noisier than helpful, and developers
    // can re-run with `--checkpoint <name>` to focus on a different
    // scenario after fixing the first.
    if (result.failure) break
  }

  const failed = results.filter((r) => r.failure)
  if (failed.length === 0) {
    if (!cli.quiet) {
      const lines = results.map(
        (r) =>
          `  ✓ ${r.checkpoint.name.padEnd(16)} pre-applied=${String(r.preAppliedCount).padStart(2)}  applied=${String(r.appliedCount).padStart(2)}`,
      )
      console.log(`[migrations] OK — all ${results.length} checkpoint(s) clean:\n${lines.join('\n')}`)
    }
    process.exit(0)
  }

  for (const r of failed) reportFailure(r)
  process.exit(1)
}

main()
