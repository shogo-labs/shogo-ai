// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Generate a new desktop SQLite migration from
 * `prisma/schema.local.prisma`.
 *
 * This is the SQLite-track sibling of `bun run db:migrate` (which
 * shells out to `prisma migrate dev` against PostgreSQL). It exists
 * because we can't use `prisma migrate dev` for the desktop track:
 * `migrate dev` requires an actual database connection (to run a
 * shadow database round-trip), and the desktop track's runtime
 * database lives inside packaged user installs — there is no central
 * dev DB to point it at.
 *
 * Instead, we use `prisma migrate diff` against the existing
 * migration history as the "from" and the schema as the "to". Prisma
 * computes the SQL needed to bridge them using an in-memory shadow
 * DB, and writes it to a new migration directory. This is exactly
 * what `migrate dev` does internally for the SQL-emission step — we
 * just bypass the connect-to-dev-DB part.
 *
 * Why this matters for correctness
 * --------------------------------
 * Before this script existed, desktop SQLite migrations were
 * hand-translated from the PG ones in `prisma/migrations/`. That
 * process has a specific failure mode: if you ship the *follow-up*
 * migration (e.g. an ALTER) without first translating the *base*
 * migration (the CREATE TABLE it attaches to), the desktop binary
 * tries to ALTER a non-existent table on first launch, the migration
 * is recorded as failed, and Prisma's P3009 lock then blocks every
 * subsequent launch. That's exactly what bricked v1.7.8 for the
 * entire installed base — see
 * `apps/desktop/prisma/migrations/20260515500000_add_marketplace_tables/migration.sql`
 * for the post-mortem and the corrective backfill migration.
 *
 * This script eliminates the hand-translation step entirely. The
 * generated migration always reflects the full diff between the
 * current migration history and the schema, so a follow-up ALTER
 * can't accidentally be shipped without its base CREATE TABLE: if
 * the base was missing, the diff would include it too.
 *
 * Usage
 * -----
 *   bun run db:migrate:desktop -- --name add_marketplace_tables
 *
 *   # or directly:
 *   bun scripts/db-migrate-desktop.ts --name add_marketplace_tables
 *
 *   # extra flags:
 *   #   --dry-run    print the SQL that would be written, don't create files
 *   #   --force      overwrite an existing migration with the same name
 *
 * The created migration's directory name follows Prisma's own
 * convention: `YYYYMMDDHHmmss_<name>/migration.sql`. The timestamp
 * is computed once at script start so re-runs within the same second
 * collide (and bail out unless `--force` is passed).
 *
 * Exit codes
 * ----------
 *   0  migration written (or, with --dry-run, SQL printed); or no
 *      schema changes detected and nothing to do
 *   1  bad arguments, name collision, or prisma CLI failed
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

interface Cli {
  name: string
  dryRun: boolean
  force: boolean
}

const MIGRATIONS_DIR = 'apps/desktop/prisma/migrations'
const SCHEMA = 'prisma/schema.local.prisma'
const REPO_ROOT = resolve(import.meta.dir, '..')
// Snake_case, lowercase, digits — matches Prisma's own enforcement
// for `migrate dev --name`. Reject hyphens and PascalCase to keep
// migration filenames consistent across the tree.
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,80}$/

function parseCli(): Cli {
  const args = process.argv.slice(2)
  let name: string | undefined
  let dryRun = false
  let force = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--name') {
      name = args[++i]
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--force') {
      force = true
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      printUsage()
      process.exit(1)
    }
  }
  if (!name) {
    console.error('Missing --name <snake_case_name>.')
    printUsage()
    process.exit(1)
  }
  if (!NAME_PATTERN.test(name)) {
    console.error(
      `Invalid name "${name}". Use lowercase letters, digits, and underscores; start with a letter; max 80 chars.`,
    )
    process.exit(1)
  }
  return { name, dryRun, force }
}

function printUsage(): void {
  console.error(`Usage: bun run db:migrate:desktop -- --name <snake_case_name> [--dry-run] [--force]`)
}

function timestamp(): string {
  // YYYYMMDDHHmmss — matches the convention every other migration in
  // apps/desktop/prisma/migrations/ already uses (e.g.
  // 20260515500000_project_preferred_instance). UTC to avoid
  // timezone-dependent collisions when multiple devs branch off the
  // same head in different regions.
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}` +
    `${pad(d.getUTCMonth() + 1)}` +
    `${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}` +
    `${pad(d.getUTCMinutes())}` +
    `${pad(d.getUTCSeconds())}`
  )
}

function runMigrateDiff(outputPath: string | null): {
  stdout: string
  stderr: string
  exitCode: number
} {
  const args = [
    'x',
    'prisma',
    'migrate',
    'diff',
    '--from-migrations',
    MIGRATIONS_DIR,
    '--to-schema',
    SCHEMA,
    '--script',
  ]
  // We don't use prisma's `--output` flag here because (a) it was
  // only added in 5.12.1 and we want to stay compatible with older
  // engines, and (b) it doesn't create parent directories, which we
  // need to do anyway.
  if (outputPath !== null) {
    // No-op: we capture stdout and write it ourselves below. The
    // arg is kept here only to document that we *could* use it.
  }
  const result = spawnSync(
    process.platform === 'win32' ? 'bun.exe' : 'bun',
    args,
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, SHOGO_LOCAL_MODE: 'true' },
    },
  )
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  }
}

function main(): void {
  const cli = parseCli()

  if (!existsSync(resolve(REPO_ROOT, MIGRATIONS_DIR))) {
    console.error(`Could not find ${MIGRATIONS_DIR}. Run from repo root.`)
    process.exit(1)
  }
  if (!existsSync(resolve(REPO_ROOT, SCHEMA))) {
    console.error(`Could not find ${SCHEMA}. Run from repo root.`)
    process.exit(1)
  }

  const ts = timestamp()
  const dirName = `${ts}_${cli.name}`
  const dirPath = resolve(REPO_ROOT, MIGRATIONS_DIR, dirName)
  const filePath = join(dirPath, 'migration.sql')

  if (!cli.dryRun) {
    if (existsSync(dirPath) && !cli.force) {
      console.error(
        `Migration directory already exists: ${join(MIGRATIONS_DIR, dirName)}\n` +
          `Wait a second and re-run, or pass --force to overwrite.`,
      )
      process.exit(1)
    }
  }

  console.log(`[db:migrate:desktop] Computing diff between ${MIGRATIONS_DIR} and ${SCHEMA}...`)
  const result = runMigrateDiff(cli.dryRun ? null : filePath)

  if (result.exitCode !== 0) {
    console.error(`prisma migrate diff failed (exit ${result.exitCode}).`)
    if (result.stdout) console.error(result.stdout)
    if (result.stderr) console.error(result.stderr)
    console.error(
      `\nThis usually means the existing migration history can't be replayed cleanly.\n` +
        `Run \`bun run check:migrations\` to see the underlying SQL error.`,
    )
    process.exit(1)
  }

  // `prisma migrate diff --script` always emits SOMETHING — when
  // there are no changes it prints a comment like "-- This is an
  // empty migration." We detect that by looking for any non-comment,
  // non-blank line.
  const sql = result.stdout
  const hasRealStatements = sql
    .split('\n')
    .some((line) => {
      const t = line.trim()
      return t.length > 0 && !t.startsWith('--')
    })

  if (!hasRealStatements) {
    console.log(`[db:migrate:desktop] No schema changes detected — nothing to do.`)
    console.log(
      `\nIf you expected changes, check that:\n` +
        `  * Your edits to ${SCHEMA} are saved.\n` +
        `  * The model isn't excluded by an @ignore directive.\n` +
        `  * You're running from the repo root (cwd: ${process.cwd()}).`,
    )
    process.exit(0)
  }

  if (cli.dryRun) {
    console.log(`[db:migrate:desktop] --dry-run: would write to ${join(MIGRATIONS_DIR, dirName)}/migration.sql:\n`)
    process.stdout.write(sql)
    process.exit(0)
  }

  mkdirSync(dirPath, { recursive: true })
  // Prepend a header explaining where the migration came from. This
  // is read by humans during code review, by future archeologists,
  // and (importantly) by the check-migrations.ts replay — the header
  // is comment-only so SQLite ignores it.
  const header =
    `-- Migration: ${cli.name}\n` +
    `-- Generated: ${new Date().toISOString()} by scripts/db-migrate-desktop.ts\n` +
    `-- Source:    ${SCHEMA}\n` +
    `--\n` +
    `-- This file was generated by \`bun run db:migrate:desktop --name ${cli.name}\`.\n` +
    `-- The SQL below was emitted verbatim by\n` +
    `--   prisma migrate diff --from-migrations ${MIGRATIONS_DIR} --to-schema ${SCHEMA} --script\n` +
    `-- and is safe to edit by hand BUT consider regenerating via the script\n` +
    `-- instead if the schema changes again — that keeps the migration in lockstep\n` +
    `-- with Prisma's SQLite SQL generator (which handles enums, JSONB, String[],\n` +
    `-- FK inlining, partial indexes, etc. uniformly).\n\n`
  try {
    writeFileSync(filePath, header + sql, 'utf-8')
  } catch (err) {
    // If the write fails (permissions, ENOSPC, etc.) leave behind no
    // half-created directory.
    if (existsSync(dirPath)) {
      try {
        rmSync(dirPath, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
    throw err
  }

  // Echo back the generated SQL so the developer sees what they're
  // about to commit without having to open the file. Truncate at a
  // sensible line count to keep the terminal usable for huge diffs.
  const lines = sql.split('\n')
  const PREVIEW_LINES = 60
  const written = readFileSync(filePath, 'utf-8')
  void written // (kept to make typecheck happy if we later want byte-count metrics)

  console.log(`\n[db:migrate:desktop] Wrote ${sql.length} bytes to ${join(MIGRATIONS_DIR, dirName)}/migration.sql\n`)
  console.log(`--- preview (first ${Math.min(PREVIEW_LINES, lines.length)} of ${lines.length} lines) ---`)
  for (const line of lines.slice(0, PREVIEW_LINES)) console.log(line)
  if (lines.length > PREVIEW_LINES) {
    console.log(`... (${lines.length - PREVIEW_LINES} more lines)`)
  }
  console.log(`--- end preview ---\n`)
  console.log(`Next steps:`)
  console.log(`  1. Review the generated SQL above.`)
  console.log(`  2. Run \`bun run check:migrations\` to verify it replays cleanly across all`)
  console.log(`     historical checkpoints (empty install, mid-trajectory installs, etc.).`)
  console.log(`  3. Commit ${join(MIGRATIONS_DIR, dirName)}/migration.sql alongside your`)
  console.log(`     schema.local.prisma changes in the same PR.`)
  console.log(`  4. If you also changed prisma/schema.prisma, make sure to run`)
  console.log(`     \`bun run db:migrate\` (the PG track) before merging.`)
}

main()
