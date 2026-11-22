// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The static half of the release gate (SHO-512).
 *
 * `files`, `exports`, `bin` and `tsup.config.ts` are four hand-kept lists in
 * every published package. SDK 2.6.1 shipped a `bin/cli.mjs` that imported an
 * unpublished sibling and an `exports["./bucket"]` with no tsup entry, and
 * nothing noticed. This suite keeps the lists in agreement on every published
 * package in milliseconds, so the normal "Lint, Typecheck, Test" job catches a
 * disagreement long before `scripts/verify-packed-packages.ts` spends a minute
 * packing and installing the real tarballs.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PUBLISHED_PACKAGE_DIRS, checkPackageLists, filesGlobMatcher } from '../packaging-lists'

const ROOT = resolve(import.meta.dir, '../..')

function fixture(manifest: Record<string, unknown>, options: { tsup?: string; files?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'packaging-lists-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@shogo-ai/fixture', ...manifest }, null, 2))
  writeFileSync(join(dir, 'tsup.config.ts'), options.tsup ?? "export default { entry: ['src/index.ts'] }\n")
  for (const file of options.files ?? []) {
    const full = join(dir, file)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, '')
  }
  return dir
}

describe('filesGlobMatcher', () => {
  it('matches npm’s `**` across zero or more directories', () => {
    const matches = filesGlobMatcher(['dist/**/*.js'])
    expect(matches('dist/index.js')).toBe(true)
    expect(matches('dist/bucket/index.js')).toBe(true)
    expect(matches('dist/index.cjs')).toBe(false)
    expect(matches('src/index.js')).toBe(false)
  })

  it('treats a bare directory as everything under it', () => {
    const matches = filesGlobMatcher(['bin'])
    expect(matches('bin/cli.mjs')).toBe(true)
    expect(matches('bin')).toBe(true)
    expect(matches('dist/cli.mjs')).toBe(false)
  })

  it('ignores a leading ./ in a pattern', () => {
    expect(filesGlobMatcher(['./bin/*.mjs'])('bin/cli.mjs')).toBe(true)
  })
})

describe('checkPackageLists — every published package', () => {
  for (const dir of PUBLISHED_PACKAGE_DIRS) {
    it(`packages/${dir} keeps files, exports, bin and tsup in agreement`, () => {
      expect(checkPackageLists(join(ROOT, 'packages', dir))).toEqual([])
    })
  }
})

describe('checkPackageLists — regressions', () => {
  it('reports an exports target with no tsup entry (SHO-511: ./bucket)', () => {
    const dir = fixture(
      {
        files: ['dist/**/*.js'],
        exports: { './bucket': { import: './dist/bucket/index.js', require: './dist/bucket/index.cjs' } },
      },
      { files: ['dist/bucket/index.js', 'dist/bucket/index.cjs'] },
    )
    try {
      const problems = checkPackageLists(dir)
      expect(problems.some((problem) => problem.includes('has no tsup entry'))).toBe(true)
      expect(problems.some((problem) => problem.includes('src/bucket/index.ts'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a bin file that "files" does not publish (SHO-511: bin/bucket-cli.mjs)', () => {
    const dir = fixture({ files: ['dist/**/*.js'], bin: { shogo: './bin/cli.mjs' } }, { files: ['bin/cli.mjs'] })
    try {
      const problems = checkPackageLists(dir)
      expect(problems.some((problem) => problem.includes('bin["shogo"]') && problem.includes('"files" glob'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a bin file that does not exist at all', () => {
    const dir = fixture({ files: ['bin'], bin: { shogo: './bin/cli.mjs' } })
    try {
      expect(checkPackageLists(dir).some((problem) => problem.includes('does not exist'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not require a `development` target to be published — the publish step strips it', () => {
    const dir = fixture(
      {
        files: ['dist/**/*.js'],
        exports: { '.': { development: './src/index.ts', import: './dist/index.js' } },
      },
      { files: ['dist/index.js', 'src/index.ts'] },
    )
    try {
      expect(checkPackageLists(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a `development` target that is not a tsup entry', () => {
    const dir = fixture(
      {
        files: ['dist/**/*.js'],
        exports: { '.': { development: './src/index.ts', import: './dist/index.js' } },
      },
      { files: ['dist/index.js'], tsup: "export default { entry: ['src/other.ts'] }\n" },
    )
    try {
      expect(checkPackageLists(dir).some((problem) => problem.includes('is not a tsup entry'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('release gate wiring', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

  it('runs the tarball gate on packaging changes in PR CI', () => {
    const ci = read('.github/workflows/packaging-gate.yml')
    expect(ci).toContain('scripts/verify-packed-packages.ts')
    expect(ci).toContain('scripts/__tests__/packaging-lists.test.ts')
    // Path-filtered: a PR that cannot change packaging must not pay for it.
    expect(ci).toContain("packages/*/package.json")
    expect(ci).toContain("packages/*/bin/**")
    expect(ci).toContain("packages/*/tsup.config.ts")
  })

  it('runs the tarball gate before npm publish in the SDK release workflow', () => {
    const workflow = read('.github/workflows/publish-sdk.yml')
    expect(workflow).toContain('scripts/verify-packed-packages.ts')
  })

  it('runs the tarball gate before publishing the worker', () => {
    const workflow = read('.github/workflows/publish-shogo-worker.yml')
    expect(workflow).toContain('scripts/verify-packed-packages.ts')
  })

  it('keeps the gate script and its list module in the repo', () => {
    expect(existsSync(join(ROOT, 'scripts/verify-packed-packages.ts'))).toBe(true)
    expect(existsSync(join(ROOT, 'scripts/packaging-lists.ts'))).toBe(true)
  })
})
