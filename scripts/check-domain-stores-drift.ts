// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Fail when `packages/domain-stores` is stale for `prisma/schema.prisma`.
 *
 * `packages/domain-stores/src/{*.model,*.types,*.collection}.ts` are generated
 * by `packages/sdk/src/generators/prisma-generator.ts` — the output entry for
 * that directory in `shogo.config.json`, which `bun x shogo generate` (and the
 * root `postinstall`) writes. They are tracked in git, so every schema change
 * has to ship the regenerated output in the same PR.
 *
 * Forgetting that is invisible: no typecheck, test or lint reads these files
 * against the schema, so the drift only shows up as 16 dirty files the next
 * time somebody runs `bun install` — a diff they did not make and cannot
 * attribute. SHO-412 left `ChatSession.directKey` out that way, and SHO-415
 * was written from the resulting dirty tree.
 *
 * The check regenerates the domain-stores output in memory (nothing is
 * written to disk) and compares it byte for byte with the committed files, so
 * it is safe to run at any time, on any tree.
 *
 * Usage
 * -----
 *   bun scripts/check-domain-stores-drift.ts            # exit 1 on any drift
 *   bun scripts/check-domain-stores-drift.ts --quiet    # suppress "all clean"
 *   bun scripts/check-domain-stores-drift.ts --staged   # compare the index
 *
 * Runs from `bun run check:domain-stores`, the CI "Typecheck & static checks"
 * job, and `.githooks/pre-commit` (with `--staged`) whenever a Prisma schema
 * is staged.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  generateFromPrisma,
  type OutputConfig,
} from '../packages/sdk/src/generators/prisma-generator'

const ROOT = resolve(import.meta.dir, '..')
const DOMAIN_STORES_DIR = join(ROOT, 'packages/domain-stores/src')
const quiet = process.argv.includes('--quiet')
/**
 * Compare the staged content instead of the working tree — the pre-commit hook
 * needs it, because a developer can stage stale files and regenerate after
 * `git add`, which the working tree would hide.
 */
const staged = process.argv.includes('--staged')

/**
 * File suffixes the generator owns inside `packages/domain-stores/src`.
 * Hand-written neighbours (`types.ts`, `model-types.ts`, `domain.ts`,
 * `domain-actions.ts`, `__tests__/`) deliberately do not match.
 */
const GENERATED_SUFFIXES = ['.model.ts', '.types.ts', '.collection.ts']

interface ShogoConfig {
  schema?: string
  models?: string[]
  excludeModels?: string[]
  outputs?: OutputConfig[]
}

function readConfig(): ShogoConfig | undefined {
  const configPath = join(ROOT, 'shogo.config.json')
  if (!existsSync(configPath)) return undefined
  return JSON.parse(readFileSync(configPath, 'utf-8')) as ShogoConfig
}

/** Content of a repo-relative path, from the index when `--staged`. */
function readCommitted(relPath: string): string | undefined {
  if (!staged) {
    const absPath = join(ROOT, relPath)
    return existsSync(absPath) ? readFileSync(absPath, 'utf-8') : undefined
  }
  try {
    return execFileSync('git', ['show', `:${relPath}`], {
      cwd: ROOT,
      encoding: 'utf-8',
    })
  } catch {
    return undefined
  }
}

/** Every generated-looking file inside the output dir, index-only when `--staged`. */
function listGenerated(): string[] {
  const matches = (name: string) =>
    GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))

  if (staged) {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--', relative(ROOT, DOMAIN_STORES_DIR)],
      { cwd: ROOT, encoding: 'utf-8' },
    )
    return out
      .split('\0')
      .filter((p) => p.length > 0 && matches(p.split('/').pop() ?? ''))
      .map((p) => join(ROOT, p))
  }

  return readdirSync(DOMAIN_STORES_DIR)
    .filter(matches)
    .map((name) => join(DOMAIN_STORES_DIR, name))
}

async function main(): Promise<number> {
  const config = readConfig()
  if (!config) {
    if (!quiet) console.log('[domain-stores] no shogo.config.json — skipping.')
    return 0
  }

  const output = (config.outputs ?? []).find(
    (o) => resolve(ROOT, o.dir) === DOMAIN_STORES_DIR,
  )
  if (!output) {
    if (!quiet) {
      console.log('[domain-stores] no output for packages/domain-stores/src — skipping.')
    }
    return 0
  }

  const schemaPath = resolve(ROOT, config.schema ?? 'prisma/schema.prisma')
  if (!existsSync(schemaPath)) {
    console.error(`[domain-stores] schema not found: ${schemaPath}`)
    return 1
  }

  const result = await generateFromPrisma({
    schemaPath,
    models: config.models,
    excludeModels: config.excludeModels,
    outputs: [{ ...output, dir: DOMAIN_STORES_DIR }],
  })

  const drift: string[] = []
  const generated = new Set<string>()

  for (const file of result.files) {
    const absPath = resolve(ROOT, file.path)
    generated.add(absPath)
    // `skipIfExists` files are hand-editable by design (the generator never
    // overwrites them), so their content is not a drift signal.
    if (file.skipIfExists) continue

    const relPath = relative(ROOT, absPath)
    const committed = readCommitted(relPath)
    if (committed === undefined) {
      drift.push(`missing   ${relPath}`)
      continue
    }
    if (committed !== file.content) {
      drift.push(`stale     ${relPath}`)
    }
  }

  for (const absPath of listGenerated()) {
    if (!generated.has(absPath)) {
      drift.push(`orphaned  ${relative(ROOT, absPath)}`)
    }
  }

  if (drift.length === 0) {
    if (!quiet) {
      console.log(
        `[domain-stores] in sync — ${result.files.length} generated files match prisma/schema.prisma.`,
      )
    }
    return 0
  }

  console.error('')
  console.error('╔══════════════════════════════════════════════════════════════╗')
  console.error('║  packages/domain-stores is stale for prisma/schema.prisma    ║')
  console.error('╚══════════════════════════════════════════════════════════════╝')
  console.error('')
  for (const line of drift) console.error(`  ${line}`)
  console.error('')
  console.error('  These files are generated and tracked, so a schema change has to')
  console.error('  ship its regenerated output in the same PR. To fix:')
  console.error('')
  console.error('      bun run generate:routes      # or: bun install')
  console.error('')
  console.error('  then commit the regenerated packages/domain-stores files.')
  console.error('')
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[domain-stores] check failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
