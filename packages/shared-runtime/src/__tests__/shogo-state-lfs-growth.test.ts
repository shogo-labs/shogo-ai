// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-105 / #1597 — the growth stop, against real git.
 *
 * `.git/lfs` grew 4–7 GB/hour because `autoTrackLargeFiles` LFS-tracked
 * `.shogo/sessions.db-wal` and every per-turn `git add -A` then wrote a brand-new
 * uncompressed object for it. These tests assert the two properties that stop
 * that: the LFS auto-tracker never picks runtime state, and two consecutive
 * `GitWorkspaceSync` turns with no source change write no new LFS object.
 */
import { describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { GitWorkspaceSync } from '../git-sync'
import { autoTrackLargeFiles, lfsBudgetBytes, lfsOverBudget, pruneLfsBudget } from '../lfs'
import { classifyLargeFiles } from '../large-file-sync'
import { directorySizeBytes, ensureShogoExcludes, prepareCheckpointRepo } from '../shogo-state-paths'

const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const MB = 1024 * 1024

function hasLfs(): boolean {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const LFS = hasLfs()

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function initRepo(withLfs = true, attributes?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shogo-lfs-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  git(dir, 'config', 'user.name', 'Shogo Agent')
  git(dir, 'config', 'user.email', 'agent@shogo.ai')
  git(dir, 'config', 'commit.gpgsign', 'false')
  if (withLfs) {
    execFileSync('git', ['lfs', 'install', '--local', '--skip-smudge'], { cwd: dir, stdio: 'pipe' })
  }
  if (attributes) writeFileSync(join(dir, '.gitattributes'), attributes)
  return dir
}

/** Number of files in `.git/lfs/objects` — one per distinct LFS version. */
function lfsObjectCount(dir: string): number {
  let count = 0
  const walk = (d: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(d, entry.name))
      else if (entry.isFile()) count += 1
    }
  }
  walk(join(dir, '.git', 'lfs', 'objects'))
  return count
}



/** Real `spawnGit` for `GitWorkspaceSync` — the default is module-private. */
const realSpawnGit = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
  Promise.resolve().then(() => {
    try {
      const stdout = execFileSync('git', args, {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { exitCode: 0, stdout, stderr: '' }
    } catch (err: any) {
      return {
        exitCode: typeof err?.status === 'number' ? err.status : 1,
        stdout: String(err?.stdout ?? ''),
        stderr: String(err?.stderr ?? err?.message ?? ''),
      }
    }
  })

describe('large-file classification and the LFS auto-tracker', () => {
  test('classifyLargeFiles never walks .shogo or .tmp', () => {
    const dir = initRepo(false)
    try {
      mkdirSync(join(dir, '.shogo'), { recursive: true })
      mkdirSync(join(dir, '.tmp'), { recursive: true })
      mkdirSync(join(dir, 'assets'), { recursive: true })
      writeFileSync(join(dir, '.shogo', 'sessions.db'), 'x'.repeat(6 * MB))
      writeFileSync(join(dir, '.tmp', 'dump.bin'), 'x'.repeat(6 * MB))
      writeFileSync(join(dir, 'assets', 'big.bin'), 'x'.repeat(6 * MB))
      const found = classifyLargeFiles(dir, 5 * MB).map((p) => p.split('\\').join('/'))
      expect(found).toEqual(['assets/big.bin'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!LFS)(
    'AC 3 — tracks a 6 MB assets/big.bin but never .shogo/*, *.db*, .tmp/** or a git-ignored path',
    async () => {
      const dir = initRepo(true)
      try {
        mkdirSync(join(dir, '.shogo'), { recursive: true })
        mkdirSync(join(dir, '.tmp'), { recursive: true })
        mkdirSync(join(dir, 'assets'), { recursive: true })
        mkdirSync(join(dir, 'ignored'), { recursive: true })
        writeFileSync(join(dir, '.shogo', 'sessions.db'), 'x'.repeat(6 * MB))
        writeFileSync(join(dir, '.shogo', 'sessions.db-wal'), 'x'.repeat(6 * MB))
        writeFileSync(join(dir, '.tmp', 'dump.bin'), 'x'.repeat(6 * MB))
        writeFileSync(join(dir, 'ignored', 'cached.bin'), 'x'.repeat(6 * MB))
        writeFileSync(join(dir, 'assets', 'big.bin'), 'x'.repeat(6 * MB))
        writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
        ensureShogoExcludes(dir, quiet)

        const tracked = await autoTrackLargeFiles(dir, 5 * MB, { logger: quiet })
        expect(tracked).toBe(1)
        const attributes = readFileSync(join(dir, '.gitattributes'), 'utf-8')
        expect(attributes).toContain('assets/big.bin filter=lfs')
        expect(attributes).not.toContain('.shogo/sessions.db')
        expect(attributes).not.toContain('.tmp/dump.bin')
        expect(attributes).not.toContain('ignored/cached.bin')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

describe('GitWorkspaceSync against a real repo', () => {
  test.skipIf(!LFS)(
    'AC 2 — two turns with no source change write no new LFS object for .shogo/*',
    async () => {
      const dir = initRepo(
        true,
        '.shogo/sessions.db filter=lfs diff=lfs merge=lfs -text\n' +
          '.shogo/sessions.db-wal filter=lfs diff=lfs merge=lfs -text\n'
      )
      try {
        mkdirSync(join(dir, '.shogo'), { recursive: true })
        writeFileSync(join(dir, 'index.ts'), 'export {}\n')
        writeFileSync(join(dir, '.shogo', 'sessions.db'), 'x'.repeat(6 * MB))
        writeFileSync(join(dir, '.shogo', 'sessions.db-wal'), 'x'.repeat(6 * MB))
        // A repo seeded before the fix: no excludes yet, so the live DB is
        // tracked and LFS-stored exactly like the reported 165 GB install.
        git(dir, 'add', '-A')
        execFileSync('git', ['commit', '-q', '-m', 'seed with runtime state', '--no-verify'], {
          cwd: dir,
          stdio: 'pipe',
        })
        expect(lfsObjectCount(dir)).toBeGreaterThan(0)

        const turn = async () => {
          const sync = new GitWorkspaceSync({
            workspaceDir: dir,
            cloudApiUrl: 'http://localhost:1',
            runtimeAuthSecret: 'test',
            projectId: 'p',
            localOnly: true,
            afterCommit: () => {},
            beforeStage: async () => {
              await autoTrackLargeFiles(dir, 5 * MB, { logger: quiet })
            },
            logger: quiet,
            spawnGit: realSpawnGit,
          })
          await sync.flushAndShutdown()
        }

        await turn()
        const objectsAfterFirst = lfsObjectCount(dir)
        const lfsBytesAfterFirst = directorySizeBytes(join(dir, '.git', 'lfs'))
        expect(existsSync(join(dir, '.git', 'lfs', 'objects'))).toBe(true)
        // The tracked runtime state has been dropped from the index.
        expect(git(dir, 'ls-files', '--', '.shogo')).toBe('')
        expect(existsSync(join(dir, '.shogo', 'sessions.db'))).toBe(true)

        // Touch the live DB exactly as the runtime does between turns: the WAL
        // grows, the file's mtime moves. No new LFS object may appear.
        appendFileSync(join(dir, '.shogo', 'sessions.db-wal'), 'more wal')
        await turn()

        expect(lfsObjectCount(dir)).toBe(objectsAfterFirst)
        expect(directorySizeBytes(join(dir, '.git', 'lfs'))).toBe(lfsBytesAfterFirst)
        expect(readFileSync(join(dir, '.shogo', 'sessions.db-wal'), 'utf-8')).toContain('more wal')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  test('AC 5 — a stale .git/index.lock no longer wedges a sync; a fresh one is left alone', async () => {
    const dir = initRepo(false)
    try {
      writeFileSync(join(dir, 'index.ts'), 'export {}\n')
      ensureShogoExcludes(dir, quiet)
      git(dir, 'add', '-A')
      execFileSync('git', ['commit', '-q', '-m', 'seed', '--no-verify'], { cwd: dir, stdio: 'pipe' })

      const lock = join(dir, '.git', 'index.lock')
      writeFileSync(lock, '')
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)

      const committed: string[] = []
      const turn = async () => {
        const sync = new GitWorkspaceSync({
          workspaceDir: dir,
          cloudApiUrl: 'http://localhost:1',
          runtimeAuthSecret: 'test',
          projectId: 'p',
          localOnly: true,
          degradeAfterFailures: 0,
          logger: quiet,
          spawnGit: realSpawnGit,
          afterCommit: (sha) => {
            committed.push(sha)
          },
        })
        await sync.flushAndShutdown()
      }

      writeFileSync(join(dir, 'index.ts'), 'export const changed = true\n')
      await turn()
      // The stale lock was evicted, the change was committed.
      expect(existsSync(lock)).toBe(false)
      expect(committed.length).toBe(1)
      expect(git(dir, 'log', '--oneline', '-1')).toContain('auto:')

      // A fresh lock belongs to a live git process — left in place, and the
      // failed stage routes through the retry path instead of deleting it.
      writeFileSync(lock, '')
      writeFileSync(join(dir, 'index.ts'), 'export const changed = 2\n')
      await turn()
      expect(existsSync(lock)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('local LFS budget', () => {
  test('defaults to 4 GB and honours SHOGO_LFS_BUDGET_GB', () => {
    expect(lfsBudgetBytes({})).toBe(4 * 1024 * MB)
    expect(lfsBudgetBytes({ SHOGO_LFS_BUDGET_GB: '0.5' })).toBe(512 * MB)
    expect(lfsBudgetBytes({ SHOGO_LFS_BUDGET_GB: 'nonsense' })).toBe(4 * 1024 * MB)
  })

  test('a repo under budget is not over it, and an over-budget repo reports so', async () => {
    const dir = initRepo(false)
    try {
      writeFileSync(join(dir, 'a.txt'), 'a')
      git(dir, 'add', '-A')
      execFileSync('git', ['commit', '-q', '-m', 'a', '--no-verify'], { cwd: dir, stdio: 'pipe' })
      mkdirSync(join(dir, '.git', 'lfs', 'objects', 'aa', 'bb'), { recursive: true })
      writeFileSync(join(dir, '.git', 'lfs', 'objects', 'aa', 'bb', 'x'), 'x'.repeat(2048))

      expect(lfsOverBudget(dir, { env: { SHOGO_LFS_BUDGET_GB: '1' }, logger: quiet })).toBe(false)
      expect(
        lfsOverBudget(dir, { env: { SHOGO_LFS_BUDGET_GB: '0.000001' }, logger: quiet })
      ).toBe(true)
      // Pruning a repo with no lfs binary is a no-op, not a crash.
      expect(typeof (await pruneLfsBudget(dir, quiet))).toBe('boolean')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('over budget: autoTrackLargeFiles tracks nothing new', async () => {
    const dir = initRepo(false)
    try {
      mkdirSync(join(dir, 'assets'), { recursive: true })
      writeFileSync(join(dir, 'assets', 'big.bin'), 'x'.repeat(2 * MB))
      mkdirSync(join(dir, '.git', 'lfs', 'objects', 'aa', 'bb'), { recursive: true })
      writeFileSync(join(dir, '.git', 'lfs', 'objects', 'aa', 'bb', 'x'), 'x'.repeat(4096))
      process.env.SHOGO_LFS_BUDGET_GB = '0.000001'
      try {
        expect(await autoTrackLargeFiles(dir, 1 * MB, { logger: quiet })).toBe(0)
      } finally {
        delete process.env.SHOGO_LFS_BUDGET_GB
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('prepareCheckpointRepo', () => {
  test('AC 1 — one bootstrap untracks runtime state, keeps files, is idempotent', async () => {
    const dir = initRepo(false)
    try {
      mkdirSync(join(dir, '.shogo', 'logs'), { recursive: true })
      mkdirSync(join(dir, '.shogo', 'tasks'), { recursive: true })
      mkdirSync(join(dir, '.shogo', 'memory-history'), { recursive: true })
      writeFileSync(join(dir, 'src.ts'), 'export {}\n')
      writeFileSync(join(dir, '.shogo', 'sessions.db'), 'db')
      writeFileSync(join(dir, '.shogo', 'sessions.db-wal'), 'wal')
      writeFileSync(join(dir, '.shogo', 'sessions.db-shm'), 'shm')
      writeFileSync(join(dir, '.shogo', 'logs', 'console.log'), 'log')
      writeFileSync(join(dir, '.shogo', 'tasks', 't_1.log'), 'task')
      writeFileSync(join(dir, '.shogo', 'memory-history', 'm.md'), 'memory')
      git(dir, 'add', '-A')
      execFileSync('git', ['commit', '-q', '-m', 'seed', '--no-verify'], { cwd: dir, stdio: 'pipe' })

      expect(await prepareCheckpointRepo(dir, { logger: quiet })).toBe(5)
      expect(git(dir, 'ls-files', '--', '.shogo')).toBe('.shogo/memory-history/m.md')
      for (const rel of ['sessions.db', 'sessions.db-wal', 'sessions.db-shm']) {
        expect(existsSync(join(dir, '.shogo', rel))).toBe(true)
      }
      const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf-8')
      expect(exclude).toContain('>>> shogo checkpoint excludes (managed) >>>')
      expect(await prepareCheckpointRepo(dir, { logger: quiet })).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
