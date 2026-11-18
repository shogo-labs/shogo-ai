// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for `scripts/check-domain-stores-drift.ts`.
 *
 * The guard exists because `packages/domain-stores` is generated from
 * `prisma/schema.prisma` by `bun install`'s postinstall and is tracked, so a
 * schema change committed without its regenerated output silently hands the
 * next `bun install` a dirty tree (SHO-412 → SHO-415). What has to be locked
 * down here:
 *
 *   1. Classification: the generator output is compared byte for byte, and a
 *      missing, stale or orphaned file is reported by name.
 *
 *   2. `skipIfExists` files are hand-editable by design and never count as
 *      drift, even when their content differs from what the generator would
 *      emit.
 *
 *   3. **The QA-round-1 bug**: the comparison must read the commit, not the
 *      working tree. In CI the same job's `bun install` has already run the
 *      generator over the checkout, so a working-tree comparison can only
 *      ever pass — and a PR that committed stale output sailed through. The
 *      first version of this guard did exactly that. `readContent('head')`
 *      and `readContent('staged')` therefore have to keep returning the
 *      committed/regenerated-then-`git add`ed content while the working tree
 *      holds something newer.
 *
 *   4. The wired default mode passes against the real checkout, so the CI
 *      step cannot fail for a reason unrelated to drift.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  GENERATED_SUFFIXES,
  computeDrift,
  listGeneratedFiles,
  readContent,
  type GeneratedFile,
} from '../check-domain-stores-drift'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const STORE_PATH = 'packages/domain-stores/src/user.types.ts'

const USER_TYPES_V1 = 'export const userV1 = true\n'
const USER_TYPES_V2 = 'export const userV2 = true\n'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

/** A throwaway repo holding one committed domain-stores file. */
function makeRepoWithCommittedStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'domain-stores-drift-'))
  tempDirs.push(dir)

  const run = (args: string[]) => {
    const result = spawnSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Drift Test', '-c', 'user.email=drift@example.com', ...args],
      { cwd: dir, encoding: 'utf-8' },
    )
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    }
  }

  run(['init', '-q'])
  mkdirSync(join(dir, 'packages/domain-stores/src'), { recursive: true })
  writeFileSync(join(dir, STORE_PATH), USER_TYPES_V1)
  run(['add', '.'])
  run(['commit', '-q', '-m', 'add stale store'])

  return dir
}

describe('computeDrift', () => {
  const files: GeneratedFile[] = [
    { path: STORE_PATH, content: USER_TYPES_V2 },
    { path: 'packages/domain-stores/src/user.model.ts', content: 'model\n' },
  ]

  test('reports nothing when every generated file matches', () => {
    const committed = new Map(files.map((f) => [f.path, f.content]))
    expect(
      computeDrift(files, {
        read: (path) => committed.get(path),
        list: () => files.map((f) => f.path),
      }),
    ).toEqual([])
  })

  test('reports a file whose committed content is behind the generator', () => {
    expect(
      computeDrift(files, {
        read: (path) => (path === STORE_PATH ? USER_TYPES_V1 : committedContent(path)),
        list: () => files.map((f) => f.path),
      }),
    ).toEqual([`stale     ${STORE_PATH}`])
  })

  test('reports a generated file that was never committed', () => {
    expect(
      computeDrift(files, {
        read: (path) => (path === STORE_PATH ? undefined : committedContent(path)),
        list: () => files.map((f) => f.path),
      }),
    ).toEqual([`missing   ${STORE_PATH}`])
  })

  test('reports a generated-looking file the generator no longer emits', () => {
    expect(
      computeDrift(files, {
        read: (path) => files.find((f) => f.path === path)?.content,
        list: () => [...files.map((f) => f.path), 'packages/domain-stores/src/gone.types.ts'],
      }),
    ).toEqual(['orphaned  packages/domain-stores/src/gone.types.ts'])
  })

  test('ignores skipIfExists files, which are hand-editable by design', () => {
    const handEdited: GeneratedFile[] = [
      { path: STORE_PATH, content: USER_TYPES_V2, skipIfExists: true },
    ]
    expect(
      computeDrift(handEdited, {
        read: () => 'hand written\n',
        list: () => [STORE_PATH],
      }),
    ).toEqual([])
  })

  function committedContent(path: string): string | undefined {
    return files.find((f) => f.path === path)?.content
  }
})

describe('readContent', () => {
  test('head and staged read the commit after a postinstall regenerated the tree', () => {
    const repo = makeRepoWithCommittedStore()

    // What `bun install`'s postinstall does to the checkout: rewrite the file.
    writeFileSync(join(repo, STORE_PATH), USER_TYPES_V2)

    // `readContent('working-tree')` is what the first version of the guard
    // read in CI — it sees the regenerated file and reports "in sync" no
    // matter what the PR committed.
    expect(readContent('working-tree', STORE_PATH, repo)).toBe(USER_TYPES_V2)

    // ...so a PR that committed stale output passed. These two are the fix:
    // the comparison sees the committed bytes and reports the drift.
    expect(readContent('head', STORE_PATH, repo)).toBe(USER_TYPES_V1)
    expect(readContent('staged', STORE_PATH, repo)).toBe(USER_TYPES_V1)

    const drift = computeDrift(
      [{ path: STORE_PATH, content: USER_TYPES_V2 }],
      {
        read: (path) => readContent('head', path, repo),
        list: () => listGeneratedFiles('head', 'packages/domain-stores/src', repo),
      },
    )
    expect(drift).toEqual([`stale     ${STORE_PATH}`])
  })

  test('stays stale when the stale file is staged and only then regenerated', () => {
    const repo = makeRepoWithCommittedStore()

    // What the developer does in the wrong order: stage the old bytes, then
    // run the generator. The working tree is now current and the index is not,
    // which is exactly the state the pre-commit hook has to catch.
    writeFileSync(join(repo, STORE_PATH), USER_TYPES_V2)
    expect(spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: repo }).status).toBe(0)
    writeFileSync(join(repo, STORE_PATH), USER_TYPES_V1)
    expect(spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: repo }).status).toBe(0)
    writeFileSync(join(repo, STORE_PATH), USER_TYPES_V2)

    expect(readContent('staged', STORE_PATH, repo)).toBe(USER_TYPES_V1)
    expect(readContent('working-tree', STORE_PATH, repo)).toBe(USER_TYPES_V2)
    expect(
      computeDrift([{ path: STORE_PATH, content: USER_TYPES_V2 }], {
        read: (path) => readContent('staged', path, repo),
        list: () => listGeneratedFiles('staged', 'packages/domain-stores/src', repo),
      }),
    ).toEqual([`stale     ${STORE_PATH}`])
  })

  test('returns undefined for a file the commit does not have', () => {
    const repo = makeRepoWithCommittedStore()
    expect(readContent('head', 'packages/domain-stores/src/nope.types.ts', repo)).toBeUndefined()
  })
})

describe('listGeneratedFiles', () => {
  test('lists only generated-looking files, from the commit', () => {
    const repo = makeRepoWithCommittedStore()
    writeFileSync(join(repo, 'packages/domain-stores/src/types.ts'), 'hand written\n')
    writeFileSync(join(repo, 'packages/domain-stores/src/user.model.ts'), 'model\n')

    const head = listGeneratedFiles('head', 'packages/domain-stores/src', repo)
    expect(head).toEqual([STORE_PATH])
    expect(GENERATED_SUFFIXES).toContain('.types.ts')
  })
})

describe('wired check', () => {
  test('runs end to end against this checkout', () => {
    // Deliberately `--working-tree`, not the CI default: this test must not
    // assert anything about the state of the checkout's HEAD. "Schema edited,
    // output regenerated, not committed yet" is a normal mid-work state, and
    // asserting the commit is current would turn `bun run test` red there for
    // everyone. What this covers is the wiring — config found, generator runs,
    // 63 files compared — while the mode mechanics are pinned above.
    const result = spawnSync('bun', ['scripts/check-domain-stores-drift.ts', '--working-tree'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
    expect(result.stdout).toContain('in sync — 63 generated files match prisma/schema.prisma (working-tree)')
    expect(result.status).toBe(0)
  }, 60_000)
})
