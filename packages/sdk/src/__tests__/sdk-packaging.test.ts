// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Packaging guard (SHO-511).
 *
 * `npm publish` ships whatever `package.json` "files" matches, but every other
 * check we run resolves against the source tree: the unit tests run with
 * `--conditions=development` (so every `exports` entry points at `src/*.ts`),
 * typecheck only looks at `src`, and inside the monorepo the package is linked
 * to the full checkout. A file that exists in the repo but is not published,
 * or an `exports` target no tsup entry builds, therefore passes everything and
 * only breaks the installed package.
 *
 * 2.6.1 shipped both bugs: `bin/bucket-cli.mjs` was left out of "files" (and
 * the published `bin/cli.mjs` imported it at the top of the file, so *every*
 * `shogo` command — `generate` included — threw on module load), and
 * `exports["./bucket"]` pointed at a `dist/bucket/` that was never built.
 *
 * These checks are static on purpose: no build, no `npm pack`, so the normal
 * "Lint, Typecheck, Test" job catches the regression in milliseconds.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const packageDir = resolve(import.meta.dir, '..', '..')

const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  files: string[]
  bin?: Record<string, string>
  exports: Record<string, Record<string, string>>
}

const tsupSource = readFileSync(join(packageDir, 'tsup.config.ts'), 'utf8')
const tsupEntries = [...tsupSource.matchAll(/['"](src\/[^'"]+\.ts)['"]/g)].map((m) => m[1])

/** npm "files" globs to RegExp: `**` spans directories, `*` stays in one. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .split('\u0000')
    .join('(?:.*/)?')
    .split('\u0001')
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

const fileMatchers = pkg.files.map(globToRegExp)
const isPublished = (path: string) => fileMatchers.some((re) => re.test(path))
const stripDotSlash = (path: string) => path.replace(/^\.\//, '')

describe('@shogo-ai/sdk packaging', () => {
  it('publishes every `bin` entry', () => {
    const problems: string[] = []
    for (const [name, target] of Object.entries(pkg.bin ?? {})) {
      const path = stripDotSlash(target)
      if (!existsSync(join(packageDir, path))) {
        problems.push(`bin.${name}: ${path} does not exist in the repo`)
      }
      if (!isPublished(path)) {
        problems.push(`bin.${name}: ${path} is not matched by "files", so the installed CLI cannot start`)
      }
    }
    expect(problems).toEqual([])
  })

  it('builds and publishes every `exports` target', () => {
    const problems: string[] = []
    for (const [key, conditions] of Object.entries(pkg.exports)) {
      const development = conditions.development
      if (development) {
        const source = stripDotSlash(development)
        if (!existsSync(join(packageDir, source))) {
          problems.push(`exports["${key}"]: development target ${source} does not exist`)
        }
        if (!tsupEntries.includes(source)) {
          problems.push(`exports["${key}"]: ${source} is not a tsup entry, so nothing compiles for it`)
        }
      }
      for (const [condition, target] of Object.entries(conditions)) {
        if (condition === 'development') continue
        const path = stripDotSlash(target)
        if (!isPublished(path)) {
          problems.push(`exports["${key}"].${condition}: ${path} is not matched by "files"`)
        }
        const source = path.replace(/^dist\//, 'src/').replace(/\.(d\.ts|d\.cts|js|cjs|mjs)$/, '.ts')
        if (!tsupEntries.includes(source)) {
          problems.push(`exports["${key}"].${condition}: ${path} has no tsup entry (expected ${source})`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('resolves every relative import in a published bin script', () => {
    const problems: string[] = []
    const binDir = join(packageDir, 'bin')
    for (const name of readdirSync(binDir)) {
      if (!name.endsWith('.mjs')) continue
      const publishedPath = `bin/${name}`
      if (!isPublished(publishedPath)) continue
      const source = readFileSync(join(binDir, name), 'utf8')
      const specifiers = [...source.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1])
      for (const specifier of specifiers) {
        const target = join('bin', specifier.replace(/^\.\//, ''))
        if (!existsSync(join(packageDir, target))) {
          problems.push(`${publishedPath} imports ${specifier}, which does not exist`)
        } else if (!isPublished(target)) {
          problems.push(`${publishedPath} imports ${specifier}, which "files" does not publish, so the installed CLI crashes`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('loads subcommand CLIs lazily so one missing file cannot break `generate`', () => {
    const cli = readFileSync(join(packageDir, 'bin', 'cli.mjs'), 'utf8')
    const offenders = [...cli.matchAll(/^import\b[^\n]*$/gm)]
      .map((m) => m[0])
      .filter((line) => /from\s+['"]\.\/(?:bucket-cli|three-d-cli)\.mjs['"]/.test(line))
    expect(offenders).toEqual([])
  })

  it('regression (SHO-511): the bucket CLI and the ./bucket export ship', () => {
    expect(pkg.files).toContain('bin/bucket-cli.mjs')
    expect(tsupEntries).toContain('src/bucket/index.ts')
  })
})
