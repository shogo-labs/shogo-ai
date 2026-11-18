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
 * against the schema, so the drift only shows up as ~16 dirty files the next
 * time somebody runs `bun install` — a diff they did not make and cannot
 * attribute. SHO-412 left `ChatSession.directKey` out that way, and SHO-415
 * was written from the resulting dirty tree.
 *
 * The check regenerates the domain-stores output in memory (nothing is
 * written to disk) and compares it byte for byte with what is committed, so it
 * is safe to run at any time, on any tree.
 *
 * Usage
 * -----
 *   bun scripts/check-domain-stores-drift.ts                # compare `HEAD`
 *   bun scripts/check-domain-stores-drift.ts --staged       # compare the index
 *   bun scripts/check-domain-stores-drift.ts --working-tree # compare the files
 *   bun scripts/check-domain-stores-drift.ts --quiet        # suppress "all clean"
 *
 * `HEAD` is the default on purpose: in CI (and after a postinstall) the files
 * on disk have already been regenerated, so a working-tree comparison there
 * can only ever pass — which is how the first version of this guard let a
 * stale commit through (QA, SHO-415 round 1). What has to be current is what
 * is committed.
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
 * Where the committed content is read from.
 *
 * - `head` — `git show HEAD:<path>`; the CI guard and the default.
 * - `staged` — `git show :<path>`; the pre-commit hook, so a developer who
 *   stages stale files and regenerates after `git add` is still caught.
 * - `working-tree` — the files on disk, for "did I regenerate?".
 */
export type ComparisonMode = 'head' | 'staged' | 'working-tree'

const MODE: ComparisonMode = process.argv.includes('--staged')
  ? 'staged'
  : process.argv.includes('--working-tree')
    ? 'working-tree'
    : 'head'

/**
 * File suffixes the generator owns inside `packages/domain-stores/src`.
 * Hand-written neighbours (`types.ts`, `model-types.ts`, `domain.ts`,
 * `domain-actions.ts`, `__tests__/`) deliberately do not match.
 */
export const GENERATED_SUFFIXES = ['.model.ts', '.types.ts', '.collection.ts']

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

function git(args: string[], repoRoot: string): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Content of `relPath` as seen in `mode`, or `undefined` when it is not there.
 *
 * `relPath` is repo-relative, which is what `git show` and `git ls-tree` want.
 */
export function readContent(
  mode: ComparisonMode,
  relPath: string,
  repoRoot: string,
): string | undefined {
  if (mode === 'working-tree') {
    const absPath = join(repoRoot, relPath)
    return existsSync(absPath) ? readFileSync(absPath, 'utf-8') : undefined
  }

  try {
    const spec = mode === 'staged' ? `:${relPath}` : `HEAD:${relPath}`
    return git(['show', spec], repoRoot)
  } catch {
    return undefined
  }
}

/** Every generated-looking file under `dirRelPath`, as repo-relative paths. */
export function listGeneratedFiles(
  mode: ComparisonMode,
  dirRelPath: string,
  repoRoot: string,
): string[] {
  const matches = (name: string) =>
    GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))

  if (mode === 'working-tree') {
    return readdirSync(join(repoRoot, dirRelPath))
      .filter(matches)
      .map((name) => `${dirRelPath}/${name}`)
  }

  const listed =
    mode === 'staged'
      ? git(['ls-files', '-z', '--cached', '--', dirRelPath], repoRoot)
      : git(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', dirRelPath], repoRoot)

  return listed
    .split('\0')
    .filter((p) => p.length > 0 && matches(p.split('/').pop() ?? ''))
}

/** One file the generator produced, as a repo-relative path plus its content. */
export interface GeneratedFile {
  path: string
  content: string
  /** Hand-editable by design — the generator never overwrites it. */
  skipIfExists?: boolean
}

/**
 * Compare the generator's output with what is committed.
 *
 * Pure on purpose: the git/fs half lives in `readContent`/`listGeneratedFiles`
 * so this half can be pinned in `scripts/__tests__` without a repo.
 */
export function computeDrift(
  files: GeneratedFile[],
  sources: {
    read: (relPath: string) => string | undefined
    list: () => string[]
  },
): string[] {
  const drift: string[] = []
  const generated = new Set<string>()

  for (const file of files) {
    generated.add(file.path)
    // `skipIfExists` files are hand-editable by design, so their content is
    // not a drift signal.
    if (file.skipIfExists) continue

    const committed = sources.read(file.path)
    if (committed === undefined) {
      drift.push(`missing   ${file.path}`)
      continue
    }
    if (committed !== file.content) {
      drift.push(`stale     ${file.path}`)
    }
  }

  for (const path of sources.list()) {
    if (!generated.has(path)) drift.push(`orphaned  ${path}`)
  }

  return drift
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

  const files: GeneratedFile[] = result.files.map((file) => ({
    path: relative(ROOT, resolve(ROOT, file.path)),
    content: file.content,
    skipIfExists: file.skipIfExists,
  }))

  const dirRelPath = relative(ROOT, DOMAIN_STORES_DIR)
  const drift = computeDrift(files, {
    read: (relPath) => readContent(MODE, relPath, ROOT),
    list: () => listGeneratedFiles(MODE, dirRelPath, ROOT),
  })

  if (drift.length === 0) {
    if (!quiet) {
      console.log(
        `[domain-stores] in sync — ${files.length} generated files match prisma/schema.prisma (${MODE}).`,
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

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[domain-stores] check failed:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
