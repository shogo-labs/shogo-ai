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
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildPublishSchema,
  buildSeedChunks,
  SEED_CHUNK_SQL_BYTES,
  countSeedRows,
  dropOrphanedSeedRows,
  orderSeedTables,
  parseBooleanColumns,
  parseModelTables,
  parseSeedRelations,
  parseSerialIdColumns,
  PublishSchemaError,
  type SeedOrphan,
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
 *
 * `opts.dbPath` seeds from a database other than the workspace's own: a
 * SQLite→Postgres switchover passes the archive its environment was already
 * serving (see `seedArchive` on {@link exportPublishedSchema}), so the live rows
 * cross over instead of the builder's.
 */
export async function collectSeedTables(
  projectDir: string,
  schema: string,
  opts: { dbPath?: string } = {},
): Promise<SeedTableData[]> {
  const devDb = opts.dbPath ?? join(projectDir, 'prisma', 'dev.db')
  if (!existsSync(devDb)) return []

  // `bun:sqlite` is what the runtime already uses for workspace data; loading it
  // on demand keeps this module importable from plain-Node contexts (scripts,
  // tests) that never touch the seed path.
  const { Database } = await import('bun:sqlite')
  // The workspace's own DB is read-only: nothing here may nudge it. An extracted
  // copy is opened read-write so SQLite can materialise the WAL index — a pod
  // archives `dev.db` and its `-wal` as-is, and a read-only handle fails with
  // SQLITE_CANTOPEN when the `-shm` was not in the same copy. No rows are written.
  const db = opts.dbPath
    ? new Database(devDb, { readwrite: true })
    : new Database(devDb, { readonly: true })
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
 * Largest seed a publish carries back to the API in ONE response body. The SQL
 * travels as one JSON response, so this bounds a request — not the app's data:
 * a seed bigger than this is handed over in several chunks (§G4, `seed.token`).
 */
export const MAX_SEED_SQL_BYTES = 64 * 1024 * 1024

/**
 * Largest seed a publish will load at all. A chunked transfer has no per-request
 * problem left, so this is the real bound: beyond it the publish refuses with a
 * named code instead of filling the API's memory and the database's disk.
 */
export const MAX_SEED_TOTAL_BYTES = 512 * 1024 * 1024

/**
 * Largest live-database archive a publish may hand over, base64. The archive is
 * the environment's own `prisma/` directory (a SQLite file plus at most its two
 * sidecars), and the API refuses anything larger before it gets here; this is
 * the runtime's own bound so a direct caller cannot force an unbounded buffer.
 */
export const MAX_SEED_ARCHIVE_BYTES = 64 * 1024 * 1024

/**
 * Seeds too big for one response body, waiting to be collected chunk by chunk.
 *
 * The token is handed to the API, which asks for chunk 0..n-1 in order and then
 * forgets it. The cache holds at most {@link MAX_SEED_CACHE_ENTRIES} seeds: one
 * publish at a time moves a database, and keeping the previous one would double
 * the memory a 500 MB seed already needs. An entry expires after
 * {@link SEED_TOKEN_TTL_MS} so a publish that dies mid-transfer does not pin it.
 */
export const SEED_TOKEN_TTL_MS = 10 * 60 * 1000
export const MAX_SEED_CACHE_ENTRIES = 2

interface CachedSeed {
  chunks: string[]
  createdAt: number
}

const seedCache = new Map<string, CachedSeed>()

function pruneSeedCache(now: number): void {
  for (const [token, entry] of seedCache) {
    if (now - entry.createdAt > SEED_TOKEN_TTL_MS) seedCache.delete(token)
  }
  while (seedCache.size > MAX_SEED_CACHE_ENTRIES) {
    const oldest = [...seedCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
    if (!oldest) break
    seedCache.delete(oldest[0])
  }
}

/** Register a chunked seed and return the token the API collects it with. */
export function registerSeedChunks(chunks: string[], now = Date.now()): string {
  pruneSeedCache(now)
  const token = randomUUID()
  seedCache.set(token, { chunks, createdAt: now })
  return token
}

export type TakeSeedChunkResult =
  | { ok: true; sql: string; index: number; count: number }
  | { ok: false; code: 'seed_token_expired' | 'seed_chunk_out_of_range'; message: string }

/**
 * One chunk of a registered seed, by index. The entry is dropped once its last
 * chunk has been collected — the API has the seed in its database by then.
 */
export function takeSeedChunk(token: string, index: number, now = Date.now()): TakeSeedChunkResult {
  const entry = seedCache.get(token)
  if (!entry || now - entry.createdAt > SEED_TOKEN_TTL_MS) {
    seedCache.delete(token)
    return {
      ok: false,
      code: 'seed_token_expired',
      message: 'The seed is no longer staged on the runtime (it expired or was collected) — publish again.',
    }
  }
  if (!Number.isInteger(index) || index < 0 || index >= entry.chunks.length) {
    return {
      ok: false,
      code: 'seed_chunk_out_of_range',
      message: `Chunk ${index} does not exist; this seed has ${entry.chunks.length}.`,
    }
  }
  const sql = entry.chunks[index]
  if (index === entry.chunks.length - 1) seedCache.delete(token)
  return { ok: true, sql, index, count: entry.chunks.length }
}

/** Test seam: forget every staged seed. */
export function clearSeedCache(): void {
  seedCache.clear()
}

export type ExportPublishedSchemaResult =
  | {
      ok: true
      schema: ResolvedPublishSchema
      /**
       * Null when no seed was asked for, or the database holds no rows.
       *
       * `sql` is present only when the whole seed fits one response body. A
       * bigger seed is registered under `token` instead and fetched chunk by
       * chunk with {@link takeSeedChunk}, so the 64 MB bound stays a bound on
       * one request rather than on what an app may own.
       */
      seed: {
        sql?: string
        token?: string
        tables: number
        rows: number
        chunkCount: number
      } | null
      /** Where the seed's rows came from, when a seed was produced. */
      seedSource?: 'workspace' | 'archive'
      /**
       * Rows that were left out of the seed because their FK target was deleted.
       * Non-empty only when a seed was produced. The rows remain in the SQLite
       * archive, which is never deleted, so they can be recovered.
       */
      orphans?: SeedOrphan[]
    }
  | { ok: false; code: string; message: string; status: number }

/**
 * Everything a publish needs from the workspace to build the app's database:
 * the Postgres schema and, on an environment's first deploy, a database as seed
 * SQL.
 *
 * The seed normally comes from the workspace's `prisma/dev.db`. `opts.seedArchive`
 * replaces it: a gzipped tar of the live environment's `prisma/` directory,
 * read out of its published-data archive. That is the SQLite→Postgres
 * switchover — the rows the live site accumulated cross over instead of the
 * builder's sample data (SHO-514). The archive is the API's input; this side only
 * converts it to SQL, so the SQLite→Postgres conversion lives in exactly one
 * place and the runtime is still never handed a database URL.
 *
 * Nothing here touches the published database. The API runs the push and the
 * load from inside the cluster, where `projects-pg` is reachable: a runtime can
 * live on a host outside the cluster network (a metal VM), and the database URL
 * — a credential — never has to enter a sandbox that runs user code.
 */
export async function exportPublishedSchema(
  projectDir: string,
  opts: {
    seed?: boolean
    seedArchive?: string
    /** Bytes per seed chunk; the default is {@link SEED_CHUNK_SQL_BYTES}. */
    seedChunkBytes?: number
  } = {},
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

  let tmpDir: string | null = null
  let tables: SeedTableData[]
  try {
    let dbPath: string | undefined
    let seedSource: 'workspace' | 'archive' = 'workspace'
    if (opts.seedArchive) {
      const archive = Buffer.from(opts.seedArchive, 'base64')
      if (archive.byteLength > MAX_SEED_ARCHIVE_BYTES) {
        return {
          ok: false,
          code: 'seed_archive_too_large',
          message:
            `The live database archive is ${(archive.byteLength / (1024 * 1024)).toFixed(0)} MB; ` +
            `a publish seeds at most ${MAX_SEED_ARCHIVE_BYTES / (1024 * 1024)} MB.`,
          status: 413,
        }
      }
      tmpDir = await mkdtemp(join(tmpdir(), 'shogo-live-seed-'))
      const archivePath = join(tmpDir, 'live-seed.tar.gz')
      await writeFile(archivePath, archive)
      const tar = await import('tar')
      // Only the database files: the archive the API sends holds nothing else,
      // and a pattern keeps a malformed one from writing outside the temp dir.
      await tar.extract({
        file: archivePath,
        cwd: tmpDir,
        filter: (path) => /^prisma\/dev\.db(-wal|-shm)?$/.test(path.replace(/^\.\//, '')),
      })
      const extracted = join(tmpDir, 'prisma', 'dev.db')
      if (!existsSync(extracted)) {
        return {
          ok: false,
          code: 'seed_archive_invalid',
          message: 'The live database archive contained no prisma/dev.db to seed from.',
          status: 400,
        }
      }
      dbPath = extracted
      seedSource = 'archive'
    }

    const rawTables = await collectSeedTables(projectDir, resolved.content, dbPath ? { dbPath } : {})
    const { tables: cleanTables, orphans } = dropOrphanedSeedRows(
      rawTables,
      parseSeedRelations(resolved.content),
      parseModelTables(resolved.content),
    )
    if (orphans.length > 0) {
      console.warn(
        `[published-schema] dropping ${orphans.map((o) => `${o.count} orphaned row(s) from ${o.table}`).join(', ')} ` +
          `(FK targets deleted; rows stay in the SQLite archive)`,
      )
    }
    tables = cleanTables
    const counted = countSeedRows(tables)
    if (counted.rows === 0 && orphans.length === 0) return { ok: true, schema: resolved, seed: null, orphans: [] }
    if (counted.rows === 0) return { ok: true, schema: resolved, seed: null, orphans }
    const chunks = buildSeedChunks(tables, opts.seedChunkBytes ?? SEED_CHUNK_SQL_BYTES)
    const bytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk, 'utf-8'), 0)
    if (bytes > MAX_SEED_TOTAL_BYTES) {
      return {
        ok: false,
        code: 'seed_too_large',
        message:
          `The seed database is ${Math.round(bytes / (1024 * 1024))} MB as SQL; a publish loads at most ` +
          `${MAX_SEED_TOTAL_BYTES / (1024 * 1024)} MB. Remove rows the published app does not need and publish again.`,
        status: 413,
      }
    }
    if (chunks.length === 1) {
      return { ok: true, schema: resolved, seed: { sql: chunks[0], chunkCount: 1, ...counted }, seedSource, orphans }
    }
    const token = registerSeedChunks(chunks)
    console.log(
      `[published-schema] seed is ${(bytes / (1024 * 1024)).toFixed(1)} MB in ${chunks.length} chunks ` +
        `(over the ${MAX_SEED_SQL_BYTES / (1024 * 1024)} MB single-response limit) — handing it over as ${token}`,
    )
    return {
      ok: true,
      schema: resolved,
      seed: { token, chunkCount: chunks.length, ...counted },
      seedSource,
      orphans,
    }
  } catch (err: any) {
    return {
      ok: false,
      code: 'seed_failed',
      message: `The seed database could not be read: ${err?.message ?? err}`,
      status: 400,
    }
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

