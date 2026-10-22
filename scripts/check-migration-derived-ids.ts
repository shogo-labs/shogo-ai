// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reject migrations that derive a primary key from row content on a table that
 * is (or may be) in the cross-region publication.
 *
 * Why this exists
 * ---------------
 * 2026-10-22 (v2.3.9, SHO-142): `20261021120000_add_device_version_events`
 * backfilled ids as `'dve_' || md5("deviceId" || ':' || "deviceAppVersion")`.
 * Both regions run migrations on **their own** primary against an `api_keys`
 * table that has already been replicated, so US and EU computed the *same*
 * primary keys for the same rows. The table was in `shogo_all_pub`, so EU's
 * tablesync `COPY` failed on its first row with
 *
 *   duplicate key value violates unique constraint "device_version_events_pkey"
 *
 * which disabled `sub_from_us`. US -> EU replication was down 04:40Z-05:05Z
 * (540 MB backlog) until it was repaired by hand. The conflict watchdog cannot
 * skip a *tablesync* duplicate — it can only skip a transaction — so it could
 * not recover the mesh on its own.
 *
 * A key computed from replicated data is identical in every region by
 * construction. That is never a coincidence to rely on: the two regions are
 * separate writers, and the only safe id is one they cannot agree on (random)
 * or one that is scoped by something region-specific.
 *
 * What it checks
 * --------------
 * Every `prisma/migrations/<id>/migration.sql` in the Postgres tree. For each
 * statement that writes the `id` column of a table in the `public` schema —
 * i.e. `INSERT INTO <tbl> (..., "id", ...)` or `UPDATE <tbl> SET "id" = ...` —
 * the written expression must not be derived from row content:
 *
 *   - a hash of columns: `md5(`, `sha1(`, `sha256(`, `sha512(`, `digest(`,
 *     `encode(`;
 *   - or any other read of a row column — concatenated (`'p_' || "a"`), copied
 *     bare (`SET "id" = "deviceId"`, `SELECT "id"`), or wrapped
 *     (`coalesce("a", gen_random_uuid())`). A published id is only safe when it
 *     is random or a literal, so there is no such thing as a harmless column
 *     read here.
 *
 * Exempt, deliberately:
 *   - tables in `INTENTIONALLY_UNPUBLISHED` (region-local: they are never
 *     copied to a peer, so a derived key cannot collide across regions),
 *     imported from `check-publication-drift.ts` so the two checks can never
 *     disagree about what is published;
 *   - `LEGACY_EXEMPT` — the one migration that caused the outage. It is
 *     already applied in both regions and stays as history. A new migration
 *     fixes the data (see `20261022120000_device_version_events_region_ids`).
 *     Never add to this list to make a new migration pass.
 *
 * Usage
 * -----
 *   bun scripts/check-migration-derived-ids.ts            # check the tree
 *   bun scripts/check-migration-derived-ids.ts --quiet    # suppress OK line
 *
 * Exit codes: 0 clean, 1 violation, 2 setup error.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { INTENTIONALLY_UNPUBLISHED } from './check-publication-drift'

const REPO_ROOT = resolve(import.meta.dir, '..')
const PG_MIGRATIONS = 'prisma/migrations'

/**
 * Migrations already applied in production that this rule rejects. Rewriting
 * an applied migration changes the checksum Prisma has recorded, so these stay
 * as history and the guard's job is to stop *new* ones. Do not extend this
 * list to make a new migration pass.
 *
 * - `20261021120000_add_device_version_events` — the 2026-10-22 outage itself
 *   (`'dve_' || md5(...)`). Its data is repaired forward by
 *   `20261022120000_device_version_events_region_ids`.
 * - `20260507000000_add_project_agents` — found by this guard when it landed,
 *   months after the fact: `'pa_default_' || "id"` wrote a key derived from the
 *   replicated `voice_project_configs.id`. Same class, pre-existing. It never
 *   took the mesh down (it ran before `project_agents` carried enough rows to
 *   collide), but it is exactly what a new migration must not do.
 */
export const LEGACY_EXEMPT: readonly string[] = [
  '20261021120000_add_device_version_events',
  '20260507000000_add_project_agents',
]


/** Functions whose output is a function of their inputs, so of row content. */
const DERIVED_ID_FUNCS = /\b(md5|sha1|sha256|sha512|digest|encode)\s*\(/i

export interface MigrationSource {
  /** Migration directory name, e.g. `20261021120000_add_device_version_events`. */
  name: string
  sql: string
}

export interface Violation {
  /** Repo-relative path, or the synthetic name for a fixture. */
  file: string
  /** 1-based line of the offending statement. */
  line: number
  table: string
  /** The expression assigned to `id`, trimmed for the error message. */
  expression: string
  message: string
}

// ===========================================================================
// SQL scanning
// ===========================================================================

/**
 * Blank out `--` and `/* *\/` comments while preserving every offset and
 * newline, so a match index in the masked text is also an index in the
 * original — and a commented-out `"id"` can never be flagged.
 */
export function maskComments(sql: string): string {
  const out = sql.split('')
  let i = 0
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out[i] = ' '
        i++
      }
      continue
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < sql.length) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    // Skip string/identifier/dollar-quoted bodies so a `--` inside them is not
    // mistaken for a comment.
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i]
      i++
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (sql[i] === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length)
        i = end === -1 ? i + m[0].length : end + m[0].length
        continue
      }
    }
    i++
  }
  return out.join('')
}

interface Span {
  start: number
  text: string
}

/** Split a migration into statements, respecting strings, identifiers and `$$`. */
export function statementSpans(sql: string): Span[] {
  const masked = maskComments(sql)
  const spans: Span[] = []
  let depth = 0
  let inSingle = false
  let inDouble = false
  let dollarTag: string | null = null
  let start = 0

  const push = (from: number, to: number) => {
    let begin = from
    while (begin < to && /\s/.test(masked[begin])) begin++
    const text = masked.slice(begin, to)
    if (text.trim()) spans.push({ start: begin, text })
  }

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]
    if (dollarTag) {
      if (masked.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1
        dollarTag = null
      }
      continue
    }
    if (inSingle) {
      if (ch === "'") {
        if (masked[i + 1] === "'") {
          i++
          continue
        }
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(masked.slice(i))
      if (m) {
        dollarTag = m[0]
        i += m[0].length - 1
        continue
      }
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      push(start, i)
      start = i + 1
    }
  }
  push(start, masked.length)
  return spans
}

/** Split on `sep` at paren-depth 0, outside strings/identifiers. */
export function splitTopLevel(text: string, sep = ','): string[] {
  const parts: string[] = []
  let depth = 0
  let inSingle = false
  let inDouble = false
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inSingle) {
      current += ch
      if (ch === "'") {
        if (text[i + 1] === "'") {
          current += text[++i]
          continue
        }
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      current += ch
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") {
      inSingle = true
      current += ch
      continue
    }
    if (ch === '"') {
      inDouble = true
      current += ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === sep && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current)
  return parts
}

/** `deviceId` / `"deviceId"` / `k."deviceId"` → true when a row column is read. */
function referencesRowColumn(expression: string): boolean {
  // Quoted identifiers are always column references in these migrations:
  // the Prisma generator quotes every column it writes.
  return /"[A-Za-z_][\w]*"/.test(expression)
}

/** Blank out `'...'` bodies so a literal that happens to contain `"x"` is not read as a column. */
function stripStringLiterals(expression: string): string {
  let out = ''
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] !== "'") {
      out += expression[i]
      continue
    }
    i++
    while (i < expression.length) {
      if (expression[i] === "'") {
        if (expression[i + 1] === "'") {
          i += 2
          continue
        }
        break
      }
      i++
    }
    out += "''"
  }
  return out
}

/** Values that are not a column read when they stand alone. */
const BARE_LITERALS = new Set(['null', 'default', 'true', 'false'])

export function isDerivedExpression(expression: string): boolean {
  const code = stripStringLiterals(expression).trim()
  if (DERIVED_ID_FUNCS.test(code)) return true
  // A published row's id is only safe when it is random or a literal, so *any*
  // read of a row column is derived — concatenated (`'p_' || "a"`), copied bare
  // (`SET "id" = "deviceId"`), or wrapped (`coalesce("a", …)`). A lone unquoted
  // word that is not a SQL literal is a column too.
  if (referencesRowColumn(code)) return true
  return /^[A-Za-z_]\w*$/.test(code) && !BARE_LITERALS.has(code.toLowerCase())
}

const INSERT_RE =
  /^INSERT\s+INTO\s+(?:(?:"?\w+"?)\s*\.\s*)?"?(\w+)"?\s*\(([^)]*)\)/i
const UPDATE_RE = /^UPDATE\s+(?:(?:"?\w+"?)\s*\.\s*)?"?(\w+)"?\s+SET\s+([\s\S]+)$/i

/**
 * The expression this statement writes into `id`, or null when it does not
 * write `id` at all (a plain `INSERT ... SELECT` that lets the default fire,
 * a `CREATE TABLE`, an index change, …).
 */
export function extractWrittenId(statement: string): { table: string; expression: string } | null {
  const text = statement.trim()

  const insert = INSERT_RE.exec(text)
  if (insert) {
    const table = insert[1]
    const columns = splitTopLevel(insert[2]).map((c) => c.trim().replace(/"/g, '').toLowerCase())
    const idIndex = columns.indexOf('id')
    if (idIndex === -1) return null

    const rest = text.slice(insert[0].length).trim()
    if (/^VALUES/i.test(rest)) {
      const tupleStart = rest.indexOf('(')
      if (tupleStart === -1) return null
      const tuple = extractBalanced(rest, tupleStart)
      if (tuple === null) return null
      const values = splitTopLevel(tuple)
      const expression = values[idIndex]
      return expression ? { table, expression: expression.trim() } : null
    }
    if (/^SELECT\s/i.test(rest)) {
      const selectList = selectListOf(rest)
      if (selectList === null) return null
      const values = splitTopLevel(selectList)
      const expression = values[idIndex]
      return expression ? { table, expression: expression.trim() } : null
    }
    return null
  }

  const update = UPDATE_RE.exec(text)
  if (update) {
    const table = update[1]
    for (const assignment of splitTopLevel(stripTrailingClauses(update[2]))) {
      const m = /^\s*"?id"?\s*=\s*([\s\S]+)$/i.exec(assignment)
      if (m) return { table, expression: m[1].trim() }
    }
    return null
  }

  return null
}

/**
 * Drop a trailing `WHERE` / `RETURNING` at paren-depth 0 so the assigned
 * expression is not polluted by the predicate (`UPDATE t SET "id" = x WHERE
 * "id" ~ '...'` must yield `x`).
 */
function stripTrailingClauses(setBody: string): string {
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < setBody.length; i++) {
    const ch = setBody[i]
    if (inSingle) {
      if (ch === "'") {
        if (setBody[i + 1] === "'") {
          i++
          continue
        }
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") inSingle = true
    else if (ch === '"') inDouble = true
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /\s/.test(ch)) {
      const ahead = setBody.slice(i).trimStart()
      if (/^(WHERE|RETURNING)\b/i.test(ahead)) return setBody.slice(0, i)
    }
  }
  return setBody
}

/** The parenthesised body starting at `open`, excluding the outer parens. */
function extractBalanced(text: string, open: number): string | null {
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i++
          continue
        }
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") inSingle = true
    else if (ch === '"') inDouble = true
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return null
}

/** The projection of a `SELECT ...` (everything before the top-level FROM). */
function selectListOf(rest: string): string | null {
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (inSingle) {
      if (ch === "'") {
        if (rest[i + 1] === "'") {
          i++
          continue
        }
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") inSingle = true
    else if (ch === '"') inDouble = true
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /^FROM\b/i.test(rest.slice(i)) && /[\s)]/.test(rest[i - 1] ?? ' ')) {
      return rest.slice(0, i).replace(/^SELECT\s+/i, '')
    }
  }
  // `SELECT md5('x')` with no FROM: the whole rest is the projection.
  return rest.replace(/^SELECT\s+/i, '')
}

function isPublished(table: string): boolean {
  return !(INTENTIONALLY_UNPUBLISHED as readonly string[]).includes(table)
}

function lineOf(sql: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < sql.length; i++) if (sql[i] === '\n') line++
  return line
}

/**
 * Pure check over a set of migrations — the unit-test entry point.
 * `file` prefixes the report (repo-relative path in a real run).
 */
export function checkMigrationSources(sources: MigrationSource[], filePrefix = ''): Violation[] {
  const violations: Violation[] = []
  for (const source of sources) {
    if (LEGACY_EXEMPT.includes(source.name)) continue
    const file = `${filePrefix}${source.name}/migration.sql`
    for (const span of statementSpans(source.sql)) {
      const written = extractWrittenId(span.text)
      if (!written) continue
      if (!isPublished(written.table)) continue
      if (!isDerivedExpression(written.expression)) continue
      violations.push({
        file,
        line: lineOf(source.sql, span.start),
        table: written.table,
        expression: written.expression.replace(/\s+/g, ' ').slice(0, 200),
        message:
          `writes a content-derived id into published table "${written.table}". Both regions ` +
          `recompute it from the same replicated rows, so they mint identical primary keys and ` +
          `the peer's tablesync COPY dies on a duplicate key — the 2026-10-22 outage. Use the ` +
          `model's @default(cuid()) (omit "id"), or scope the row with a region column.`,
      })
    }
  }
  return violations
}

function listMigrations(): MigrationSource[] {
  const root = resolve(REPO_ROOT, PG_MIGRATIONS)
  if (!existsSync(root)) {
    console.error(`[migration-ids] Could not find ${PG_MIGRATIONS}. Run from the repo root.`)
    process.exit(2)
  }
  return readdirSync(root)
    .filter((entry) => {
      const full = join(root, entry)
      return statSync(full).isDirectory() && existsSync(join(full, 'migration.sql'))
    })
    .sort()
    .map((entry) => ({ name: entry, sql: readFileSync(join(root, entry, 'migration.sql'), 'utf-8') }))
}

function main(): number {
  const quiet = process.argv.includes('--quiet')
  const sources = listMigrations()
  const violations = checkMigrationSources(sources)

  if (violations.length === 0) {
    if (!quiet) {
      console.log(
        `[migration-ids] OK — ${sources.length} migration(s) checked; no published table gets an ` +
          `id derived from row content (${LEGACY_EXEMPT.length} legacy exemption).`,
      )
    }
    return 0
  }

  console.error('[migration-ids] FAIL')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.message}`)
    console.error(`    id <- ${v.expression}`)
  }
  console.error(
    '\nSee k8s/cnpg/logical-replication/RUNBOOK.md «Multi-region migration rules» for why a\n' +
      'derived primary key breaks the mesh, and SHO-142 for the incident this guards.',
  )
  return 1
}

if (import.meta.main) {
  process.exit(main())
}
