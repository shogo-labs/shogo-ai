// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `files`, `exports`, `bin` and `tsup.config.ts` are four hand-kept lists in
 * every published package, and nothing used to make them agree. SDK 2.6.1
 * shipped `exports["./bucket"]` with no tsup entry and a `bin/cli.mjs` that
 * imported a `bin/bucket-cli.mjs` missing from `files` (SHO-511).
 *
 * This is the source-level half of the guard: it reads the package as it sits
 * in the checkout and reports every disagreement. `scripts/verify-packed-packages.ts`
 * is the other half — it packs the tarball and proves the published artifact
 * actually loads. A problem only this module can catch is "the list is wrong
 * but the build happens to paper over it"; a problem only the tarball gate can
 * catch is "the list is right but the file is not in the pack".
 *
 * The SDK has its own copy of these checks in
 * `packages/sdk/src/__tests__/sdk-packaging.test.ts` because it is typechecked
 * against the package's own tsconfig and cannot import from `scripts/`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/** Directory names under `packages/` for every package we publish. */
export const PUBLISHED_PACKAGE_DIRS = [
  'core',
  'agent',
  'db',
  'email',
  'voice',
  'cli',
  'sdk',
  'shogo-worker',
] as const

interface ExportsCondition {
  [condition: string]: string | ExportsCondition
}

interface PackageJson {
  name?: string
  files?: string[]
  bin?: string | Record<string, string>
  exports?: string | ExportsCondition
  main?: string
  module?: string
  types?: string
}

/**
 * Turn an npm `files` glob into a matcher. npm's rules are the ones that
 * matter here: `**` crosses directories (including zero of them), `*` does not,
 * and a bare directory name matches everything under it.
 */
export function filesGlobMatcher(patterns: string[]): (path: string) => boolean {
  const matchers = patterns.map((pattern) => {
    const normalized = pattern.replace(/^\.\//, '').replace(/\/$/, '')
    if (normalized.includes('*')) {
      return new RegExp(`^${globToRegExpSource(normalized)}$`)
    }
    // A bare directory (or a file) matches itself and everything beneath it.
    const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${escaped}(/.*)?$`)
  })
  return (path: string) => matchers.some((matcher) => matcher.test(path))
}

/**
 * npm's `**` must match zero or more directories: `dist/**` + slash + `*.js`
 * has to match `dist/index.js` as well as `dist/sub/x.js`, while a single `*`
 * stays inside one directory.
 */
function globToRegExpSource(pattern: string): string {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
  }
  return source
}

function stripDotSlash(value: string): string {
  return value.replace(/^\.\//, '')
}

/** Every tsup entry in a package's `tsup.config.ts`, as repo-relative paths. */
export function tsupEntries(packageDir: string): string[] {
  const configPath = join(packageDir, 'tsup.config.ts')
  if (!existsSync(configPath)) return []
  const source = readFileSync(configPath, 'utf8')
  return [...source.matchAll(/['"]([^'"]*\.ts)['"]/g)]
    .map((match) => match[1])
    .filter((entry) => entry.startsWith('src/'))
}

/** `exports` targets that a consumer resolves at runtime (not `development`). */
function runtimeTargets(conditions: ExportsCondition): string[] {
  const targets: string[] = []
  for (const [condition, target] of Object.entries(conditions)) {
    if (condition === 'development') continue
    if (typeof target === 'string') targets.push(target)
    else targets.push(...runtimeTargets(target))
  }
  return targets
}

/** `dist/index.cjs` -> `src/index.ts`, the tsup entry that must build it. */
function targetToSource(target: string): string {
  return stripDotSlash(target)
    .replace(/^dist\//, 'src/')
    .replace(/\.(d\.ts|d\.cts|d\.mts|js|cjs|mjs)$/, '.ts')
}

/**
 * A quoted relative path with a runtime extension. `bin/cli.mjs` hands
 * `'./bucket-cli.mjs'` to a lazy loader instead of writing
 * `import('./bucket-cli.mjs')`, so a check that only looks at `from`, `import()`
 * and `require()` calls cannot see it — which is exactly how 2.6.1 shipped a
 * CLI that died on its first subcommand.
 */
const RELATIVE_ASSET = /['"](\.[^'"\s]*\.(?:mjs|cjs|js|json))['"]/g

/**
 * Relative paths a published `bin/**` file refers to, looking at code only.
 * `packages/shogo-worker/bin/shogo.mjs` describes its resolution order in a
 * header comment (`../src/cli.ts` is a monorepo-only path), and a comment must
 * never fail the gate.
 */
function relativeAssets(source: string): string[] {
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
  return [...code.matchAll(RELATIVE_ASSET)].map((match) => match[1])
}

function normalizePath(value: string): string {
  return value.split(sep).join('/')
}

/**
 * `dist/` is tsup output, and the static step runs *before* the build: a clean
 * checkout has no `dist/` at all. Its files still have to be in `files` (that
 * is the publication question this module answers), but "not on disk yet" is
 * not a defect — the packed-tarball gate is what proves the build produced
 * them.
 */
function isBuildOutput(path: string): boolean {
  return path.startsWith('dist/')
}

/**
 * Every relative file a published `bin` entry reaches, directly or through
 * another bin file, has to be in `files` — otherwise `npm install` produces a
 * CLI whose subcommand is missing. Walks the chain because
 * `cli.mjs` -> `bucket-cli.mjs` -> `bucket/run.mjs` is one missing file away
 * from the same crash.
 */
export function unpublishedBinAssets(
  packageDir: string,
  label: string,
  binEntries: ReadonlyArray<readonly [string, string]>,
  isPublished: (path: string) => boolean,
): string[] {
  const problems: string[] = []
  const queue = binEntries.map(([name, target]) => ({ name, path: stripDotSlash(target) }))
  const seen = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift() as { name: string; path: string }
    if (seen.has(current.path)) continue
    seen.add(current.path)
    const absolute = join(packageDir, current.path)
    if (!existsSync(absolute)) continue
    for (const specifier of relativeAssets(readFileSync(absolute, 'utf8'))) {
      const resolved = normalizePath(join(dirname(current.path), specifier))
      if (!isPublished(resolved)) {
        problems.push(
          `${label}: bin["${current.name}"] (${current.path}) refers to '${specifier}' -> ${resolved}, which matches no "files" glob, so the installed CLI is missing it`,
        )
      } else if (!isBuildOutput(resolved) && !existsSync(join(packageDir, resolved))) {
        problems.push(`${label}: bin["${current.name}"] (${current.path}) refers to '${specifier}', which does not exist`)
      } else {
        queue.push({ name: current.name, path: resolved })
      }
    }
  }
  return problems
}

/**
 * Every way the four lists in one package disagree with each other.
 * An empty array means the package is internally consistent.
 */
export function checkPackageLists(packageDir: string): string[] {
  const problems: string[] = []
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageJson
  const label = pkg.name ?? packageDir

  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    problems.push(`${label}: package.json has no "files" list, so npm would publish the whole checkout`)
  }
  const isPublished = filesGlobMatcher(pkg.files ?? [])
  const entries = tsupEntries(packageDir)

  const binEntries =
    typeof pkg.bin === 'string'
      ? [['(bin)', pkg.bin] as const]
      : Object.entries(pkg.bin ?? {})
  for (const [name, target] of binEntries) {
    const path = stripDotSlash(target)
    if (!existsSync(join(packageDir, path))) {
      problems.push(`${label}: bin["${name}"] -> ${path} does not exist`)
      continue
    }
    if (!isPublished(path)) {
      problems.push(`${label}: bin["${name}"] -> ${path} matches no "files" glob, so the installed CLI is missing`)
    }
  }
  problems.push(...unpublishedBinAssets(packageDir, label, binEntries, isPublished))

  const exportsMap = typeof pkg.exports === 'string' ? { '.': pkg.exports } : (pkg.exports ?? {})
  for (const [key, conditions] of Object.entries(exportsMap)) {
    if (typeof conditions === 'string') {
      // A package that ships TypeScript source (the worker) points its exports
      // at `src/*.ts`; a bare string is fine there. What matters is that the
      // target exists and is published.
      const path = stripDotSlash(conditions)
      if (!existsSync(join(packageDir, path))) {
        problems.push(`${label}: exports["${key}"] -> ${path} does not exist`)
      } else if (!isPublished(path)) {
        problems.push(`${label}: exports["${key}"] -> ${path} matches no "files" glob`)
      }
      continue
    }
    for (const [condition, target] of Object.entries(conditions)) {
      if (typeof target !== 'string') continue
      const path = stripDotSlash(target)
      // `development` is dev-only and stripped by the publish workflow, so its
      // source target is deliberately not in "files". It still has to exist and
      // be a tsup entry, or a monorepo consumer resolves nothing.
      if (condition === 'development') {
        if (!existsSync(join(packageDir, path))) {
          problems.push(`${label}: exports["${key}"].development -> ${path} does not exist`)
        }
        if (!entries.includes(path)) {
          problems.push(`${label}: exports["${key}"].development -> ${path} is not a tsup entry`)
        }
        continue
      }
      if (!isPublished(path)) {
        problems.push(`${label}: exports["${key}"].${condition} -> ${path} matches no "files" glob`)
      }
      const source = targetToSource(path)
      if (!entries.includes(source)) {
        problems.push(`${label}: exports["${key}"].${condition} -> ${path} has no tsup entry (expected ${source})`)
      }
    }
    const targets = runtimeTargets(conditions)
    if (targets.length === 0) {
      problems.push(`${label}: exports["${key}"] has no runtime condition`)
    }
  }

  for (const [field, value] of [
    ['main', pkg.main],
    ['module', pkg.module],
    ['types', pkg.types],
  ] as const) {
    if (!value) continue
    const path = stripDotSlash(value)
    if (!isPublished(path)) {
      problems.push(`${label}: ${field} -> ${path} matches no "files" glob`)
    }
  }

  return problems
}
