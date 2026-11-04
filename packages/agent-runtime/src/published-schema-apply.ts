// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Applying an app's schema to its published database (SHO-308 §1).
 *
 * Runs inside the project's runtime, which is the only place that has all three
 * things a schema push needs: the app's `prisma/schema.prisma`, its
 * `prisma/dev.db`, and a `prisma` CLI that resolves from the app's own
 * `node_modules`. The API calls `/agent/published-schema` and never shells out
 * to Prisma itself.
 *
 * The push targets the *direct* connection, never the PgBouncer pooler: DDL in
 * transaction mode can land on different backends, and Prisma takes session
 * locks while it runs.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pkg } from '@shogo/shared-runtime'
import {
  buildPublishSchema,
  buildSeedSql,
  countSeedRows,
  orderSeedTables,
  parseBooleanColumns,
  parseModelTables,
  parseSeedRelations,
  parseSerialIdColumns,
  publishedSchemaHash,
  PublishSchemaError,
  type SeedTableData,
} from '@shogo/shared-runtime/published-schema'

/** How long a schema push or seed load may take before the publish gives up. */
const APPLY_TIMEOUT_MS = 120_000

export interface ResolvedPublishSchema {
  /** Postgres-provider schema, as pushed. */
  content: string
  hash: string
  warnings: string[]
  /** False when the app's own schema was already Postgres. */
  transformed: boolean
}

/**
 * The app's schema, converted for its published database, or `null` when the
 * project has no schema (a static app, or one with no models at all).
 */
export function resolvePublishSchema(projectDir: string): ResolvedPublishSchema | null {
  const schemaPath = join(projectDir, 'prisma', 'schema.prisma')
  if (!existsSync(schemaPath)) return null
  let raw: string
  try {
    raw = readFileSync(schemaPath, 'utf-8')
  } catch {
    return null
  }
  if (!/^\s*model\s+\w+/m.test(raw)) return null
  const built = buildPublishSchema(raw)
  return {
    content: built.content,
    hash: built.hash,
    warnings: built.warnings,
    transformed: built.transformed,
  }
}

/**
 * Read every row of `prisma/dev.db` in an order Postgres will accept.
 *
 * Returns an empty list when the workspace has no SQLite file (a fresh app that
 * has never run) — seeding nothing is correct there, and a first deploy still
 * gets the schema.
 */
export async function collectSeedTables(projectDir: string, schema: string): Promise<SeedTableData[]> {
  const devDb = join(projectDir, 'prisma', 'dev.db')
  if (!existsSync(devDb)) return []

  // `bun:sqlite` is what the runtime already uses for workspace data; loading it
  // on demand keeps this module importable from plain-Node contexts (scripts,
  // tests) that never touch the seed path.
  const { Database } = await import('bun:sqlite')
  const db = new Database(devDb, { readonly: true })
  try {
    const tableNames = (
      db
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)

    const serialColumns = parseSerialIdColumns(schema)
    const booleanColumns = parseBooleanColumns(schema)
    const ordered = orderSeedTables(tableNames, parseSeedRelations(schema), parseModelTables(schema))

    const tables: SeedTableData[] = []
    for (const table of ordered) {
      const columns = (db.query(`PRAGMA table_info(${quoteSqliteIdent(table)})`).all() as Array<{
        name: string
      }>).map((col) => col.name)
      if (columns.length === 0) continue
      const rows = db
        .query(`SELECT ${columns.map(quoteSqliteIdent).join(', ')} FROM ${quoteSqliteIdent(table)}`)
        .all() as Array<Record<string, unknown>>
      tables.push({
        table,
        columns,
        rows: rows.map((row) => columns.map((col) => row[col] ?? null)),
        serialIdColumn: serialColumns.get(table),
        booleanColumns: booleanColumns.get(table),
      })
    }
    return tables
  } finally {
    db.close()
  }
}

function quoteSqliteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export interface ApplyPublishedSchemaInput {
  projectDir: string
  /** Direct (non-pooled) Postgres URL — DDL must not run through PgBouncer. */
  databaseUrl: string
  /** Load `prisma/dev.db` into the database after the push. */
  seed?: boolean
}

export type ApplyPublishedSchemaResult =
  | {
      ok: true
      hash: string
      warnings: string[]
      seeded: { tables: number; rows: number }
    }
  | { ok: false; code: string; message: string }

/**
 * Push the app's schema at the environment's database, then (optionally) load
 * the seed rows.
 *
 * The push and the load are separate Prisma invocations against one shared temp
 * directory so the SQL Prisma generates and the data it is given come from the
 * *same* schema — a schema edited mid-publish cannot produce a load that
 * disagrees with the tables it is loading into.
 */
export async function applyPublishedSchema(
  input: ApplyPublishedSchemaInput,
): Promise<ApplyPublishedSchemaResult> {
  let resolved: ResolvedPublishSchema | null
  try {
    resolved = resolvePublishSchema(input.projectDir)
  } catch (err: any) {
    if (err instanceof PublishSchemaError) return { ok: false, code: err.code, message: err.message }
    return { ok: false, code: 'schema_invalid', message: err?.message ?? 'Could not read the schema' }
  }
  if (!resolved) {
    return {
      ok: false,
      code: 'no_schema',
      message: 'This app has no Prisma models, so it has no published database to apply.',
    }
  }

  const workDir = join(input.projectDir, '.shogo', 'published-schema')
  mkdirSync(workDir, { recursive: true })
  const schemaPath = join(workDir, 'schema.prisma')
  const configPath = join(workDir, 'prisma.config.ts')
  const sqlPath = join(workDir, 'seed.sql')
  try {
    writeFileSync(schemaPath, resolved.content, 'utf-8')
    // Prisma 7 reads the connection string from the config, not the schema, so
    // the temp directory carries its own config: the workspace's points at the
    // app's SQLite file, and pointing it at Postgres instead would make the dev
    // runtime push to the published database.
    writeFileSync(
      configPath,
      [
        `import { defineConfig } from 'prisma/config'`,
        ``,
        `export default defineConfig({`,
        `  schema: './schema.prisma',`,
        `  datasource: { url: process.env.PUBLISHED_DATABASE_URL },`,
        `})`,
        ``,
      ].join('\n'),
      'utf-8',
    )

    const env = { ...process.env, PUBLISHED_DATABASE_URL: input.databaseUrl }
    try {
      await pkg.execToolAsync(
        'prisma',
        ['db', 'push', '--skip-generate', '--schema', schemaPath],
        input.projectDir,
        { env, timeout: APPLY_TIMEOUT_MS },
      )
    } catch (err: any) {
      const message = String(err?.message ?? err)
      return {
        ok: false,
        code: 'schema_push_failed',
        message: `Could not apply the schema to the published database: ${tailLines(message, 6)}`,
      }
    }

    let seeded = { tables: 0, rows: 0 }
    if (input.seed) {
      let tables: SeedTableData[]
      try {
        tables = await collectSeedTables(input.projectDir, resolved.content)
      } catch (err: any) {
        return {
          ok: false,
          code: 'seed_failed',
          message: `Schema applied, but prisma/dev.db could not be read: ${err?.message ?? err}`,
        }
      }
      seeded = countSeedRows(tables)
      if (seeded.rows > 0) {
        writeFileSync(sqlPath, buildSeedSql(tables), 'utf-8')
        try {
          await pkg.execToolAsync(
            'prisma',
            ['db', 'execute', '--schema', schemaPath, '--file', sqlPath],
            input.projectDir,
            { env, timeout: APPLY_TIMEOUT_MS },
          )
        } catch (err: any) {
          const message = String(err?.message ?? err)
          return {
            ok: false,
            code: 'seed_failed',
            message: `Schema applied, but the seed data did not load: ${tailLines(message, 6)}`,
          }
        }
      }
    }

    return { ok: true, hash: publishedSchemaHash(resolved.content), warnings: resolved.warnings, seeded }
  } finally {
    try {
      rmSync(sqlPath, { force: true })
    } catch {
      // Nothing to reclaim if it was never written.
    }
    // The schema + config stay behind: they are the record of what this app's
    // published database was built from, and they are small. Everything else
    // (the seed SQL) is cleaned up.
  }
}

/** The useful end of a Prisma CLI error, for the publish error message. */
function tailLines(text: string, lines: number): string {
  const split = text.trim().split('\n').filter(Boolean)
  return split.slice(-lines).join(' ').slice(0, 600)
}
