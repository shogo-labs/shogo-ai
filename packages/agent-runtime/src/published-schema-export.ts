// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The workspace half of building an app's published database (SHO-308 §1).
 *
 * The runtime is the only place with the app's `prisma/schema.prisma` and its
 * `prisma/dev.db`, so it turns them into what the database needs: the schema
 * converted for Postgres, and the dev rows as seed SQL. It never connects to the
 * published database. The API pushes both from inside the cluster
 * (apps/api/src/services/published-schema-push.ts), because a runtime may sit on
 * a host outside the cluster network, and a database credential should not be
 * handed to a sandbox that runs user code.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  buildPublishSchema,
  buildSeedSql,
  countSeedRows,
  orderSeedTables,
  parseBooleanColumns,
  parseModelTables,
  parseSeedRelations,
  parseSerialIdColumns,
  PublishSchemaError,
  type SeedTableData,
} from '@shogo/shared-runtime/published-schema'

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

/**
 * Largest seed a publish carries back to the API. The SQL travels as one JSON
 * response, so a workspace whose `dev.db` holds more than this is refused with a
 * clear code instead of an out-of-memory somewhere along the way.
 */
export const MAX_SEED_SQL_BYTES = 64 * 1024 * 1024

export type ExportPublishedSchemaResult =
  | {
      ok: true
      schema: ResolvedPublishSchema
      /** Null when no seed was asked for, or `dev.db` holds no rows. */
      seed: { sql: string; tables: number; rows: number } | null
    }
  | { ok: false; code: string; message: string; status: number }

/**
 * Everything a publish needs from the workspace to build the app's database:
 * the Postgres schema and, on an environment's first deploy, `prisma/dev.db` as
 * seed SQL.
 *
 * Nothing here touches the published database. The API runs the push and the
 * load from inside the cluster, where `projects-pg` is reachable: a runtime can
 * live on a host outside the cluster network (a metal VM), and the database URL
 * — a credential — never has to enter a sandbox that runs user code.
 */
export async function exportPublishedSchema(
  projectDir: string,
  opts: { seed?: boolean } = {},
): Promise<ExportPublishedSchemaResult> {
  let resolved: ResolvedPublishSchema | null
  try {
    resolved = resolvePublishSchema(projectDir)
  } catch (err: any) {
    if (err instanceof PublishSchemaError) return { ok: false, code: err.code, message: err.message, status: 400 }
    return { ok: false, code: 'schema_invalid', message: err?.message ?? 'Could not read the schema', status: 400 }
  }
  if (!resolved) {
    return {
      ok: false,
      code: 'no_schema',
      message: 'This app has no Prisma models, so it has no published database to apply.',
      status: 400,
    }
  }
  if (!opts.seed) return { ok: true, schema: resolved, seed: null }

  let tables: SeedTableData[]
  try {
    tables = await collectSeedTables(projectDir, resolved.content)
  } catch (err: any) {
    return {
      ok: false,
      code: 'seed_failed',
      message: `prisma/dev.db could not be read: ${err?.message ?? err}`,
      status: 400,
    }
  }
  const counted = countSeedRows(tables)
  if (counted.rows === 0) return { ok: true, schema: resolved, seed: null }
  const sql = buildSeedSql(tables)
  const bytes = Buffer.byteLength(sql, 'utf-8')
  if (bytes > MAX_SEED_SQL_BYTES) {
    return {
      ok: false,
      code: 'seed_too_large',
      message:
        `prisma/dev.db is ${Math.round(bytes / (1024 * 1024))} MB as SQL; a publish seeds at most ` +
        `${MAX_SEED_SQL_BYTES / (1024 * 1024)} MB. Remove rows the published app does not need and publish again.`,
      status: 413,
    }
  }
  return { ok: true, schema: resolved, seed: { sql, ...counted } }
}

