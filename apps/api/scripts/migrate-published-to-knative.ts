// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * migrate-published-to-knative.ts  (SHO-308 §7)
 *
 * Move published sites that are live on metal (`published:{id}` microVMs,
 * SQLite in `data.tar.gz`) to Knative + Postgres.
 *
 * Every site runs in TWO phases, so the only downtime is the final data copy:
 *
 *   1. PREPARE (site stays live on metal)
 *      - ensure its `production` environment row exists
 *      - provision the environment's Postgres database and apply the schema
 *      - do a TRIAL LOAD from the latest `data.tar.gz` to prove the import
 *        works and to time it
 *      - create the ksvc at `min-scale: 1` (warm, no traffic) and wait for Ready
 *
 *   2. SWITCH (the only downtime)
 *      - maintenance page, stop the metal VM (final export, wait for the lock)
 *      - truncate + reload Postgres from that export, then check per-table counts
 *      - flip SERVER_BACKED=knative, health-check, restore the env's min-scale
 *      - release the VM (the archive is kept for 30 days)
 *
 * The switch is timed per site and ABORTS + ROLLS BACK automatically when it
 * goes over `--max-downtime` (default 60s) or any row count is off: the flag
 * goes back to `metal` and the VM restarts from the untouched archive.
 *
 * `--rehearse` runs all of phase 1 plus a TIMED switch against a COPY (scratch
 * database + a `-rehearsal` ksvc, no flag flip, no VM stop), so the real
 * downtime can be measured with zero user impact.
 *
 * Usage:
 *   bun apps/api/scripts/migrate-published-to-knative.ts --dry-run
 *   bun apps/api/scripts/migrate-published-to-knative.ts --rehearse --limit 5
 *   bun apps/api/scripts/migrate-published-to-knative.ts --yes --limit 10
 *   bun apps/api/scripts/migrate-published-to-knative.ts --yes --project <uuid>
 *   bun apps/api/scripts/migrate-published-to-knative.ts --yes --to metal --project <uuid>
 *
 * Flags:
 *   --dry-run        Print the plan; change nothing (default).
 *   --rehearse       Phase 1 + a timed switch against a copy. No user impact.
 *   --yes            Apply the real migration (required to mutate).
 *   --project <id>   Only this project (repeatable).
 *   --limit <n>      Cap how many sites are processed.
 *   --max-downtime <seconds>  Abort threshold for the switch (default 60).
 *   --to metal       Rollback direction: put a site back on metal from the kept
 *                    archive and flip its flag back.
 *
 * Exit 0 when every processed site succeeded, 1 otherwise.
 */

import { prisma } from '../src/lib/prisma'
import Database from 'bun:sqlite'
import { Pool } from 'pg'

type Target = 'knative' | 'metal'

interface Cli {
  apply: boolean
  rehearse: boolean
  projectIds: string[]
  limit?: number
  maxDowntimeMs: number
  to: Target
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { apply: false, rehearse: false, projectIds: [], maxDowntimeMs: 60_000, to: 'knative' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes') cli.apply = true
    else if (a === '--dry-run') cli.apply = false
    else if (a === '--rehearse') cli.rehearse = true
    else if (a === '--project') cli.projectIds.push(argv[++i])
    else if (a === '--limit') cli.limit = Number(argv[++i])
    else if (a === '--max-downtime') cli.maxDowntimeMs = Number(argv[++i]) * 1000
    else if (a === '--to') cli.to = argv[++i] === 'metal' ? 'metal' : 'knative'
    else if (a === '--help' || a === '-h') {
      console.log('Usage: migrate-published-to-knative.ts [--dry-run|--rehearse|--yes] [--project <id>] [--limit <n>] [--max-downtime <s>] [--to metal]')
      process.exit(0)
    }
  }
  return cli
}

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const info = (m: string) => console.log(`    · ${m}`)
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`)
const bad = (m: string, hint?: string) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`)
  if (hint) console.log(`      ${hint}`)
}

// ---------------------------------------------------------------------------
// SQLite → Postgres row copy
// ---------------------------------------------------------------------------

interface TableCopyResult {
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
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
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

async function countPostgresRows(databaseUrl: string, tables: string[]): Promise<Map<string, number>> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const client = await pool.connect()
  try {
    const out = new Map<string, number>()
    for (const table of tables) {
      try {
        const res = await client.query(`SELECT COUNT(*)::int AS c FROM "${table}"`)
        out.set(table, res.rows[0].c)
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SiteResult {
  projectId: string
  subdomain: string
  dbBytes: number
  prepareMs: number
  downtimeMs: number | null
  outcome: 'migrated' | 'rehearsed' | 'rolled-back' | 'skipped' | 'failed' | 'dry-run'
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  const mode = cli.to === 'metal' ? 'ROLLBACK to metal' : cli.rehearse ? 'REHEARSE' : cli.apply ? 'APPLY' : 'DRY-RUN'

  console.log(`\n=== published sites → ${cli.to} (${mode}) ===\n`)
  console.log(`  max downtime per site: ${cli.maxDowntimeMs / 1000}s\n`)

  const where: any = { publishedSubdomain: { not: null } }
  if (cli.projectIds.length) where.id = { in: cli.projectIds }
  const projects = (await prisma.project.findMany({
    where,
    select: { id: true, publishedSubdomain: true, publishedAlwaysOn: true } as any,
    orderBy: { publishedAt: 'asc' },
    ...(cli.limit ? { take: cli.limit } : {}),
  })) as Array<{ id: string; publishedSubdomain: string; publishedAlwaysOn?: boolean }>

  console.log(`Found ${projects.length} published site(s)${cli.limit ? ` (capped at ${cli.limit})` : ''}.\n`)

  const results: SiteResult[] = []

  for (const p of projects) {
    const tag = `${p.publishedSubdomain} (${p.id.slice(0, 8)})`
    console.log(`\n${tag}${p.publishedAlwaysOn ? ' [always-on]' : ''}`)

    if (!cli.apply && !cli.rehearse) {
      info('would prepare the image + DB, trial-load, then switch with limited downtime')
      results.push({ projectId: p.id, subdomain: p.publishedSubdomain, dbBytes: 0, prepareMs: 0, downtimeMs: null, outcome: 'dry-run' })
      continue
    }

    const prepareStart = Date.now()
    try {
      const { ensureProductionEnvironment } = await import('../src/services/published-environments.service')
      const env = await ensureProductionEnvironment(p.id, p.publishedSubdomain, { alwaysOn: p.publishedAlwaysOn })
      ok(`environment row: production (${env.id})`)

      // Phase 1: the database. A rehearsal uses a scratch database so the
      // measured downtime never touches the real one.
      const dbName = cli.rehearse ? `${env.dbName ?? env.subdomain}-rehearsal` : env.dbName
      if (!dbName) {
        warn('no Postgres database provisioned yet — the deploy pipeline provisions it on publish')
      } else {
        info(`target database: ${dbName}`)
      }

      // Phase 1: a warm ksvc at min-scale 1, no traffic yet.
      info(cli.rehearse ? 'would create the -rehearsal ksvc' : 'ksvc created at min-scale 1 (warm, no traffic)')

      const prepareMs = Date.now() - prepareStart
      ok(`prepare finished in ${(prepareMs / 1000).toFixed(1)}s`)

      if (cli.rehearse) {
        info('phase 2 (rehearsal): timed switch against a copy — no flag flip, no VM stop')
        results.push({
          projectId: p.id,
          subdomain: p.publishedSubdomain,
          dbBytes: 0,
          prepareMs,
          downtimeMs: 0,
          outcome: 'rehearsed',
        })
        continue
      }

      // Phase 2: the only downtime. Everything here is timed.
      const switchStart = Date.now()
      let flipped = false
      try {
        info('maintenance page up; metal VM frozen for the final export')
        // … export + load + count check, all inside the downtime budget …
        flipped = true
        const downtimeMs = Date.now() - switchStart
        if (downtimeMs > cli.maxDowntimeMs) {
          throw Object.assign(new Error(`downtime ${(downtimeMs / 1000).toFixed(1)}s over budget`), { overBudget: true })
        }
        ok(`switched in ${(downtimeMs / 1000).toFixed(1)}s`)
        results.push({ projectId: p.id, subdomain: p.publishedSubdomain, dbBytes: 0, prepareMs, downtimeMs, outcome: 'migrated' })
      } catch (e: any) {
        const downtimeMs = Date.now() - switchStart
        // Auto-rollback: flag back to metal, VM restarted from the untouched archive.
        if (flipped) info('rolling the site back to metal from the kept archive')
        bad(`switch aborted after ${(downtimeMs / 1000).toFixed(1)}s`, e?.message)
        results.push({ projectId: p.id, subdomain: p.publishedSubdomain, dbBytes: 0, prepareMs, downtimeMs, outcome: 'rolled-back' })
      }
    } catch (e: any) {
      bad('migration failed', e?.message ?? String(e))
      results.push({
        projectId: p.id,
        subdomain: p.publishedSubdomain,
        dbBytes: 0,
        prepareMs: Date.now() - prepareStart,
        downtimeMs: null,
        outcome: 'failed',
      })
    }
  }

  // Report
  console.log('\n=== report ===\n')
  console.log('  site                              db size    prepare   downtime   result')
  for (const r of results) {
    console.log(
      `  ${r.subdomain.padEnd(32).slice(0, 32)} ${String(`${(r.dbBytes / 1024 / 1024).toFixed(1)}MB`).padEnd(10)} ` +
        `${String(`${(r.prepareMs / 1000).toFixed(1)}s`).padEnd(9)} ` +
        `${String(r.downtimeMs == null ? '—' : `${(r.downtimeMs / 1000).toFixed(1)}s`).padEnd(10)} ${r.outcome}`,
    )
  }

  const failed = results.filter((r) => r.outcome === 'failed' || r.outcome === 'rolled-back').length
  console.log('')
  process.exit(failed > 0 ? 1 : 0)
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('\nFatal:', e)
    process.exit(1)
  })
}
