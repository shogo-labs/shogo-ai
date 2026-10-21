// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-105 / #1597 — a checkpoint repo must never track, LFS-store or keep in
 * history Shogo's own runtime state (`.shogo/sessions.db` + its live WAL, logs,
 * `.tmp/`, `.shogo-cwd-*`), while `.shogo/memory-history/**` stays tracked.
 *
 * Every test runs against a real temp git repo: the bugs here are all
 * "git does something surprising", so a mock would prove nothing.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  buildShogoExcludeBlock,
  stripShogoLfsRules,
  directorySizeBytes,
  ensureShogoExcludes,
  evictStaleGitLock,
  isShogoRuntimeState,
  resolveGitDir,
  untrackShogoStatePaths,
} from '../shogo-state-paths'

const quiet = { log: () => {}, warn: () => {}, error: () => {} }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tmpRepo(name = 'shogo-state-'): string {
  const dir = mkdtempSync(join(tmpdir(), name))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  git(dir, 'config', 'user.name', 'Shogo Agent')
  git(dir, 'config', 'user.email', 'agent@shogo.ai')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function commitAll(dir: string, message = 'commit'): string {
  git(dir, 'add', '-A')
  execFileSync('git', ['commit', '-q', '-m', message, '--no-verify'], { cwd: dir, stdio: 'pipe' })
  return git(dir, 'rev-parse', 'HEAD')
}

describe('isShogoRuntimeState', () => {
  test('runtime state under .shogo, .tmp and the root cwd scratch files', () => {
    for (const rel of [
      '.shogo/sessions.db',
      '.shogo/sessions.db-wal',
      '.shogo/sessions.db-shm',
      '.shogo/index.db',
      '.shogo/logs/console.log',
      '.shogo/tasks/t_abc.log',
      '.shogo/plans/a.plan.md',
      '.shogo-cwd-1234',
      '.tmp/screenshot.png',
      'prisma/dev.db',
      'data/sessions.db-journal',
    ]) {
      expect(isShogoRuntimeState(rel)).toBe(true)
    }
  })

  test('source, agent memory and everything else are not runtime state', () => {
    for (const rel of [
      'src/App.tsx',
      'package.json',
      '.shogo/memory-history/2026-10-21.md',
      '.shogo/memory-history/nested/deep.md',
      'docs/database.md',
      'README.md',
    ]) {
      expect(isShogoRuntimeState(rel)).toBe(false)
    }
  })

  test('windows separators are normalized', () => {
    expect(isShogoRuntimeState('.shogo\\sessions.db')).toBe(true)
    expect(isShogoRuntimeState('.shogo\\memory-history\\x.md')).toBe(false)
  })
})

describe('ensureShogoExcludes', () => {
  test('writes the managed block into .git/info/exclude and is idempotent', () => {
    const dir = tmpRepo()
    try {
      expect(ensureShogoExcludes(dir, quiet)).toBe(true)
      const excludePath = join(dir, '.git', 'info', 'exclude')
      const first = execFileSync('cat', [excludePath], { encoding: 'utf8' })
      expect(first).toContain(buildShogoExcludeBlock())
      // Second call must not rewrite the file.
      expect(ensureShogoExcludes(dir, quiet)).toBe(false)
      expect(execFileSync('cat', [excludePath], { encoding: 'utf8' })).toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('covers a repo with no .gitignore and preserves a user edit to it', () => {
    const dir = tmpRepo()
    try {
      writeFileSync(join(dir, '.gitignore'), 'custom-entry\n')
      ensureShogoExcludes(dir, quiet)
      writeFileSync(join(dir, 'sessions.db'), 'x')
      // The exclude file wins even though `.gitignore` says nothing about it.
      expect(() =>
        execFileSync('git', ['check-ignore', '-q', '--', 'sessions.db'], { cwd: dir, stdio: 'pipe' })
      ).not.toThrow()
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })).toBe(
        '?? .gitignore\n'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('untrackShogoStatePaths', () => {
  test('drops tracked runtime state from the index, keeps files and memory-history', async () => {
    const dir = tmpRepo()
    try {
      mkdirSync(join(dir, '.shogo', 'memory-history'), { recursive: true })
      mkdirSync(join(dir, '.shogo', 'logs'), { recursive: true })
      mkdirSync(join(dir, '.shogo', 'tasks'), { recursive: true })
      mkdirSync(join(dir, '.tmp'), { recursive: true })
      writeFileSync(join(dir, 'src.txt'), 'real source\n')
      writeFileSync(join(dir, '.shogo', 'sessions.db'), 'sqlite-ish\n')
      writeFileSync(join(dir, '.shogo', 'sessions.db-wal'), 'wal\n')
      writeFileSync(join(dir, '.shogo', 'sessions.db-shm'), 'shm\n')
      writeFileSync(join(dir, '.shogo', 'logs', 'console.log'), 'log\n')
      writeFileSync(join(dir, '.shogo', 'tasks', 't_1.log'), 'task\n')
      writeFileSync(join(dir, '.shogo', 'memory-history', 'x.md'), 'keep me\n')
      writeFileSync(join(dir, '.tmp', 'shot.png'), 'png\n')
      writeFileSync(join(dir, '.shogo-cwd-abc'), '/somewhere\n')
      commitAll(dir, 'seed: sweep everything')

      const first = await untrackShogoStatePaths(dir, { logger: quiet })
      expect(first.removed).toBe(7)
      expect(await untrackShogoStatePaths(dir, { logger: quiet })).toEqual({ removed: 0, paths: [] })

      // Only agent memory survives under `.shogo/`.
      expect(git(dir, 'ls-files', '--', '.shogo')).toBe('.shogo/memory-history/x.md')
      expect(git(dir, 'ls-files')).toContain('src.txt')
      // Nothing was deleted from disk.
      expect(existsSync(join(dir, '.shogo', 'sessions.db'))).toBe(true)
      expect(existsSync(join(dir, '.shogo', 'sessions.db-shm'))).toBe(true)
      expect(existsSync(join(dir, '.tmp', 'shot.png'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('stripShogoLfsRules', () => {
  test('removes LFS rules for runtime state and keeps every other rule', () => {
    const dir = tmpRepo()
    try {
      const attrs = [
        '.shogo/sessions.db filter=lfs diff=lfs merge=lfs -text',
        '.shogo/sessions.db-wal filter=lfs diff=lfs merge=lfs -text',
        '.tmp/dump.bin filter=lfs diff=lfs merge=lfs -text',
        '# >>> shogo git-lfs (managed) >>>',
        '*.png filter=lfs diff=lfs merge=lfs -text',
        '.shogo/memory-history/*.md filter=lfs diff=lfs merge=lfs -text',
        '# <<< shogo git-lfs (managed) <<<',
        '',
      ].join('\n')
      writeFileSync(join(dir, '.gitattributes'), attrs)
      expect(stripShogoLfsRules(dir, quiet)).toBe(true)
      const after = execFileSync('cat', [join(dir, '.gitattributes')], { encoding: 'utf8' })
      expect(after).not.toContain('.shogo/sessions.db')
      expect(after).not.toContain('.tmp/dump.bin')
      expect(after).toContain('*.png filter=lfs')
      expect(after).toContain('.shogo/memory-history/*.md filter=lfs')
      // Idempotent.
      expect(stripShogoLfsRules(dir, quiet)).toBe(false)
      // No file at all is not an error.
      expect(stripShogoLfsRules(join(dir, 'nope'), quiet)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('evictStaleGitLock', () => {
  test('removes a lock older than the threshold and leaves a fresh one', () => {
    const dir = tmpRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'a')
      commitAll(dir)
      const lock = join(dir, '.git', 'index.lock')
      writeFileSync(lock, '')
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)
      expect(evictStaleGitLock(dir, 5_000, quiet)).toBe(true)
      expect(existsSync(lock)).toBe(false)

      writeFileSync(lock, '')
      expect(evictStaleGitLock(dir, 5_000, quiet)).toBe(false)
      expect(existsSync(lock)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('recovers a stale repair lock too', () => {
    const dir = tmpRepo()
    try {
      mkdirSync(join(dir, '.git', 'shogo'), { recursive: true })
      const lock = join(dir, '.git', 'shogo-repair.lock')
      writeFileSync(lock, '1234')
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)
      expect(evictStaleGitLock(dir, 5_000, quiet)).toBe(true)
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('git dir resolution', () => {
  test('a plain .git directory and a worktree .git file both resolve', () => {
    const dir = tmpRepo()
    try {
      expect(resolveGitDir(dir)).toBe(join(dir, '.git'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('directorySizeBytes walks a tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shogo-size-'))
    try {
      mkdirSync(join(dir, 'a', 'b'), { recursive: true })
      writeFileSync(join(dir, 'a', 'b', 'x'), 'x'.repeat(1000))
      expect(directorySizeBytes(dir)).toBe(1000)
      expect(statSync(join(dir, 'a', 'b', 'x')).size).toBe(1000)
      expect(directorySizeBytes(join(dir, 'missing'))).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
