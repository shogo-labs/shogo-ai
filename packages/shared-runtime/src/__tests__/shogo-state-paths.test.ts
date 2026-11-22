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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  buildShogoExcludeBlock,
  buildShogoGitHubExcludeBlock,
  ensureShogoGitHubExcludes,
  isShogoRuntimeSubtree,
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
      // SHO-139: exec's cwd markers live here now.
      '.shogo/exec-cwd/.shogo-cwd-1234-abc',
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
  test('never stages a .env* secret, and still commits the templates (SHO-384)', () => {
    const dir = tmpRepo()
    ensureShogoExcludes(dir, quiet)
    for (const name of ['.env', '.env.local', '.env.production', '.env.development', '.env.staging', '.env.test']) {
      writeFileSync(join(dir, name), 'TOKEN=secret\n')
    }
    for (const name of ['.env.example', '.env.sample', '.env.template', '.env.production.example']) {
      writeFileSync(join(dir, name), 'TOKEN=replace-me\n')
    }

    git(dir, 'add', '-A')
    const staged = git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort()

    // The secrets rule and the ignore list are one list now: a name the store
    // would carry must not be stageable, or `git add -A` puts the tokens in the
    // durable repo the next cold boot rebuilds from.
    expect(staged).toEqual(['.env.example', '.env.production.example', '.env.sample', '.env.template'])
  })

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
      // Stamp the fresh lock from the clock the eviction reads: an unstamped
      // file carries the OS clock, which reads as `offset` older than a shifted
      // clock, so the "fresh" lock would be evicted as stale.
      utimesSync(lock, new Date(), new Date())
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

describe('one exclude list for every git path (SHO-371)', () => {
  test('the GitHub block excludes all of .shogo, including memory history and the child ledger', () => {
    const block = buildShogoGitHubExcludeBlock()
    expect(block).toContain('.shogo/*')
    expect(block).not.toContain('!.shogo/memory-history/')
    expect(block).toContain('.tech-stack')
    expect(block).toContain('prisma/dev.db')
    // `.shogo/run/children.json` is covered by `.shogo/*` — the old hand-kept
    // list had no `.shogo/run/` and pushed it into users' repositories.
    expect(isShogoRuntimeState('.shogo/run/children.json')).toBe(true)
  })

  test('both managed blocks coexist in .git/info/exclude without clobbering each other', () => {
    const dir = tmpRepo()
    try {
      writeFileSync(join(dir, '.git', 'info', 'exclude'), '# mine\n*.log\n')
      expect(ensureShogoExcludes(dir, quiet)).toBe(true)
      expect(ensureShogoGitHubExcludes(dir, quiet)).toBe(true)
      // Idempotent: a second pass changes nothing.
      expect(ensureShogoExcludes(dir, quiet)).toBe(false)
      expect(ensureShogoGitHubExcludes(dir, quiet)).toBe(false)

      const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
      expect(exclude).toContain('*.log')
      expect(exclude).toContain('shogo checkpoint excludes')
      expect(exclude).toContain('shogo github excludes')
      expect(exclude.match(/shogo checkpoint excludes \(managed\) >>>/g)).toHaveLength(1)
      expect(exclude.match(/shogo github excludes \(managed\) >>>/g)).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a GitHub-connected repo never stages .shogo/memory-history, even after a checkpoint turn', async () => {
    const dir = tmpRepo()
    try {
      // GitHub connect writes its block first; a checkpoint turn then writes the
      // checkpoint block into the same exclude file.
      ensureShogoGitHubExcludes(dir, quiet)
      ensureShogoExcludes(dir, quiet)

      const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
      expect(exclude).toContain('shogo github excludes')
      expect(exclude).not.toContain('!.shogo/memory-history/')

      mkdirSync(join(dir, '.shogo', 'memory-history'), { recursive: true })
      mkdirSync(join(dir, '.shogo', 'run'), { recursive: true })
      writeFileSync(join(dir, '.shogo', 'memory-history', '2026-11-17.md'), 'memory\n')
      writeFileSync(join(dir, '.shogo', 'run', 'children.json'), '{}\n')
      writeFileSync(join(dir, 'AGENTS.md'), 'user source\n')

      await untrackShogoStatePaths(dir, { logger: quiet })
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' })

      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: dir,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)
      expect(staged.filter((p) => p.startsWith('.shogo/'))).toEqual([])
      expect(staged).toContain('AGENTS.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a checkpoint repo still tracks .shogo/memory-history', async () => {
    const dir = tmpRepo()
    try {
      ensureShogoExcludes(dir, quiet)
      mkdirSync(join(dir, '.shogo', 'memory-history'), { recursive: true })
      writeFileSync(join(dir, '.shogo', 'memory-history', 'x.md'), 'memory\n')

      await untrackShogoStatePaths(dir, { logger: quiet })
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' })

      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: dir,
        encoding: 'utf8',
      })
      expect(staged).toContain('.shogo/memory-history/x.md')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('isShogoRuntimeSubtree keeps the user\'s own .shogo content', () => {
    expect(isShogoRuntimeSubtree('.shogo/run/children.json')).toBe(true)
    expect(isShogoRuntimeSubtree('.shogo/logs/build.log')).toBe(true)
    expect(isShogoRuntimeSubtree('.shogo/sessions.db')).toBe(true)
    expect(isShogoRuntimeSubtree('.tmp/x')).toBe(true)
    expect(isShogoRuntimeSubtree('.shogo/skills/review/SKILL.md')).toBe(false)
    expect(isShogoRuntimeSubtree('.shogo/agents/dev.md')).toBe(false)
    expect(isShogoRuntimeSubtree('.shogo/memory-history/x.md')).toBe(false)
    expect(isShogoRuntimeSubtree('prisma/dev.db')).toBe(false)
  })
})
