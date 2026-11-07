// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Cutover of a metal-live published site to Knative + Postgres (SHO-308 §7).
 *
 * A site that is live on metal keeps its SQLite database inside a
 * `published:{id}` microVM and its data in `{subdomain}/data.tar.gz`. Moving it
 * to Knative means moving that data into Postgres, and the only moment the site
 * can be paused is the final copy. So every site runs in TWO phases:
 *
 *   1. PREPARE (site stays live on metal, no user impact)
 *      - `production` environment row, its Postgres database and the app's schema
 *      - one image for the live commit (reused if that commit was built before)
 *      - a warm ksvc at `min-scale: 1` — created, never given traffic
 *      - a TRIAL LOAD of the current archive into a copy of the database, which
 *        proves the import works and times it
 *
 *   2. SWITCH (the only downtime, timed end to end)
 *      - maintenance on: the API's published proxy answers 503 instead of
 *        waking the microVM, so a request during the freeze cannot resume it and
 *        write past the export (`publishStatus: "switching"`)
 *      - stop the microVM — the host exports the final `data.tar.gz`
 *      - wait for a *fresh* archive, then truncate + reload Postgres from it
 *      - compare per-table row counts; a mismatch aborts
 *      - flip the edge flag to `knative`, health-check, maintenance off
 *      - release the microVM (the archive is kept)
 *
 * Over budget or any aborted step → automatic rollback: the edge flag goes back
 * to `metal` and the microVM resumes from its untouched snapshot, so the site is
 * serving again on the data it had before the switch started.
 *
 * `rehearse` runs phase 1 plus the *timed* part of phase 2 against a copy: a
 * template copy of the database (`CREATE DATABASE … TEMPLATE`) and a
 * `published-{id}-rehearsal` ksvc. It never stops the microVM, never flips the
 * edge flag and never writes a live row, which is what makes the measurement
 * safe to run on production sites.
 *
 * Everything observable is behind {@link CutoverDeps}: the orchestration — the
 * ordering, the maintenance window, the budget, the rollback — is exercised in
 * unit tests with fakes, because none of it can be proved from a cluster.
 */

import Database from 'bun:sqlite'
import { Pool } from 'pg'
import type { PublishedSize } from '../lib/published-scale'
import type { PublishedEnvironmentName } from '@shogo/shared-runtime/published-database'

/** The environment status that puts a site into its maintenance window. */
export const MAINTENANCE_ENV_STATUS = 'switching'

/**
 * Whether a site is frozen mid-cutover right now.
 *
 * One definition on purpose: the migration writes the status and the API's wake
 * and proxy paths read it, and the whole freeze guarantee depends on those two
 * agreeing. A wake that slipped through would resume the microVM and let it
 * write past the export that is being copied.
 */
export function isMidCutoverStatus(publishStatus: string | null | undefined): boolean {
  return (publishStatus ?? '').toLowerCase() === MAINTENANCE_ENV_STATUS
}

/** A status the switch writes when it gives up. */
export const FAILED_ENV_STATUS = 'failed'

/** A status a site is left in once it is live on its new substrate. */
export const LIVE_ENV_STATUS = 'live'

/**
 * How much clock slack we allow between "we froze it" and the archive's
 * `LastModified`. S3 timestamps second-granularity on some providers and the
 * freeze and the object write are different machines, so an exact comparison
 * would reject a correct export.
 */
export const ARCHIVE_FRESHNESS_GRACE_MS = 5_000

/** The published-data key that holds a site's writable state. */
export function cutoverArchiveKey(subdomain: string): string {
  return `${subdomain}/data.tar.gz`
}

export interface ArchiveObject {
  key: string
  bytes: number
  /** `LastModified` in epoch ms. */
  lastModifiedMs: number
}

/** True when the archive was written at or after the freeze that asked for it. */
export function isArchiveFresh(
  archive: ArchiveObject | null,
  frozenAtMs: number,
  graceMs: number = ARCHIVE_FRESHNESS_GRACE_MS,
): boolean {
  if (!archive) return false
  if (!Number.isFinite(archive.lastModifiedMs)) return false
  return archive.lastModifiedMs >= frozenAtMs - graceMs
}

export interface ArchiveWaitOptions {
  head: () => Promise<ArchiveObject | null>
  frozenAtMs: number
  timeoutMs: number
  intervalMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  graceMs?: number
}

/**
 * Poll for an archive written at or after the freeze.
 *
 * Returns null when the deadline passes without one. That is a *failed* switch,
 * not a warning: the whole point of the freeze is that the archive carries the
 * last write, so importing an older one would silently drop it.
 */
export async function waitForFreshArchive(opts: ArchiveWaitOptions): Promise<ArchiveObject | null> {
  const deadline = opts.now() + opts.timeoutMs
  // Always check once before waiting: a host that exported during the freeze
  // usually has the object in place by the time the stop call returns.
  for (;;) {
    const archive = await opts.head().catch(() => null)
    if (isArchiveFresh(archive, opts.frozenAtMs, opts.graceMs)) return archive
    if (opts.now() >= deadline) return null
    await opts.sleep(opts.intervalMs)
  }
}

export interface RowCountMismatch {
  table: string
  sqlite: number
  postgres: number
  reason: 'missing_table' | 'count'
}

/**
 * Compare per-table row counts between the archive and Postgres.
 *
 * A table Postgres cannot count (the push never created it) is reported as
 * `missing_table` with -1, rather than being skipped: a table that does not
 * exist is the loudest possible mismatch.
 */
export function diffRowCounts(
  sqlite: Map<string, number>,
  postgres: Map<string, number>,
): RowCountMismatch[] {
  const out: RowCountMismatch[] = []
  for (const [table, expected] of sqlite) {
    const actual = postgres.get(table)
    if (actual === undefined || actual < 0) {
      out.push({ table, sqlite: expected, postgres: -1, reason: 'missing_table' })
      continue
    }
    if (actual !== expected) out.push({ table, sqlite: expected, postgres: actual, reason: 'count' })
  }
  return out
}

/** Per-table counts from a SQLite archive, for the post-switch comparison. */
export function countSqliteRows(sqlitePath: string): Map<string, number> {
  const sqlite = new Database(sqlitePath, { readonly: true })
  try {
    const tables = sqlite
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`)
      .all() as Array<{ name: string }>
    const out = new Map<string, number>()
    for (const { name } of tables) {
      const row = sqlite.query(`SELECT COUNT(*) as c FROM "${name}"`).get() as { c: number }
      out.set(name, row.c)
    }
    return out
  } finally {
    sqlite.close()
  }
}

/** Count each table in Postgres; -1 when it does not exist. */
export async function countPostgresRows(
  databaseUrl: string,
  tables: string[],
): Promise<Map<string, number>> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000 })
  const client = await pool.connect()
  try {
    const out = new Map<string, number>()
    for (const table of tables) {
      try {
        const res = await client.query(`SELECT COUNT(*)::int AS c FROM "${table}"`)
        out.set(table, res.rows[0].c as number)
      } catch {
        out.set(table, -1)
      }
    }
    return out
  } finally {
    client.release()
    await pool.end().catch(() => {})
  }
}

export interface TableCopyResult {
  table: string
  rows: number
}

/**
 * Read every user table from the exported SQLite archive in foreign-key order,
 * insert the rows into Postgres, and reset the sequences.
 *
 * Rows are chunked so a large table doesn't build one giant statement. Ids are
 * inserted verbatim (`OVERRIDING SYSTEM VALUE`), which is what keeps a row
 * written right before the freeze readable after the switch.
 */
export async function copySqliteToPostgres(
  sqlitePath: string,
  databaseUrl: string,
  opts: { truncate?: boolean } = {},
): Promise<TableCopyResult[]> {
  const sqlite = new Database(sqlitePath, { readonly: true })
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000 })
  const client = await pool.connect()
  try {
    const tables = sqlite
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`)
      .all() as Array<{ name: string }>

    // Topological order: a table is emitted after every table it references.
    const deps = new Map<string, Set<string>>()
    for (const { name } of tables) {
      const fks = sqlite.query(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as Array<{ table: string }>
      deps.set(name, new Set(fks.map((f) => f.table).filter((t) => t !== name)))
    }
    const ordered: string[] = []
    const seen = new Set<string>()
    const visit = (name: string, stack: Set<string>) => {
      if (seen.has(name) || stack.has(name)) return
      stack.add(name)
      for (const dep of deps.get(name) ?? []) visit(dep, stack)
      stack.delete(name)
      seen.add(name)
      ordered.push(name)
    }
    for (const { name } of tables) visit(name, new Set())

    const results: TableCopyResult[] = []
    await client.query('BEGIN')
    try {
      if (opts.truncate) {
        const list = ordered.map((t) => `"${t}"`).join(', ')
        if (list) await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
      }
      for (const table of ordered) {
        const rows = sqlite.query(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>
        if (rows.length === 0) {
          results.push({ table, rows: 0 })
          continue
        }
        const columns = Object.keys(rows[0])
        const colList = columns.map((c) => `"${c}"`).join(', ')
        const CHUNK = 200
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK)
          const values: unknown[] = []
          const tuples = chunk.map((row) => {
            const placeholders = columns.map((c) => {
              values.push(row[c])
              return `$${values.length}`
            })
            return `(${placeholders.join(', ')})`
          })
          await client.query(
            `INSERT INTO "${table}" (${colList}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
            values,
          )
        }
        results.push({ table, rows: rows.length })
      }

      // Reset sequences for serial/identity columns so new inserts don't collide.
      const seqs = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns WHERE column_default LIKE 'nextval(%'`,
      )
      for (const row of seqs.rows) {
        await client
          .query(
            `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX("${row.column_name}") FROM "${row.table_name}"), 1))`,
            [`"${row.table_name}"`, row.column_name],
          )
          .catch(() => {})
      }

      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    }
    return results
  } finally {
    client.release()
    await pool.end().catch(() => {})
    sqlite.close()
  }
}

/**
 * Read the entries of a gzipped tar held in memory.
 *
 * Deliberately dependency-free: the API only needs to pull one file out of an
 * archive it already holds as a Buffer (the runtime hands it over base64), so a
 * tar reader here would be a new runtime dependency for `tar.x` on a temp file.
 * The format needed is small and stable: 512-byte headers, a 100-byte NUL-padded
 * name (plus the `ustar` prefix at 345), an octal size, and a typeflag at 156.
 * PAX/GNU extended headers (`x`, `g`, `L`, `K`) are skipped along with their
 * payload rather than parsed — every real entry after them carries its own name.
 */
export function readTarGzEntries(gz: Buffer): Array<{ path: string; content: Buffer }> {
  // `Bun.gunzipSync` hands back a Uint8Array, whose `toString` joins numbers —
  // wrapping it in a Buffer is what makes `toString('utf8')` read the name.
  const buf = Buffer.from(Bun.gunzipSync(new Uint8Array(gz)))
  const entries: Array<{ path: string; content: Buffer }> = []
  let offset = 0
  const cString = (start: number, length: number) => {
    const slice = buf.subarray(start, start + length)
    const end = slice.indexOf(0)
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
  }
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    // Two zero blocks end the archive.
    if (header.every((b) => b === 0)) break
    const name = cString(offset, 100)
    const prefix = cString(offset + 345, 155)
    const sizeField = cString(offset + 124, 12).trim()
    const size = sizeField ? parseInt(sizeField, 8) : 0
    const type = String.fromCharCode(buf[offset + 156] || 48)
    const dataStart = offset + 512
    const dataEnd = dataStart + (Number.isFinite(size) ? size : 0)
    const full = prefix ? `${prefix}/${name}` : name
    // Only regular files can be extracted; directories and links carry no content.
    if ((type === '0' || type === '\0') && full) {
      entries.push({ path: full.replace(/^\.\//, ''), content: buf.subarray(dataStart, dataEnd) })
    }
    // Headers and data are padded out to a 512-byte boundary.
    offset = dataStart + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512
  }
  return entries
}

export interface ExtractedArchive {
  dir: string
  sqlitePath: string
  cleanup: () => Promise<void>
}

/**
 * Unpack a `data.tar.gz` and find the SQLite database inside it.
 *
 * The archive is rooted at the project directory, so the database is
 * `prisma/dev.db` (`dev.db` for a legacy layout). Extracting to a temp dir keeps
 * the live pod's files untouched — the copy we import is a point-in-time export,
 * which is the whole reason the freeze exists.
 */
export async function extractSqliteFromArchive(archive: Buffer | string): Promise<ExtractedArchive> {
  const { mkdtemp, mkdir, rm, writeFile } = await import('fs/promises')
  const os = await import('os')
  const path = await import('path')

  const buf = typeof archive === 'string' ? Buffer.from(archive, 'base64') : archive
  const candidates = ['prisma/dev.db', 'dev.db']
  let entries: Array<{ path: string; content: Buffer }>
  try {
    entries = readTarGzEntries(buf)
  } catch (err: any) {
    throw new Error(`The exported archive is not a readable gzipped tar: ${err?.message ?? String(err)}`)
  }
  const wanted = candidates.map((c) => entries.find((e) => e.path === c)).find(Boolean)
  if (!wanted) {
    throw new Error(`The exported archive has no prisma/dev.db (looked for ${candidates.join(', ')})`)
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'shogo-cutover-'))
  const sqlitePath = path.join(dir, wanted.path)
  await mkdir(path.dirname(sqlitePath), { recursive: true })
  await writeFile(sqlitePath, wanted.content)
  return { dir, sqlitePath, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface CutoverSite {
  projectId: string
  subdomain: string
  alwaysOn?: boolean
}

export interface CutoverEnvironment {
  id: string
  name: PublishedEnvironmentName
  subdomain: string
  minReplicas: number
  maxReplicas: number
  size: PublishedSize
  dbProvider: string | null
  dbName: string | null
  currentDeploymentId: string | null
}

export interface CutoverImage {
  imageRef: string
  imageDigest: string
  reused: boolean
}

export type CutoverOk<T> = { ok: true; value: T }
export type CutoverFailure = { ok: false; code: string; message: string; details?: Record<string, unknown> }

/** Everything the orchestration needs from the outside world. */
export interface CutoverDeps {
  now(): number
  sleep(ms: number): Promise<void>
  log(message: string): void

  ensureEnvironment(site: CutoverSite): Promise<CutoverEnvironment>
  /** Provision the environment's database, apply the schema, seed it (first deploy). */
  prepareDatabase(site: CutoverSite): Promise<CutoverOk<{ databaseName: string; directUrl: string }> | CutoverFailure>
  ensureImage(site: CutoverSite, env: CutoverEnvironment): Promise<CutoverOk<CutoverImage> | CutoverFailure>
  ensureWarmService(
    site: CutoverSite,
    opts: { env: CutoverEnvironment; imageRef?: string; serviceName?: string; minScale: number },
  ): Promise<void>
  deleteService(site: CutoverSite, serviceName: string): Promise<void>
  healthCheck(site: CutoverSite, opts?: { serviceName?: string; timeoutMs?: number }): Promise<boolean>
  /**
   * Phase 1: block until the warm ksvc answers `/ready`. POSTing the Knative
   * service is not the same as having a pod — the image pull and the
   * init-container's S3 sync happen on the first start — and both belong to
   * phase 1, where nobody is waiting.
   */
  waitForServiceReady(site: CutoverSite, opts: { serviceName?: string; timeoutMs: number }): Promise<boolean>

  headArchive(subdomain: string): Promise<ArchiveObject | null>
  downloadArchive(key: string): Promise<Buffer>

  /** Stop the microVM so the host exports its final archive. */
  freezeMetal(site: CutoverSite): Promise<void>
  /** Resume the microVM from its snapshot (rollback). */
  resumeMetal(site: CutoverSite): Promise<void>
  /** Destroy the microVM for good; the archive is kept. */
  releaseMetal(site: CutoverSite): Promise<void>

  readEdgeBackend(subdomain: string): Promise<'knative' | 'metal' | null>
  setEdgeBackend(subdomain: string, backend: 'knative' | 'metal'): Promise<boolean>

  /** Maintenance window: the published proxy refuses to wake the microVM. */
  setMaintenance(site: CutoverSite, envId: string, on: boolean, detail?: string | null): Promise<void>

  /** Put an environment back on SQLite: `dbProvider` null. */
  markDatabaseLocal(site: CutoverSite, envId: string): Promise<void>

  /** A throwaway copy of an environment's database for a rehearsal. */
  cloneDatabase(sourceName: string, targetName: string): Promise<{ directUrl: string }>
  dropClone(targetName: string): Promise<void>
  countPostgres(databaseUrl: string, tables: string[]): Promise<Map<string, number>>

  recordDeployment(site: CutoverSite, envId: string, image: CutoverImage): Promise<void>

  /** Import an archive into a database and prove every row arrived. */
  importArchive(
    archive: Buffer,
    databaseUrl: string,
    opts: { truncate: boolean },
  ): Promise<CutoverOk<{ rows: number }> | (CutoverFailure & { mismatches?: RowCountMismatch[] })>
}

export type CutoverOutcome = 'migrated' | 'rehearsed' | 'restored' | 'rolled-back' | 'failed' | 'dry-run'

export interface CutoverResult {
  projectId: string
  subdomain: string
  dbBytes: number
  prepareMs: number
  downtimeMs: number | null
  outcome: CutoverOutcome
  code?: string
  message?: string
  mismatches?: RowCountMismatch[]
}

export interface PreparedSite {
  site: CutoverSite
  env: CutoverEnvironment
  database: { databaseName: string; directUrl: string }
  image: CutoverImage
  prepareMs: number
}

export interface SwitchOptions {
  maxDowntimeMs: number
  /** How long to wait for the host's final export after the freeze. */
  archiveTimeoutMs?: number
}

const DEFAULT_ARCHIVE_TIMEOUT_MS = 90_000
const DEFAULT_ARCHIVE_POLL_MS = 2_000
const HEALTH_PROBE_TIMEOUT_MS = 5_000
const HEALTH_CHECK_INTERVAL_MS = 1_500
/**
 * A backstop against a clock that does not advance, not a real limit: in phase 2
 * the deadline is the downtime budget, and in phase 1 it is the readiness
 * timeout. Both are far shorter than this.
 */
const HEALTH_CHECK_MAX_PROBES = 2_000
/** Phase 1's readiness wait: image pull + the init-container's S3 sync. Not downtime. */
const DEFAULT_READINESS_TIMEOUT_MS = 300_000
const READINESS_POLL_MS = 2_000

export type ReadyOutcome = 'ready' | 'not_ready' | 'out_of_budget'

/**
 * Poll `/ready` until the service answers or the deadline passes.
 *
 * The deadline is the whole point. In phase 2 it is the downtime budget, so a pod
 * that is still pulling its image cannot hold the maintenance window open past
 * what the operator allowed; in phase 1 it is the readiness timeout, which is
 * generous because phase 1 costs no one any downtime. Each probe's own timeout is
 * clipped to whatever is left, so the wait ends on the deadline rather than one
 * request later.
 */
export async function waitForReadyWithinBudget(
  deps: Pick<CutoverDeps, 'now' | 'sleep' | 'healthCheck'>,
  site: CutoverSite,
  opts: {
    deadlineMs: number
    serviceName?: string
    probeTimeoutMs?: number
    intervalMs?: number
    maxProbes?: number
  },
): Promise<ReadyOutcome> {
  const probeTimeoutMs = opts.probeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? HEALTH_CHECK_INTERVAL_MS
  const maxProbes = opts.maxProbes ?? HEALTH_CHECK_MAX_PROBES

  for (let probe = 0; probe < maxProbes; probe++) {
    const remainingMs = opts.deadlineMs - deps.now()
    if (remainingMs <= 0) return 'out_of_budget'
    const healthy = await deps
      .healthCheck(site, {
        timeoutMs: Math.min(probeTimeoutMs, remainingMs),
        ...(opts.serviceName ? { serviceName: opts.serviceName } : {}),
      })
      .catch(() => false)
    if (healthy) return 'ready'
    if (deps.now() >= opts.deadlineMs) return 'out_of_budget'
    await deps.sleep(Math.min(intervalMs, opts.deadlineMs - deps.now()))
  }
  return 'not_ready'
}

/**
 * Phase 1 of the cutover. The site keeps serving from metal throughout: the ksvc
 * is created at `min-scale: 1` but nothing routes to it until the edge flag
 * flips, so a warm pod is only ever reachable from inside the cluster.
 */
export async function prepareCutoverSite(
  site: CutoverSite,
  deps: CutoverDeps,
  opts: { readinessTimeoutMs?: number } = {},
): Promise<CutoverOk<PreparedSite> | CutoverFailure> {
  const startedAt = deps.now()
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const env = await deps.ensureEnvironment(site)
  deps.log(`environment row: ${env.name} (${env.id})`)

  const preparedDb = await deps.prepareDatabase(site)
  if (!preparedDb.ok) return preparedDb
  deps.log(`database: ${preparedDb.value.databaseName}`)

  const image = await deps.ensureImage(site, env)
  if (!image.ok) return image
  deps.log(`${image.value.reused ? 'reused' : 'built'} image ${image.value.imageDigest}`)

  await deps.ensureWarmService(site, {
    env,
    imageRef: image.value.imageRef,
    minScale: 1,
  })

  // POSTing the Knative service returns as soon as the object exists. The first
  // start is where the image is pulled and the init-container syncs the artifact
  // from S3, and that is minutes on a large app. Waiting here is what makes
  // `min-scale: 1` mean "already started when the flag flips": without it the
  // cold start lands inside the downtime window and every rehearsal number is
  // measured against a pod that was still pulling.
  deps.log(`waiting up to ${Math.round(readinessTimeoutMs / 1000)}s for the ksvc to answer /ready`)
  const ready = await deps.waitForServiceReady(site, { timeoutMs: readinessTimeoutMs })
  if (!ready) {
    return {
      ok: false,
      code: 'prepare_not_ready',
      message:
        `The Knative service did not answer /ready within ${Math.round(readinessTimeoutMs / 1000)}s of ` +
        'being created, so switching now would spend the downtime budget on a cold start. ' +
        'The site is untouched on metal; raise --readiness-timeout or check the image and its init container.',
    }
  }
  deps.log('ksvc is ready — a cold start is no longer part of the window')

  return {
    ok: true,
    value: {
      site,
      env,
      database: preparedDb.value,
      image: image.value,
      prepareMs: deps.now() - startedAt,
    },
  }
}

/** Import the archive into a database and prove every row arrived. */
export async function importArchive(
  deps: Pick<CutoverDeps, 'countPostgres'>,
  archive: Buffer,
  databaseUrl: string,
  opts: { truncate: boolean },
): Promise<CutoverOk<{ rows: number }> | (CutoverFailure & { mismatches?: RowCountMismatch[] })> {
  let extracted: ExtractedArchive | null = null
  try {
    extracted = await extractSqliteFromArchive(archive)
    const expected = countSqliteRows(extracted.sqlitePath)
    const copies = await copySqliteToPostgres(extracted.sqlitePath, databaseUrl, { truncate: opts.truncate })
    const rows = copies.reduce((sum, c) => sum + c.rows, 0)
    const actual = await deps.countPostgres(databaseUrl, [...expected.keys()])
    const mismatches = diffRowCounts(expected, actual)
    if (mismatches.length > 0) {
      return {
        ok: false,
        code: 'row_count_mismatch',
        message:
          `Row counts differ after the load (${mismatches.length} table(s)): ` +
          mismatches
            .slice(0, 5)
            .map((m) => `${m.table} ${m.sqlite}→${m.postgres}${m.reason === 'missing_table' ? ' (missing)' : ''}`)
            .join(', '),
        details: { mismatches },
        mismatches,
      }
    }
    return { ok: true, value: { rows } }
  } catch (err: any) {
    return {
      ok: false,
      code: 'data_load_failed',
      message: `Could not load the archive into Postgres: ${err?.message ?? String(err)}`,
    }
  } finally {
    await extracted?.cleanup().catch(() => {})
  }
}

/**
 * Phase 2: the only downtime. Every step after the maintenance flag goes up is
 * inside the budget, and any failure past the freeze rolls the site back onto
 * metal before returning.
 */
export async function switchCutoverSite(
  prepared: PreparedSite,
  deps: CutoverDeps,
  opts: SwitchOptions,
): Promise<CutoverResult> {
  const { site, env, database, image } = prepared
  const base = {
    projectId: site.projectId,
    subdomain: site.subdomain,
    dbBytes: 0,
    prepareMs: prepared.prepareMs,
  }

  const archiveTimeoutMs = opts.archiveTimeoutMs ?? DEFAULT_ARCHIVE_TIMEOUT_MS
  const switchStartedAt = deps.now()
  let frozen = false
  let reloaded = false
  let maintenanceOn = false

  const rollback = async (code: string, message: string, mismatches?: RowCountMismatch[]) => {
    const downtimeMs = deps.now() - switchStartedAt
    deps.log(`aborting (${code}) after ${downtimeMs}ms — rolling ${site.subdomain} back to metal`)
    // The edge is the switch, so it goes back first: whatever else fails, no
    // request may be routed at a ksvc whose data import did not finish.
    const restored = await deps.setEdgeBackend(site.subdomain, 'metal').catch(() => false)
    if (!restored) deps.log('WARNING: could not flip the edge flag back to metal')
    if (frozen) {
      try {
        await deps.resumeMetal(site)
      } catch (err: any) {
        deps.log(`WARNING: could not resume the metal runtime: ${err?.message ?? err}`)
      }
    }
    if (maintenanceOn) {
      await deps.setMaintenance(site, env.id, false, `${code}: ${message}`).catch(() => {})
    }
    return {
      ...base,
      downtimeMs,
      outcome: 'rolled-back' as const,
      code,
      message,
      ...(mismatches ? { mismatches } : {}),
    }
  }

  try {
    // 1. Maintenance on. This is what makes the freeze hold: the API's published
    //    proxy answers 503 instead of waking the microVM, so a request during the
    //    copy cannot resume it and write past the export.
    await deps.setMaintenance(site, env.id, true, null)
    maintenanceOn = true

    // 2. Freeze and wait for the host's final export.
    const frozenAtMs = deps.now()
    await deps.freezeMetal(site)
    frozen = true

    const archive = await waitForFreshArchive({
      head: () => deps.headArchive(site.subdomain),
      frozenAtMs,
      timeoutMs: archiveTimeoutMs,
      intervalMs: DEFAULT_ARCHIVE_POLL_MS,
      now: () => deps.now(),
      sleep: (ms) => deps.sleep(ms),
    })
    if (!archive) {
      return await rollback(
        'archive_not_exported',
        `The metal host did not export a fresh ${cutoverArchiveKey(site.subdomain)} within ` +
          `${Math.round(archiveTimeoutMs / 1000)}s of the freeze, so the last writes cannot be copied.`,
      )
    }
    deps.log(`final archive ${archive.key} (${archive.bytes} bytes, ${new Date(archive.lastModifiedMs).toISOString()})`)

    // 3. Truncate + reload from that export.
    const buffer = await deps.downloadArchive(archive.key)
    const loaded = await deps.importArchive(buffer, database.directUrl, { truncate: true })
    if (!loaded.ok) {
      return await rollback(loaded.code, loaded.message, (loaded as any).mismatches)
    }
    reloaded = true
    deps.log(`loaded ${loaded.value.rows} rows into ${database.databaseName}`)

    // 4. Prove the ksvc serves BEFORE the edge points at it. While the flag still
    //    says metal the only reader is this probe, so a pod that is cold or
    //    crash-looping costs nobody a write. The alternative — flip, wait, then
    //    roll back — serves real traffic on Knative and throws those writes away.
    //    The budget bounds the wait: this is the downtime window.
    const budgetDeadlineMs = switchStartedAt + opts.maxDowntimeMs
    const preflip = await waitForReadyWithinBudget(deps, site, { deadlineMs: budgetDeadlineMs })
    if (preflip !== 'ready') {
      return await rollback(
        preflip === 'out_of_budget' ? 'over_downtime_budget' : 'health_check_failed',
        preflip === 'out_of_budget'
          ? `The Knative service was not ready within the ${(opts.maxDowntimeMs / 1000).toFixed(1)}s ` +
            'budget. The edge was never pointed at it, so the site is back on metal with its data intact.'
          : 'The Knative service did not answer /ready while the site was still on metal. ' +
            'Nothing was routed to it, so no write was served and discarded.',
      )
    }

    // 5. Flip the edge. From here to the budget deadline a visitor can be served
    //    by the new revision, which is why the deadline — not a probe count — is
    //    what ends this window.
    const flipped = await deps.setEdgeBackend(site.subdomain, 'knative')
    if (!flipped) {
      return await rollback('edge_flip_failed', 'The edge flag could not be flipped to knative.')
    }

    // 6. One confirming probe through the routed path, inside whatever is left.
    const confirmed = await waitForReadyWithinBudget(deps, site, { deadlineMs: budgetDeadlineMs, maxProbes: 2 })
    if (confirmed !== 'ready') {
      return await rollback(
        confirmed === 'out_of_budget' ? 'over_downtime_budget' : 'health_check_failed',
        confirmed === 'out_of_budget'
          ? `The switch reached the ${(opts.maxDowntimeMs / 1000).toFixed(1)}s budget before the routed ` +
            'service answered, so the site was returned to metal.'
          : 'The Knative service did not answer /ready after the edge flip, so the site was returned to metal.',
      )
    }

    // 7. The budget is a bound, not a verdict: it is checked BEFORE the window
    //    closes, so an over-budget switch goes back to metal while visitors are
    //    still on the maintenance page instead of being served by a revision that
    //    is about to be abandoned.
    const downtimeMs = deps.now() - switchStartedAt
    if (downtimeMs > opts.maxDowntimeMs) {
      return await rollback(
        'over_downtime_budget',
        `The switch took ${(downtimeMs / 1000).toFixed(1)}s, over the ` +
          `${(opts.maxDowntimeMs / 1000).toFixed(1)}s budget, so the site was returned to metal.`,
      )
    }

    // 8. Close the window.
    await deps.setMaintenance(site, env.id, false, null)
    maintenanceOn = false

    // 9. The site is serving from the ksvc: record it and release the VM. Both
    //    are after the window — a failure here cannot take the site down, and
    //    the next publish reconciles a missing deployment row.
    await deps.recordDeployment(site, env.id, image).catch((err: any) => {
      deps.log(`WARNING: could not record the deployment: ${err?.message ?? err}`)
    })
    await deps.releaseMetal(site).catch((err: any) => {
      deps.log(`WARNING: could not release the metal runtime: ${err?.message ?? err}`)
    })

    return { ...base, dbBytes: archive.bytes, downtimeMs, outcome: 'migrated' }
  } catch (err: any) {
    // An unexpected throw mid-switch is the case rollback exists for: `reloaded`
    // and `frozen` tell the rollback what to undo.
    return await rollback(
      reloaded ? 'switch_failed_after_load' : 'switch_failed',
      err?.message ?? String(err),
    )
  }
}

/**
 * `--rehearse`: measure the switch against copies.
 *
 * Phase 1 runs for real (that is the point — it proves the image boots and the
 * schema pushes). The timed part then loads the current archive into a template
 * copy of the database and health-checks a `-rehearsal` ksvc, and asserts the
 * edge and the microVM were untouched. Nothing a rehearsal does can take a live
 * site down.
 */
export async function rehearseCutoverSite(
  prepared: PreparedSite,
  deps: CutoverDeps,
  opts: { readinessTimeoutMs?: number } = {},
): Promise<CutoverResult> {
  const { site, env, database, image } = prepared
  const base = { projectId: site.projectId, subdomain: site.subdomain, prepareMs: prepared.prepareMs }
  const rehearsalService = rehearsalServiceName(site.projectId)
  const scratchDb = rehearsalDatabaseName(database.databaseName)
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS

  let clone: { directUrl: string } | null = null
  /** Set once the timed section starts; null while still warming. */
  let timedFrom: number | null = null
  try {
    // Stand the rehearsal ksvc up and wait for it OUTSIDE the timed section. In a
    // real switch that start is phase 1's cost, so counting it here would inflate
    // the only number this command exists to produce.
    await deps.ensureWarmService(site, { env, imageRef: image.imageRef, serviceName: rehearsalService, minScale: 1 })
    const warmed = await deps.waitForServiceReady(site, {
      serviceName: rehearsalService,
      timeoutMs: readinessTimeoutMs,
    })
    if (!warmed) {
      return {
        ...base,
        dbBytes: 0,
        downtimeMs: null,
        outcome: 'failed',
        code: 'health_check_failed',
        message:
          `The rehearsal service did not answer /ready within ${Math.round(readinessTimeoutMs / 1000)}s, ` +
          'so this image would not have served. Nothing was timed.',
      }
    }

    const startedAt = deps.now()
    timedFrom = startedAt

    // The current archive, as it stands. No freeze: this measures the copy, not
    // the export, and the export wait is bounded separately by the archive
    // timeout in a real switch.
    const archive = await deps.headArchive(site.subdomain)
    if (!archive) {
      return { ...base, dbBytes: 0, downtimeMs: null, outcome: 'failed', code: 'no_archive', message: 'This site has no published-data archive to rehearse against.' }
    }
    const buffer = await deps.downloadArchive(archive.key)

    // A template copy: same tables, same indexes, same rows, different database.
    clone = await deps.cloneDatabase(database.databaseName, scratchDb)
    const loaded = await deps.importArchive(buffer, clone.directUrl, { truncate: true })
    if (!loaded.ok) {
      return {
        ...base,
        dbBytes: archive.bytes,
        downtimeMs: deps.now() - startedAt,
        outcome: 'failed',
        code: loaded.code,
        message: loaded.message,
        ...((loaded as any).mismatches ? { mismatches: (loaded as any).mismatches } : {}),
      }
    }

    // A warmed service must still answer after the load — the cheap confirmation
    // that the copy did not leave the app unable to boot.
    const healthy = await deps.healthCheck(site, { serviceName: rehearsalService, timeoutMs: 5_000 }).catch(() => false)
    const downtimeMs = deps.now() - startedAt
    if (!healthy) {
      return {
        ...base,
        dbBytes: archive.bytes,
        downtimeMs,
        outcome: 'failed',
        code: 'health_check_failed',
        message: 'The rehearsal service stopped answering /ready after the load, so this image would not have served.',
      }
    }

    // The claim a rehearsal makes is that it changed nothing. Verify it.
    const edge = await deps.readEdgeBackend(site.subdomain)
    if (edge === 'knative') {
      return {
        ...base,
        dbBytes: archive.bytes,
        downtimeMs,
        outcome: 'failed',
        code: 'rehearsal_flipped_edge',
        message: 'The edge flag reads knative after a rehearsal, which must never happen.',
      }
    }

    deps.log(`rehearsal loaded ${loaded.value.rows} rows into ${scratchDb} and booted ${rehearsalService} in ${downtimeMs}ms`)
    return { ...base, dbBytes: archive.bytes, downtimeMs, outcome: 'rehearsed' }
  } catch (err: any) {
    return {
      ...base,
      dbBytes: 0,
      // Null when the failure was the warm-up itself: nothing was timed.
      downtimeMs: timedFrom == null ? null : deps.now() - timedFrom,
      outcome: 'failed',
      code: 'rehearsal_failed',
      message: err?.message ?? String(err),
    }
  } finally {
    // Cleanup is best-effort and always runs: a leftover rehearsal pod or copy
    // costs money and confuses the next run.
    await deps.deleteService(site, rehearsalService).catch(() => {})
    if (clone) await deps.dropClone(scratchDb).catch(() => {})
  }
}

/** `published-{id}-rehearsal` — never any environment's service. */
export function rehearsalServiceName(projectId: string): string {
  return `published-${projectId}-rehearsal`
}

/** `project_<uuid>_rehearsal` — the throwaway copy a rehearsal loads into. */
export function rehearsalDatabaseName(databaseName: string): string {
  return `${databaseName}_rehearsal`
}

/**
 * `--to metal`: put a site back on metal from the kept archive.
 *
 * The archive is the data, so this is: flag back to metal, resume the microVM
 * (it hydrates from `{subdomain}/data.tar.gz`), and stop serving from Knative.
 * The ksvc is left in place but unrouted — deleting it would destroy the only
 * warm path back.
 */
export async function restoreSiteToMetal(
  site: CutoverSite,
  deps: CutoverDeps,
): Promise<CutoverResult> {
  const startedAt = deps.now()
  const base = { projectId: site.projectId, subdomain: site.subdomain, dbBytes: 0, prepareMs: 0 }
  try {
    const archive = await deps.headArchive(site.subdomain)
    if (!archive) {
      return {
        ...base,
        downtimeMs: null,
        outcome: 'failed',
        code: 'no_archive',
        message:
          `There is no ${cutoverArchiveKey(site.subdomain)} to restore from. ` +
          'Refusing to point metal at a runtime with no data.',
      }
    }
    await deps.setEdgeBackend(site.subdomain, 'metal')
    await deps.resumeMetal(site)

    // The site is on SQLite again, so the environment row must stop claiming a
    // Postgres database: `publishedLocalStateReason()` reads `dbProvider` to
    // decide whether a second replica shares its data, and a metal runtime with
    // local SQLite must never pass that check.
    const env = await deps.ensureEnvironment(site)
    await deps.markDatabaseLocal(site, env.id).catch((err: any) => {
      deps.log(`WARNING: could not clear dbProvider: ${err?.message ?? err}`)
    })

    const healthy = await deps.healthCheck(site, { timeoutMs: 10_000 }).catch(() => false)
    const downtimeMs = deps.now() - startedAt
    if (!healthy) {
      return {
        ...base,
        dbBytes: archive.bytes,
        downtimeMs,
        outcome: 'failed',
        code: 'health_check_failed',
        message: 'The metal runtime did not come back up after the restore.',
      }
    }
    return { ...base, dbBytes: archive.bytes, downtimeMs, outcome: 'restored' }
  } catch (err: any) {
    return {
      ...base,
      downtimeMs: deps.now() - startedAt,
      outcome: 'failed',
      code: 'restore_failed',
      message: err?.message ?? String(err),
    }
  }
}

/**
 * The production wiring. Every call here is a real one: this is the object the
 * CLI passes to the orchestrators.
 */
export function defaultCutoverDeps(): CutoverDeps {
  const deps: CutoverDeps = {
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(`    · ${message}`),

    async ensureEnvironment(site) {
      const { ensureProductionEnvironment } = await import('./published-environments.service')
      const env = await ensureProductionEnvironment(site.projectId, site.subdomain, {
        alwaysOn: site.alwaysOn,
      })
      return {
        id: env.id,
        name: 'production',
        subdomain: env.subdomain,
        minReplicas: env.minReplicas,
        maxReplicas: env.maxReplicas,
        size: (env.size as PublishedSize) ?? 's',
        dbProvider: env.dbProvider,
        dbName: env.dbName,
        currentDeploymentId: env.currentDeploymentId,
      }
    },

    async prepareDatabase(site) {
      const { prepareEnvironmentDatabase } = await import('./published-schema.service')
      const prepared = await prepareEnvironmentDatabase(site.projectId, 'production')
      if (!prepared.ok) return { ok: false, code: prepared.code, message: prepared.message, details: prepared.details }
      if (!prepared.value.database) {
        return {
          ok: false,
          code: 'database_unavailable',
          message:
            'No Postgres database for this environment (a static app, or this deployment has no projects-pg).',
        }
      }
      return {
        ok: true,
        value: {
          databaseName: prepared.value.database.databaseName,
          directUrl: prepared.value.database.directUrl,
        },
      }
    },

    async ensureImage(site, env) {
      const { publishedBuildSetup, shouldBuildPublishedImage } = await import('../lib/published-build-config')
      if (!shouldBuildPublishedImage('knative')) {
        return {
          ok: false,
          code: 'build_not_configured',
          message: `Per-commit images are not configured (missing ${publishedBuildSetup().missing.join(', ') || 'PUBLISH_BUILD_IMAGES=off'}).`,
        }
      }
      const { prisma } = await import('../lib/prisma')
      const project = (await prisma.project.findUnique({
        where: { id: site.projectId },
        select: { publishedCommitSha: true },
      })) as { publishedCommitSha: string | null } | null
      const commitSha = project?.publishedCommitSha
      if (!commitSha) {
        return { ok: false, code: 'build_failed', message: 'This project has no published commit to build.' }
      }
      const { ensurePublishedImage } = await import('./published-build.service')
      const image = await ensurePublishedImage({
        projectId: site.projectId,
        environmentId: env.id,
        subdomain: site.subdomain,
        commitSha,
      })
      if (!image.ok) return { ok: false, code: image.code, message: image.message }
      return {
        ok: true,
        value: { imageRef: image.imageRef, imageDigest: image.imageDigest, reused: image.reused },
      }
    },

    async ensureWarmService(site, opts) {
      const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
      const manager = getKnativeProjectManager()
      await manager.createPublishedServerService(site.projectId, site.subdomain, {
        minScale: opts.minScale,
        maxScale: opts.env.maxReplicas,
        size: opts.env.size,
        environment: 'production',
        image: opts.imageRef,
        ...(opts.serviceName ? { serviceName: opts.serviceName } : {}),
      })
      if (!opts.serviceName) {
        await manager.createPublishedDomainMapping(site.subdomain, site.projectId, 'production')
      }
    },

    async deleteService(_site, serviceName) {
      const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
      await getKnativeProjectManager().deleteServiceByName(serviceName)
    },

    async healthCheck(site, opts) {
      const { getKnativeProjectManager } = await import('../lib/knative-project-manager')
      const manager = getKnativeProjectManager()
      return opts?.serviceName
        ? manager.healthCheckServiceName(opts.serviceName, opts.timeoutMs ?? 5_000)
        : manager.healthCheckPublished(site.projectId, opts?.timeoutMs ?? 5_000, 'production')
    },

    async waitForServiceReady(site, opts) {
      // The same bounded poll phase 2 uses, with the readiness timeout as its
      // deadline: one definition of "how long may this wait", two deadlines.
      const outcome = await waitForReadyWithinBudget(deps, site, {
        deadlineMs: deps.now() + opts.timeoutMs,
        intervalMs: READINESS_POLL_MS,
        maxProbes: HEALTH_CHECK_MAX_PROBES,
        ...(opts.serviceName ? { serviceName: opts.serviceName } : {}),
      })
      return outcome === 'ready'
    },

    async headArchive(subdomain) {
      const { publishS3Client, PUBLISH_DATA_BUCKET } = await import('../lib/publish-storage')
      if (!PUBLISH_DATA_BUCKET) return null
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
      const key = cutoverArchiveKey(subdomain)
      try {
        const head = await publishS3Client.send(new HeadObjectCommand({ Bucket: PUBLISH_DATA_BUCKET, Key: key }))
        return {
          key,
          bytes: Number(head.ContentLength ?? 0),
          lastModifiedMs: head.LastModified ? head.LastModified.getTime() : Number.NaN,
        }
      } catch {
        return null
      }
    },

    async downloadArchive(key) {
      const { publishS3Client, PUBLISH_DATA_BUCKET } = await import('../lib/publish-storage')
      const { GetObjectCommand } = await import('@aws-sdk/client-s3')
      const res = await publishS3Client.send(new GetObjectCommand({ Bucket: PUBLISH_DATA_BUCKET, Key: key }))
      const bytes = await res.Body!.transformToByteArray()
      return Buffer.from(bytes)
    },

    async freezeMetal(site) {
      const { getMetalWarmPoolController } = await import('../lib/metal-warm-pool-controller')
      // `stopPublished` (suspend), not `destroy`: the snapshot it keeps is what a
      // rollback resumes from, and the host exports the published-data archive on
      // the way down.
      await getMetalWarmPoolController().stopPublished(site.projectId)
    },

    async resumeMetal(site) {
      const { MetalSubstrate } = await import('../lib/substrate/metal-substrate')
      await new MetalSubstrate().wakePublished(site.projectId, site.subdomain, { alwaysOn: site.alwaysOn })
    },

    async releaseMetal(site) {
      const { MetalSubstrate } = await import('../lib/substrate/metal-substrate')
      await new MetalSubstrate().discardPublishedRuntime(site.projectId, site.subdomain)
    },

    async readEdgeBackend(subdomain) {
      const { getServerBackedBackend } = await import('../lib/cloudflare-server-backed-kv')
      return getServerBackedBackend(subdomain)
    },

    async setEdgeBackend(subdomain, backend) {
      const { setServerBackedFlag } = await import('../lib/cloudflare-server-backed-kv')
      return setServerBackedFlag(subdomain, backend)
    },

    async setMaintenance(site, envId, on, detail) {
      const { prisma } = await import('../lib/prisma')
      await prisma.publishedEnvironment.update({
        where: { id: envId },
        data: on
          ? { publishStatus: MAINTENANCE_ENV_STATUS, publishError: null, publishStatusAt: new Date() }
          : { publishStatus: detail ? FAILED_ENV_STATUS : LIVE_ENV_STATUS, publishError: detail ?? null, publishStatusAt: new Date() },
      })
      console.log(`[Cutover] ${site.subdomain} maintenance ${on ? 'on' : `off${detail ? ` (${detail})` : ''}`}`)
    },

    async markDatabaseLocal(_site, envId) {
      const { prisma } = await import('../lib/prisma')
      await prisma.publishedEnvironment.update({
        where: { id: envId },
        data: { dbProvider: null },
      })
    },

    async cloneDatabase(sourceName, targetName) {
      const { cloneDatabase } = await import('./database.service')
      const cloned = await cloneDatabase(sourceName, targetName)
      return { directUrl: cloned.connectionUrl }
    },

    async dropClone(targetName) {
      const { dropDatabase } = await import('./database.service')
      // A clone owns its own role and secret name; nothing else references it.
      await dropDatabase(targetName, { databaseName: targetName, secretName: `published-db-${targetName}` })
    },

    async countPostgres(databaseUrl, tables) {
      return countPostgresRows(databaseUrl, tables)
    },

    async importArchive(archive, databaseUrl, opts) {
      return importArchive(deps, archive, databaseUrl, opts)
    },

    async recordDeployment(site, envId, image) {
      const { prisma } = await import('../lib/prisma')
      const { recordPublishedDeployment } = await import('./published-deployments.service')
      const project = (await prisma.project.findUnique({
        where: { id: site.projectId },
        select: { publishedCommitSha: true },
      })) as { publishedCommitSha: string | null } | null
      await recordPublishedDeployment({
        environmentId: envId,
        commitSha: project?.publishedCommitSha ?? '',
        imageRef: image.imageRef,
        imageDigest: image.imageDigest,
        status: 'ready',
        createdBy: 'cutover',
      })
    },
  }
  return deps
}
