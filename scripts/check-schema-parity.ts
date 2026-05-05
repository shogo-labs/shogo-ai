// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Compare prisma/schema.prisma (PG, source of truth) with
 * prisma/schema.local.prisma (SQLite, used by `dev:all` and Shogo
 * Desktop) and report any column-level drift.
 *
 * Background
 * ----------
 * The two schemas are maintained by hand because the dialects differ in
 * ways that no mechanical transformer can round-trip safely:
 *
 *   - PG enums (`SubscriptionStatus`, `BillingInterval`, ...) become
 *     plain `String` columns in SQLite.
 *   - PG `String[]` arrays are stored as JSON-encoded strings in SQLite
 *     (column type `String`, with a `@default("[]")` default mirroring
 *     the PG `@default([])`).
 *   - PG `Json?` columns are stored as `String?` in SQLite.
 *   - The SQLite-side has a small set of intentional local-only models
 *     (e.g. `LocalConfig` for desktop preferences) that must never leak
 *     into PG.
 *
 * Because the schemas drift cheaply (add a column to PG, forget to
 * mirror it in SQLite, the API silently breaks in local mode the next
 * time anyone touches that table), we run this check from the
 * pre-commit hook and from `bun run check:schema-parity`.
 *
 * Usage
 * -----
 *   bun scripts/check-schema-parity.ts            # report drift, exit 1 on any
 *   bun scripts/check-schema-parity.ts --quiet    # suppress "all clean" output
 *
 * The `INTENTIONAL_DIFFERENCES` table at the top of this file documents
 * every legitimate cross-schema deviation. Anything not on that list is
 * treated as a bug.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const PG_SCHEMA = 'prisma/schema.prisma'
const LOCAL_SCHEMA = 'prisma/schema.local.prisma'

// ---------------------------------------------------------------------------
// Allow-list: known intentional differences. Each entry is documented.
// ---------------------------------------------------------------------------

interface Allow {
  /** "Model" or "Model.field" */
  key: string
  /** Why this difference exists. */
  reason: string
}

const INTENTIONAL_DIFFERENCES: Allow[] = [
  // Local-only models -------------------------------------------------------
  {
    key: 'LocalConfig',
    reason:
      'Stores desktop-app-only preferences (chosen instance size, last-opened workspace, etc.). Never persisted to the cloud DB.',
  },
  // PG-only models — none yet; SignupAttribution etc. should be mirrored.
]

const allowedKeys = new Set(INTENTIONAL_DIFFERENCES.map((a) => a.key))

// ---------------------------------------------------------------------------
// Schema parser
// ---------------------------------------------------------------------------

interface Field {
  name: string
  /** Raw type as written, e.g. `String?`, `String[]`, `SubscriptionStatus`. */
  rawType: string
  /** Lowercased attribute string after the type, e.g. `@id @default(cuid())`. */
  attrs: string
  /** Source line for error messages. */
  line: number
}

interface Model {
  name: string
  fields: Map<string, Field>
  /** Whole-line `@@` block-level attributes (indexes, maps, etc.). */
  blockAttrs: string[]
}

interface Schema {
  models: Map<string, Model>
  enums: Set<string>
}

function parseSchema(path: string): Schema {
  const src = readFileSync(path, 'utf-8')
  const lines = src.split('\n')
  const models = new Map<string, Model>()
  const enums = new Set<string>()

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const enumMatch = /^\s*enum\s+(\w+)\s*\{/.exec(line)
    if (enumMatch) {
      enums.add(enumMatch[1])
      // Skip past closing brace
      while (i < lines.length && !/^\s*\}/.test(lines[i])) i++
      i++
      continue
    }

    const modelMatch = /^\s*model\s+(\w+)\s*\{/.exec(line)
    if (modelMatch) {
      const name = modelMatch[1]
      const fields = new Map<string, Field>()
      const blockAttrs: string[] = []
      i++
      while (i < lines.length && !/^\s*\}/.test(lines[i])) {
        const raw = lines[i]
        const trimmed = raw.replace(/\/\/.*$/, '').trim()
        if (trimmed && !trimmed.startsWith('//')) {
          if (trimmed.startsWith('@@')) {
            blockAttrs.push(trimmed)
          } else {
            const fm = /^(\w+)\s+(\S+)(.*)$/.exec(trimmed)
            if (fm) {
              const [, fname, ftype, rest] = fm
              fields.set(fname, {
                name: fname,
                rawType: ftype,
                attrs: rest.trim(),
                line: i + 1,
              })
            }
          }
        }
        i++
      }
      models.set(name, { name, fields, blockAttrs })
      i++
      continue
    }

    i++
  }

  return { models, enums }
}

// ---------------------------------------------------------------------------
// Type / default normalization for cross-dialect comparison
// ---------------------------------------------------------------------------

interface Normalized {
  base: string
  optional: boolean
  list: boolean
}

function normalizeType(rawType: string, pgEnums: Set<string>): Normalized {
  const list = rawType.endsWith('[]')
  const stripped = rawType.replace(/\[\]$/, '')
  const optional = stripped.endsWith('?')
  let base = stripped.replace(/\?$/, '')

  // PG enums become String columns in SQLite.
  if (pgEnums.has(base)) base = 'String'
  // Json columns become String? in SQLite (no native Json type).
  if (base === 'Json') base = 'String'

  return { base, optional, list }
}

/**
 * Returns true when the PG-side type is equivalent to the SQLite-side
 * type after applying the JSON-array-as-string convention.
 *
 *   PG `String[] @default([])`  ↔  SQLite `String  @default("[]")`
 *   PG `String[]?`              ↔  SQLite `String? `   (rare)
 *   PG `Foo` (enum)             ↔  SQLite `String`
 *   PG `Json?`                  ↔  SQLite `String?`
 */
function typesEquivalent(pg: Normalized, local: Normalized): boolean {
  // Lists: PG String[] -> SQLite String (non-null, JSON-encoded).
  if (pg.list && !local.list) {
    if (pg.base !== 'String' || local.base !== 'String') return false
    // SQLite mirror should not be optional; the @default("[]") backs it.
    if (local.optional) return false
    return true
  }
  if (!pg.list && local.list) return false
  if (pg.list && local.list) {
    return pg.base === local.base && pg.optional === local.optional
  }
  return pg.base === local.base && pg.optional === local.optional
}

function extractDefault(attrs: string): string | null {
  const m = /@default\(([^)]*)\)/.exec(attrs)
  return m ? m[1].trim() : null
}

/**
 * Returns true when the two `@default(...)` forms describe equivalent
 * values across dialects. Three normalizations:
 *
 *   1. PG enums use bare identifiers; the SQLite mirror stores the same
 *      value as a string literal, so `@default(member)` on PG matches
 *      `@default("member")` on SQLite.
 *   2. `String[] @default([])` on PG ↔ `String @default("[]")` on SQLite
 *      — same empty-list initial value, JSON-encoded for SQLite.
 *   3. Numeric / boolean / function defaults (`0`, `true`, `now()`) are
 *      written identically and compared via plain equality.
 */
function defaultsEquivalent(
  pg: Field,
  local: Field,
  pgRawType: string,
  pgEnums: Set<string>,
  pgNorm: Normalized,
): boolean {
  const pgDefault = extractDefault(pg.attrs)
  const localDefault = extractDefault(local.attrs)
  if (pgDefault === localDefault) return true
  if (pgDefault == null || localDefault == null) return false

  const stripQuotes = (s: string) => s.replace(/^["']|["']$/g, '')

  // Case 1: PG enum default ↔ SQLite string-literal default
  const pgBaseType = pgRawType.replace(/[?\[\]]/g, '')
  if (pgEnums.has(pgBaseType)) {
    if (pgDefault === stripQuotes(localDefault)) return true
  }

  // Case 2: PG String[] @default([]) ↔ SQLite String @default("[]")
  if (pgNorm.list) {
    if (pgDefault === '[]' && stripQuotes(localDefault) === '[]') return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

interface Drift {
  severity: 'error' | 'warning'
  key: string
  message: string
  hint?: string
}

function isRelation(rawType: string, allModelNames: Set<string>): boolean {
  const base = rawType.replace(/[?\[\]]/g, '')
  return allModelNames.has(base)
}

function compareSchemas(pg: Schema, local: Schema): Drift[] {
  const drift: Drift[] = []
  const pgModels = new Set(pg.models.keys())
  const localModels = new Set(local.models.keys())
  const allModelNames = new Set([...pgModels, ...localModels])

  // 1. Models present in PG but not local
  for (const name of pgModels) {
    if (localModels.has(name)) continue
    if (allowedKeys.has(name)) continue
    drift.push({
      severity: 'error',
      key: name,
      message: `Model "${name}" exists in ${PG_SCHEMA} but not in ${LOCAL_SCHEMA}.`,
      hint: `Mirror the model into ${LOCAL_SCHEMA} (translate enums to String, String[] to String @default("[]"), Json? to String?, drop @db.* annotations) and add a corresponding migration under apps/desktop/prisma/migrations/.`,
    })
  }

  // 2. Models present in local but not PG
  for (const name of localModels) {
    if (pgModels.has(name)) continue
    if (allowedKeys.has(name)) continue
    drift.push({
      severity: 'error',
      key: name,
      message: `Model "${name}" exists in ${LOCAL_SCHEMA} but not in ${PG_SCHEMA}.`,
      hint: `Either add the model to ${PG_SCHEMA} (and a migration under prisma/migrations/) or, if it is intentionally local-only, document it in INTENTIONAL_DIFFERENCES at the top of scripts/check-schema-parity.ts.`,
    })
  }

  // 3. Per-shared-model field comparison
  for (const [name, pgModel] of pg.models) {
    const localModel = local.models.get(name)
    if (!localModel) continue

    for (const [fname, pgField] of pgModel.fields) {
      const fkey = `${name}.${fname}`
      if (allowedKeys.has(fkey)) continue
      // Relation fields don't materialize as columns; skip.
      if (isRelation(pgField.rawType, allModelNames)) continue

      const localField = localModel.fields.get(fname)
      if (!localField) {
        drift.push({
          severity: 'error',
          key: fkey,
          message: `Field "${fkey}" exists in PG schema but is missing from local schema.`,
          hint: `Add it to ${LOCAL_SCHEMA} (translate the type per the dialect rules) and create a migration under apps/desktop/prisma/migrations/<timestamp>_<name>/ that ALTER TABLEs the column in.`,
        })
        continue
      }

      const pgNorm = normalizeType(pgField.rawType, pg.enums)
      const localNorm = normalizeType(localField.rawType, pg.enums)
      if (!typesEquivalent(pgNorm, localNorm)) {
        drift.push({
          severity: 'error',
          key: fkey,
          message: `Field "${fkey}" type mismatch: PG=\`${pgField.rawType}\` local=\`${localField.rawType}\`.`,
          hint: `Expected the SQLite mirror of \`${pgField.rawType}\`. Remember: enums become String, String[] becomes String @default("[]"), Json? becomes String?.`,
        })
        continue
      }
      if (!defaultsEquivalent(pgField, localField, pgField.rawType, pg.enums, pgNorm)) {
        const pgDef = extractDefault(pgField.attrs) ?? '<none>'
        const localDef = extractDefault(localField.attrs) ?? '<none>'
        drift.push({
          severity: 'error',
          key: fkey,
          message: `Field "${fkey}" default mismatch: PG=\`@default(${pgDef})\` local=\`@default(${localDef})\`.`,
          hint: `Update ${LOCAL_SCHEMA} to match (and write a SQLite migration ALTERing the column default if the underlying table is already deployed).`,
        })
      }
    }

    // Fields that exist only on the local side of a shared model.
    for (const [fname, localField] of localModel.fields) {
      const fkey = `${name}.${fname}`
      if (allowedKeys.has(fkey)) continue
      if (isRelation(localField.rawType, allModelNames)) continue
      if (!pgModel.fields.has(fname)) {
        drift.push({
          severity: 'error',
          key: fkey,
          message: `Field "${fkey}" exists in local schema but not in PG schema.`,
          hint: `Either add to ${PG_SCHEMA} (with migration) or drop from ${LOCAL_SCHEMA} (with a SQLite ALTER TABLE ... DROP COLUMN migration).`,
        })
      }
    }
  }

  return drift
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  const quiet = args.includes('--quiet')

  const root = process.cwd()
  const pgPath = resolve(root, PG_SCHEMA)
  const localPath = resolve(root, LOCAL_SCHEMA)
  if (!existsSync(pgPath) || !existsSync(localPath)) {
    console.error(
      `[parity] Could not find one or both schemas:\n  - ${pgPath}\n  - ${localPath}\n` +
        `Run from the repo root.`,
    )
    process.exit(2)
  }

  const pg = parseSchema(pgPath)
  const local = parseSchema(localPath)
  const drift = compareSchemas(pg, local)

  if (drift.length === 0) {
    if (!quiet) {
      console.log(
        `[parity] OK — ${pg.models.size} PG models, ${local.models.size} local models, no drift.`,
      )
    }
    process.exit(0)
  }

  console.error(`[parity] FAIL — ${drift.length} drift item(s) detected:\n`)
  for (const d of drift) {
    console.error(`  ✗ ${d.message}`)
    if (d.hint) console.error(`      ${d.hint}`)
  }
  console.error(
    `\nIf any of these are intentional, document them in INTENTIONAL_DIFFERENCES at the top of scripts/check-schema-parity.ts.`,
  )
  console.error(`To bypass for a single commit (e.g. comment-only changes), use \`git commit --no-verify\`.`)
  process.exit(1)
}

main()
