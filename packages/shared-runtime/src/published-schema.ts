// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Postgres at publish (SHO-308 §1) — the schema half.
 *
 * A published app's database is created by *pushing the app's own
 * `prisma/schema.prisma` at it*, so the two things that need code here are:
 *
 *   1. turning the app's SQLite schema into the Postgres schema that gets pushed
 *      (the provider swap alone is `@shogo-ai/db`'s job — this module adds the
 *      parts a publish needs around it: a hash to decide "is this the same
 *      schema?", and the classification hooks in `published-database.ts`);
 *   2. dumping `prisma/dev.db` into that database for the first deploy of an
 *      environment, in an order Postgres will accept.
 *
 * Nothing here touches a database or a filesystem, so the SQL it produces — and
 * the order it produces it in — is unit-testable.
 */

import { createHash } from 'node:crypto'
import { detectSchemaProvider, transformSchema } from '@shogo-ai/db'

// =============================================================================
// The schema that gets pushed
// =============================================================================

export interface PublishSchema {
  /** Postgres-provider schema text, ready for `prisma db push`. */
  content: string
  /** Stable identity of this schema, stored on the environment row. */
  hash: string
  /** Transformations that changed behaviour, surfaced to the user and the agent. */
  warnings: string[]
  /** False when the app's schema was already Postgres — nothing to transform. */
  transformed: boolean
}

/**
 * Turn an app's Prisma schema into the one its published database gets.
 *
 * An app whose schema is already `postgresql` is passed through untouched: the
 * schema the developer wrote is authoritative, and silently rewriting it would
 * make the published database differ from the one their dev runtime uses.
 */
export function buildPublishSchema(schema: string): PublishSchema {
  const provider = detectSchemaProvider(schema)
  if (!provider) {
    throw new PublishSchemaError(
      'no_provider',
      'prisma/schema.prisma has no datasource provider, so it cannot be applied to the published database',
    )
  }
  if (provider === 'postgresql') {
    return { content: schema, hash: publishedSchemaHash(schema), warnings: [], transformed: false }
  }
  const { content, warnings } = transformSchema(schema, 'postgresql')
  return { content, hash: publishedSchemaHash(content), warnings, transformed: content !== schema }
}

/**
 * Identity of a schema for "has it changed since this database was created?".
 *
 * Whitespace and comments are normalised away first: reformatting a schema must
 * not look like a schema change (it would trigger a push and a seed check on
 * every publish), but any change to a model, field or attribute must.
 */
export function publishedSchemaHash(schema: string): string {
  const normalised = schema
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  return createHash('sha1').update(normalised, 'utf-8').digest('hex')
}

export class PublishSchemaError extends Error {
  constructor(
    public readonly code: 'no_provider' | 'no_models',
    message: string,
  ) {
    super(message)
    this.name = 'PublishSchemaError'
  }
}

// =============================================================================
// Seeding a new database from prisma/dev.db
// =============================================================================

export interface SeedRelation {
  /** Model holding the foreign key. */
  child: string
  /** Model it points at. */
  parent: string
}

export interface SeedTableData {
  /** The physical table name (Prisma's `@@map`, or the model name). */
  table: string
  columns: string[]
  rows: unknown[][]
  /**
   * `id` for a table whose primary key is `Int @id @default(autoincrement())`:
   * the sequence has to be moved past the rows we just inserted, or the first
   * insert the app makes collides with a seeded row.
   */
  serialIdColumn?: string
  /**
   * Columns declared `Boolean` in the schema. Prisma stores a Boolean in SQLite
   * as INTEGER `0`/`1`, and Postgres will not accept an integer for a boolean
   * column, so these values are emitted as `TRUE`/`FALSE` instead.
   */
  booleanColumns?: string[]
}

/**
 * The physical table each model maps to.
 *
 * The SQLite file was written by Prisma, so its table names already are these;
 * seeding only needs the mapping to sort tables by their foreign keys.
 */
export function parseModelTables(schema: string): Map<string, string> {
  const out = new Map<string, string>()
  const blockRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(schema))) {
    const [, model, body] = m
    const map = /@@map\(\s*"([^"]+)"\s*\)/.exec(body!)
    out.set(model!, map?.[1] ?? model!)
  }
  return out
}

/**
 * Foreign keys declared by the schema, as child → parent edges.
 *
 * Only `@relation(fields: [...])` marks the side that holds the key; the other
 * side of the relation is a virtual back-reference and imposes no insert order.
 * A relation with no `fields` argument is that back-reference, so it is skipped.
 */
export function parseSeedRelations(schema: string): SeedRelation[] {
  const out: SeedRelation[] = []
  const blockRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(schema))) {
    const [, child, body] = m
    for (const raw of body!.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('//')) continue
      const field = /^(\w+)\s+(\w+)(\[\])?\S*/.exec(line)
      if (!field) continue
      if (!/@relation\([^)]*fields\s*:\s*\[/.test(line)) continue
      const parent = field[2]
      if (!parent) continue
      // A self-reference is kept: it needs no cross-table ordering (a single
      // multi-row INSERT resolves it at statement end), but the caller should be
      // able to see the schema it was given.
      out.push({ child: child!, parent })
    }
  }
  return out
}

/**
 * Insert order: every table after the tables it references.
 *
 * A cycle (two models referencing each other, or a self-reference) cannot be
 * ordered, so it is left in declaration order — Postgres will then reject the
 * load loudly rather than silently leaving the database half-seeded, and the
 * publish reports `seed_failed` with the offending constraint.
 */
export function orderSeedTables(
  tables: string[],
  relations: SeedRelation[],
  modelTables: Map<string, string>,
): string[] {
  const tableOf = (model: string) => modelTables.get(model) ?? model
  const pending = new Map<string, Set<string>>()
  for (const table of tables) pending.set(table, new Set())
  for (const rel of relations) {
    const child = tableOf(rel.child)
    const parent = tableOf(rel.parent)
    if (child === parent) continue
    if (!pending.has(child) || !pending.has(parent)) continue
    pending.get(child)!.add(parent)
  }

  const ordered: string[] = []
  const placed = new Set<string>()
  let progressed = true
  while (progressed) {
    progressed = false
    for (const table of tables) {
      if (placed.has(table)) continue
      const deps = pending.get(table)
      if (!deps) continue
      for (const dep of deps) {
        if (!placed.has(dep)) continue
        deps.delete(dep)
      }
      if (deps.size === 0) {
        ordered.push(table)
        placed.add(table)
        progressed = true
      }
    }
  }
  for (const table of tables) if (!placed.has(table)) ordered.push(table)
  return ordered
}

/**
 * `Int @id @default(autoincrement())` columns, per physical table.
 *
 * These are the columns whose sequences need re-pointing after a seed.
 */
export function parseSerialIdColumns(schema: string): Map<string, string> {
  const out = new Map<string, string>()
  const modelTables = parseModelTables(schema)
  const blockRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(schema))) {
    const [, model, body] = m
    for (const raw of body!.split('\n')) {
      const line = raw.trim()
      if (!/@id\b/.test(line)) continue
      // `autoincrement()` is SQLite's spelling; the publish transform rewrites it
      // to Postgres's `auto()`, and both are a sequence that has to be moved past
      // the seeded rows.
      if (!/@default\(\s*(?:autoincrement|auto)\(\)\s*\)/.test(line)) continue
      const field = /^(\w+)\s+Int\b/.exec(line)
      if (!field) continue
      out.set(modelTables.get(model!) ?? model!, field[1]!)
      break
    }
  }
  return out
}

/**
 * Columns declared `Boolean` (or `Boolean?`), per physical table.
 *
 * Scalar booleans only: Prisma keeps `Boolean[]` as JSON text, which is not a
 * Postgres `boolean[]` literal and is left to the generic quoting path.
 */
export function parseBooleanColumns(schema: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const modelTables = parseModelTables(schema)
  const blockRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(schema))) {
    const [, model, body] = m
    for (const raw of body!.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('//')) continue
      const field = /^(\w+)\s+Boolean(\?)?\s*(?:@|$)/.exec(line)
      if (!field) continue
      const table = modelTables.get(model!) ?? model!
      const columns = out.get(table) ?? []
      columns.push(field[1]!)
      out.set(table, columns)
    }
  }
  return out
}

/** Quote a Postgres identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Quote a value from SQLite for a Postgres INSERT.
 *
 * SQLite hands back null, numbers, strings, bigints and byte arrays; every other
 * shape (a Date injected by a caller, a boolean) is normalised first so the load
 * cannot fail on a type Postgres would have accepted with a cast.
 */
export function quoteLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL'
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Uint8Array) {
    if (value.length === 0) return "'\\x'::bytea"
    return `'\\x${Buffer.from(value).toString('hex')}'::bytea`
  }
  if (value instanceof Date) return quoteLiteral(value.toISOString())
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * A value from SQLite for a Postgres `boolean` column.
 *
 * Prisma writes `0`/`1` there, so the SQLite value is normalised to a real
 * boolean literal rather than trusting what the driver handed back.
 */
function quoteBoolean(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return value !== 0 ? 'TRUE' : 'FALSE'
  if (typeof value === 'bigint') return value !== BigInt(0) ? 'TRUE' : 'FALSE'
  const text = String(value).trim().toLowerCase()
  if (text === '' || text === 'null') return 'NULL'
  if (text === '0' || text === 'false' || text === 'f') return 'FALSE'
  return 'TRUE'
}

/** Every row as one multi-row `INSERT`, which keeps the load to a few statements. */
export function buildSeedSql(tables: SeedTableData[]): string {
  const statements: string[] = ['BEGIN;']
  for (const table of tables) {
    if (table.rows.length === 0) continue
    const columns = table.columns.map(quoteIdent).join(', ')
    const booleanAt = new Set(
      (table.booleanColumns ?? [])
        .map((column) => table.columns.indexOf(column))
        .filter((index) => index >= 0),
    )
    const values = table.rows
      .map(
        (row) =>
          `(${row
            .map((value, index) => (booleanAt.has(index) ? quoteBoolean(value) : quoteLiteral(value)))
            .join(', ')})`,
      )
      .join(',\n  ')
    statements.push(
      `INSERT INTO ${quoteIdent(table.table)} (${columns}) VALUES\n  ${values};`,
    )
    if (table.serialIdColumn) {
      // `pg_get_serial_sequence` resolves the sequence behind the identity, so
      // the reset works whether the column is `serial` or `GENERATED ... AS
      // IDENTITY`, and a table with no rows is left alone by MAX() + COALESCE.
      statements.push(
        `SELECT setval(pg_get_serial_sequence('${table.table.replace(/'/g, "''")}', '${table.serialIdColumn}'), ` +
          `GREATEST((SELECT COALESCE(MAX(${quoteIdent(table.serialIdColumn)}), 0) FROM ${quoteIdent(table.table)}), 1));`,
      )
    }
  }
  statements.push('COMMIT;')
  return statements.join('\n')
}

/** Rows copied, for the publish report and the agent's tool result. */
export function countSeedRows(tables: SeedTableData[]): { tables: number; rows: number } {
  let rows = 0
  let count = 0
  for (const table of tables) {
    if (table.rows.length === 0) continue
    count += 1
    rows += table.rows.length
  }
  return { tables: count, rows }
}
