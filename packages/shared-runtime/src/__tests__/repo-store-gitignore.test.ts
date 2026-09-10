// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A workspace that reaches the git layer without a `.gitignore` must not get
 * its node_modules committed, and a repo that already tracks node_modules
 * (desktop projects seeded by builds up to 1.14.x) must be repaired in place.
 * Runs against real temp git repos.
 */
import { describe, expect, test, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// repo-store imports the S3 client at module load; keep it out of this test.
mock.module('@aws-sdk/client-s3', () => ({
  S3Client: class { async send() { throw new Error('unused') } },
  GetObjectCommand: class { constructor(public input: any) {} },
  PutObjectCommand: class { constructor(public input: any) {} },
  HeadObjectCommand: class { constructor(public input: any) {} },
}))

const { seedRepoIfAbsent, untrackDependencyDirs, ensureWorkspaceGitignore } = await import('../repo-store')

const quiet = { log: () => {}, warn: () => {}, error: () => {} }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-repo-gi-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'index.ts'), 'export {}\n')
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  mkdirSync(join(dir, 'dist'))
  writeFileSync(join(dir, 'dist', 'bundle.js'), '1\n')
  return dir
}

describe('seedRepoIfAbsent without a .gitignore', () => {
  test('writes the default ignore file and leaves node_modules/dist out of the seed commit', async () => {
    const dir = makeWorkspace()
    try {
      expect(existsSync(join(dir, '.gitignore'))).toBe(false)
      const sha = await seedRepoIfAbsent(dir, { logger: quiet })
      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      expect(existsSync(join(dir, '.gitignore'))).toBe(true)
      const tracked = git(dir, 'ls-files').split('\n')
      expect(tracked).toContain('package.json')
      expect(tracked).toContain('src/index.ts')
      expect(tracked).toContain('.gitignore')
      expect(tracked.some((f) => f.startsWith('node_modules/'))).toBe(false)
      expect(tracked.some((f) => f.startsWith('dist/'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('respects an existing .gitignore instead of overwriting it', async () => {
    const dir = makeWorkspace()
    try {
      writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
      expect(ensureWorkspaceGitignore(dir)).toBe(false)
      await seedRepoIfAbsent(dir, { logger: quiet })
      const tracked = git(dir, 'ls-files').split('\n')
      // dist is NOT ignored by the user's file, so it stays tracked.
      expect(tracked).toContain('dist/bundle.js')
      expect(tracked.some((f) => f.startsWith('node_modules/'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('untrackDependencyDirs', () => {
  test('is a no-op on a healthy repo', async () => {
    const dir = makeWorkspace()
    try {
      await seedRepoIfAbsent(dir, { logger: quiet })
      const before = git(dir, 'rev-parse', 'HEAD')
      expect(await untrackDependencyDirs(dir, { logger: quiet })).toEqual([])
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('drops committed node_modules/dist from the index, keeps files on disk, and commits', async () => {
    const dir = makeWorkspace()
    try {
      // Reproduce the 1.14.x state: seeded with no ignore file at all.
      git(dir, 'init', '-b', 'main')
      git(dir, 'config', 'user.name', 't')
      git(dir, 'config', 'user.email', 't@t')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'seed', '--no-verify')
      expect(git(dir, 'ls-files', '--', 'node_modules')).not.toBe('')

      const untracked = await untrackDependencyDirs(dir, { logger: quiet })
      expect(untracked.sort()).toEqual(['dist', 'node_modules'])
      expect(git(dir, 'ls-files', '--', 'node_modules')).toBe('')
      expect(git(dir, 'ls-files', '--', 'dist')).toBe('')
      expect(git(dir, 'ls-files')).toContain('.gitignore')
      expect(existsSync(join(dir, 'node_modules', 'left-pad', 'index.js'))).toBe(true)
      expect(git(dir, 'status', '--porcelain')).toBe('')
      expect(git(dir, 'log', '--oneline')).toContain('stop tracking')
      // Second pass finds nothing to do.
      expect(await untrackDependencyDirs(dir, { logger: quiet })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns [] when the workspace is not a git repo', async () => {
    const dir = makeWorkspace()
    try {
      expect(await untrackDependencyDirs(dir, { logger: quiet })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
