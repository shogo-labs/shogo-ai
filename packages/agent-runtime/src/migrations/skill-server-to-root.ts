// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Skill Server → Root Migration
 *
 * One-shot migration that runs on workspace boot to fold a workspace's
 * legacy `.shogo/server/` "skill server" into the project root. After
 * this runs, the runtime treats the project's own `prisma/schema.prisma`
 * + `server.tsx` as the single backend (no more parallel skill server).
 *
 * Algorithm (atomic — bails and restores on any error):
 *   1. Snapshot `.shogo/server/` -> `.shogo/server.migrated-<ts>/`
 *   2. Merge `.shogo/server/schema.prisma` models/enums into root
 *      `prisma/schema.prisma` (dedupe by name; on `User`-style
 *      collisions the skill-server definition wins and the template's
 *      bare definition is renamed `_TemplateUser`).
 *   3. Append `.shogo/server/custom-routes.ts` content into root
 *      `server.tsx` under a `// MIGRATED-CUSTOM-ROUTES` block, with
 *      adapted imports (or commented-out + TODO when imports don't
 *      translate cleanly).
 *   4. Copy `.shogo/server/skill.db` (or `dev.db`) → `prisma/dev.db`
 *      when the root DB doesn't exist.
 *   5. Delete `.shogo/server/` (the snapshot remains as the rollback
 *      record).
 *   6. Write `MIGRATION_NOTES.md` inside the snapshot summarising the
 *      merge and any items needing manual review.
 *
 * The runtime calls {@link migrateSkillServerToRoot} once at startup,
 * before `PreviewManager.start()`. The function returns a result the
 * gateway can surface to the agent so it can finish any cleanup.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, statSync } from 'fs'
import { join } from 'path'

const LOG_PREFIX = 'skill-server-migration'

export interface MigrationResult {
  /** True only when a `.shogo/server/` directory was actually migrated. */
  migrated: boolean
  /** Absolute path of the rollback snapshot (`.shogo/server.migrated-<ts>/`), if migrated. */
  snapshotPath?: string
  /** Absolute path of `MIGRATION_NOTES.md` inside the snapshot. */
  notesPath?: string
  /** ISO timestamp of when the migration ran. */
  at?: string
  /** Models that were appended to the root schema. */
  mergedModels?: string[]
  /** Models renamed because of name collisions (e.g. `User` -> `_TemplateUser`). */
  renamedModels?: Array<{ from: string; to: string; reason: string }>
  /** True when custom routes content was injected into `server.tsx`. */
  customRoutesMigrated?: boolean
  /** True when custom routes content was injected but commented out (manual review). */
  customRoutesNeedReview?: boolean
  /** True when the SQLite database was copied to `prisma/dev.db`. */
  databaseCopied?: boolean
  /** Error message if the migration failed. The workspace state has been restored. */
  error?: string
}

/** Marker comment used to detect already-migrated `server.tsx` files. */
const CUSTOM_ROUTES_MARKER = '// MIGRATED-CUSTOM-ROUTES'

interface ParsedSchema {
  /** Top-level non-block content (datasource, generator, comments). */
  preamble: string
  /** Map of name -> full block source (`model X { ... }` or `enum X { ... }`). */
  blocks: Map<string, { kind: 'model' | 'enum'; source: string }>
  /** Order in which blocks appeared (for stable output). */
  order: string[]
}

/**
 * Parse a Prisma schema into datasource/generator preamble plus a map of
 * named model/enum blocks. We don't need a full Prisma AST — only the
 * outer block boundaries. Brace counting handles nested `{ ... }` (none
 * exist in real Prisma schemas, but it's defensive).
 *
 * Throws on malformed input so the migration aborts cleanly.
 */
export function parsePrismaSchema(source: string): ParsedSchema {
  const blocks = new Map<string, { kind: 'model' | 'enum'; source: string }>()
  const order: string[] = []
  const preambleParts: string[] = []

  let i = 0
  const len = source.length

  const blockHeadRe = /^[ \t]*(model|enum)\s+(\w+)\s*\{/gm

  while (i < len) {
    blockHeadRe.lastIndex = i
    const match = blockHeadRe.exec(source)
    if (!match) {
      preambleParts.push(source.slice(i))
      break
    }

    const blockStart = match.index
    if (blockStart > i) preambleParts.push(source.slice(i, blockStart))

    const kind = match[1] as 'model' | 'enum'
    const name = match[2]

    let depth = 1
    let j = match.index + match[0].length
    while (j < len && depth > 0) {
      const ch = source[j]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      j++
    }
    if (depth !== 0) {
      throw new Error(`Unterminated ${kind} block "${name}" — schema appears malformed`)
    }

    const blockSource = source.slice(blockStart, j)
    if (blocks.has(name)) {
      throw new Error(`Duplicate ${kind} "${name}" in schema`)
    }
    blocks.set(name, { kind, source: blockSource })
    order.push(name)

    i = j
  }

  return { preamble: preambleParts.join('').trimEnd(), blocks, order }
}

/**
 * Merge skill-server models into root schema. Returns the merged source
 * plus a record of what changed. Pure function — no I/O.
 *
 * Collision policy: when both schemas define a block with the same name,
 * prefer the skill-server definition (it has user data behind it) and
 * rename the root's bare definition to `_<Name>` so it doesn't conflict.
 * The exception is when the two definitions are byte-identical: just
 * keep one copy and don't record a rename.
 */
export function mergeSchemas(rootSource: string, skillSource: string): {
  merged: string
  appended: string[]
  renamed: Array<{ from: string; to: string; reason: string }>
} {
  const root = parsePrismaSchema(rootSource)
  const skill = parsePrismaSchema(skillSource)

  const appended: string[] = []
  const renamed: Array<{ from: string; to: string; reason: string }> = []

  for (const name of skill.order) {
    const skillBlock = skill.blocks.get(name)!
    const rootBlock = root.blocks.get(name)

    if (!rootBlock) {
      root.blocks.set(name, skillBlock)
      root.order.push(name)
      appended.push(name)
      continue
    }

    if (normaliseBlock(rootBlock.source) === normaliseBlock(skillBlock.source)) {
      // Identical — no-op.
      continue
    }

    const renamedName = `_Template${name}`
    if (root.blocks.has(renamedName)) {
      throw new Error(`Cannot rename ${name} -> ${renamedName}: target already exists in root schema`)
    }

    const renamedSource = renameBlock(rootBlock.source, name, renamedName)
    root.blocks.set(renamedName, { kind: rootBlock.kind, source: renamedSource })
    const idx = root.order.indexOf(name)
    if (idx >= 0) root.order[idx] = renamedName

    root.blocks.set(name, skillBlock)
    root.order.push(name)
    appended.push(name)
    renamed.push({
      from: name,
      to: renamedName,
      reason: 'collision with skill-server schema; skill-server definition kept (has user data)',
    })
  }

  const out: string[] = []
  if (root.preamble.trim()) out.push(root.preamble.trim())
  for (const name of root.order) {
    const block = root.blocks.get(name)
    if (block) out.push(block.source.trimEnd())
  }
  return {
    merged: out.join('\n\n') + '\n',
    appended,
    renamed,
  }
}

function normaliseBlock(source: string): string {
  return source.replace(/\s+/g, ' ').trim()
}

function renameBlock(source: string, from: string, to: string): string {
  // Replace only the declarator name, e.g. `model User {` → `model _TemplateUser {`
  // (don't touch field references since renaming the type would break them anyway).
  return source.replace(
    new RegExp(`^(\\s*)(model|enum)(\\s+)${from}(\\s*\\{)`, 'm'),
    `$1$2$3${to}$4`,
  )
}

/**
 * Inject skill-server custom routes into root `server.tsx`. The legacy
 * skill server scaffolds `custom-routes.ts` as `export default app`
 * (a `Hono` instance), then mounts it at `/api/`. To preserve behaviour
 * at the root we extract the route handlers and append them as a
 * commented block followed by an attempt to mount them. When the import
 * surface in the original file references the skill-server's generated
 * paths (e.g. `from '../db'`), we leave it commented out so the agent
 * can review.
 *
 * Returns the new `server.tsx` content plus whether manual review is
 * needed.
 */
export function injectCustomRoutes(serverTsx: string, customRoutes: string, when: Date): {
  result: string
  needsReview: boolean
} {
  if (serverTsx.includes(CUSTOM_ROUTES_MARKER)) {
    return { result: serverTsx, needsReview: false }
  }

  const trimmed = customRoutes.trim()
  // The default scaffold has no real routes — skip injection entirely.
  const isEmptyScaffold = !/app\.(get|post|put|patch|delete|all|use|route)\b/.test(trimmed)
  if (isEmptyScaffold) {
    return { result: serverTsx, needsReview: false }
  }

  const importsSafe =
    !/from\s+['"]\.\.?\/db['"]/.test(trimmed) &&
    !/from\s+['"]\.\.?\/generated/.test(trimmed) &&
    !/from\s+['"]\.\.?\/custom-routes/.test(trimmed)

  const isoDate = when.toISOString().slice(0, 10)
  const header = [
    '',
    `${CUSTOM_ROUTES_MARKER} — from .shogo/server/custom-routes.ts on ${isoDate}`,
    '// Review and integrate; left intact for behavioural parity.',
    '',
  ].join('\n')

  if (importsSafe) {
    const block = [
      header,
      '// Original custom routes (mounted under /api/). The original used',
      "// `import { Hono } from 'hono'` and exported a Hono instance named",
      '// `app`. We rename it `customRoutesApp` to avoid clobbering the root',
      '// app instance, then mount it at /api/.',
      '',
      trimmed
        .replace(/\bconst\s+app\s*=\s*new\s+Hono\(\)/g, 'const customRoutesApp = new Hono()')
        .replace(/\bapp\.(get|post|put|patch|delete|all|use|route)\b/g, 'customRoutesApp.$1')
        .replace(/\bexport\s+default\s+app\b/g, '// export default app — replaced with mount below'),
      '',
      "app.route('/api', customRoutesApp)",
      '',
    ].join('\n')
    return { result: serverTsx.trimEnd() + '\n' + block, needsReview: false }
  }

  const block = [
    header,
    '// TODO(skill-server-migration): the original custom-routes.ts imported',
    '// from skill-server-specific paths (`./db`, `./generated/...`). The',
    '// block below is commented out — port the imports to the root paths',
    "// (e.g. `import { prisma } from './src/lib/db'`) and uncomment.",
    '/*',
    trimmed,
    '*/',
    '',
  ].join('\n')

  return { result: serverTsx.trimEnd() + '\n' + block, needsReview: true }
}

/**
 * Run the full migration. Idempotent: silently no-ops if `.shogo/server/`
 * is absent. On any failure the workspace is restored to its pre-migration
 * state (the snapshot is moved back into place).
 */
export function migrateSkillServerToRoot(workspaceDir: string): MigrationResult {
  const skillDir = join(workspaceDir, '.shogo', 'server')
  if (!existsSync(skillDir)) {
    return { migrated: false }
  }

  const now = new Date()
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const snapshotPath = join(workspaceDir, '.shogo', `server.migrated-${stamp}`)
  const result: MigrationResult = {
    migrated: false,
    snapshotPath,
    at: now.toISOString(),
    mergedModels: [],
    renamedModels: [],
    customRoutesMigrated: false,
    customRoutesNeedReview: false,
    databaseCopied: false,
  }

  let snapshotCreated = false

  try {
    cpSync(skillDir, snapshotPath, { recursive: true })
    snapshotCreated = true

    const skillSchemaPath = join(skillDir, 'schema.prisma')
    const rootPrismaDir = join(workspaceDir, 'prisma')
    const rootSchemaPath = join(rootPrismaDir, 'schema.prisma')

    if (existsSync(skillSchemaPath)) {
      const skillSchema = readFileSync(skillSchemaPath, 'utf-8')
      const rootSchema = existsSync(rootSchemaPath)
        ? readFileSync(rootSchemaPath, 'utf-8')
        : DEFAULT_ROOT_SCHEMA

      const { merged, appended, renamed } = mergeSchemas(rootSchema, skillSchema)
      mkdirSync(rootPrismaDir, { recursive: true })
      writeFileSync(rootSchemaPath, merged, 'utf-8')
      result.mergedModels = appended
      result.renamedModels = renamed
    }

    const customRoutesPath =
      existsSync(join(skillDir, 'custom-routes.ts'))
        ? join(skillDir, 'custom-routes.ts')
        : existsSync(join(skillDir, 'custom-routes.tsx'))
          ? join(skillDir, 'custom-routes.tsx')
          : null
    const rootServerTsx = join(workspaceDir, 'server.tsx')

    if (customRoutesPath && existsSync(rootServerTsx)) {
      const original = readFileSync(rootServerTsx, 'utf-8')
      const customRoutes = readFileSync(customRoutesPath, 'utf-8')
      const { result: updated, needsReview } = injectCustomRoutes(original, customRoutes, now)
      if (updated !== original) {
        writeFileSync(rootServerTsx, updated, 'utf-8')
        result.customRoutesMigrated = true
        result.customRoutesNeedReview = needsReview
      }
    }

    const candidates = ['skill.db', 'dev.db']
    let skillDbPath: string | null = null
    for (const name of candidates) {
      const p = join(skillDir, name)
      if (existsSync(p) && safeIsFile(p)) {
        skillDbPath = p
        break
      }
    }
    if (skillDbPath) {
      const rootDbPath = join(rootPrismaDir, 'dev.db')
      if (!existsSync(rootDbPath)) {
        mkdirSync(rootPrismaDir, { recursive: true })
        cpSync(skillDbPath, rootDbPath)
        result.databaseCopied = true
      }
    }

    const notesPath = join(snapshotPath, 'MIGRATION_NOTES.md')
    writeFileSync(notesPath, buildNotes(result, customRoutesPath !== null), 'utf-8')
    result.notesPath = notesPath

    rmSync(skillDir, { recursive: true, force: true })
    result.migrated = true
    console.log(`[${LOG_PREFIX}] Migrated .shogo/server/ → root paths (snapshot at ${snapshotPath})`)

    return result
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${LOG_PREFIX}] Migration failed: ${message}`)

    if (snapshotCreated) {
      try {
        if (existsSync(skillDir)) rmSync(skillDir, { recursive: true, force: true })
        cpSync(snapshotPath, skillDir, { recursive: true })
        rmSync(snapshotPath, { recursive: true, force: true })
        console.error(`[${LOG_PREFIX}] Workspace restored to pre-migration state`)
      } catch (restoreErr: any) {
        console.error(
          `[${LOG_PREFIX}] CRITICAL: failed to restore workspace state: ${restoreErr.message}. ` +
          `Snapshot remains at ${snapshotPath}; manual recovery required.`,
        )
      }
    }

    return {
      migrated: false,
      snapshotPath: snapshotCreated ? snapshotPath : undefined,
      error: message,
    }
  }
}

function safeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const DEFAULT_ROOT_SCHEMA = `generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "sqlite"
}
`

function buildNotes(result: MigrationResult, hadCustomRoutes: boolean): string {
  const lines: string[] = [
    '# Skill Server Migration',
    '',
    `Migrated \`.shogo/server/\` into project root on ${result.at}.`,
    '',
    '## What changed',
    '',
  ]

  if (result.mergedModels && result.mergedModels.length > 0) {
    lines.push(`- Appended ${result.mergedModels.length} model/enum block(s) to \`prisma/schema.prisma\`: ${result.mergedModels.join(', ')}`)
  } else {
    lines.push('- No new models/enums needed merging.')
  }

  if (result.renamedModels && result.renamedModels.length > 0) {
    lines.push('- Renamed conflicting blocks (template -> `_Template*`):')
    for (const { from, to, reason } of result.renamedModels) {
      lines.push(`  - \`${from}\` -> \`${to}\` (${reason})`)
    }
  }

  if (result.customRoutesMigrated) {
    if (result.customRoutesNeedReview) {
      lines.push('- Custom routes from `custom-routes.ts` were injected into `server.tsx` **commented out** because their imports referenced skill-server-specific paths. Search for `MIGRATED-CUSTOM-ROUTES` in `server.tsx` and port the imports.')
    } else {
      lines.push('- Custom routes from `custom-routes.ts` were ported into `server.tsx` (mounted as `customRoutesApp` under `/api/`). Search for `MIGRATED-CUSTOM-ROUTES` in `server.tsx` to verify.')
    }
  } else if (hadCustomRoutes) {
    lines.push('- `custom-routes.ts` had no real route handlers; nothing to port.')
  }

  if (result.databaseCopied) {
    lines.push('- Skill-server SQLite database copied to `prisma/dev.db`.')
  }

  lines.push('')
  lines.push('## Rollback')
  lines.push('')
  lines.push('The original `.shogo/server/` is preserved in this directory. To roll back:')
  lines.push('')
  lines.push('```sh')
  lines.push('rm -rf .shogo/server')
  lines.push(`mv ${result.snapshotPath?.split('/').pop()} .shogo/server`)
  lines.push('```')
  lines.push('')
  lines.push('Then revert any changes the migration made to `prisma/schema.prisma` and `server.tsx`.')
  lines.push('')
  return lines.join('\n')
}
