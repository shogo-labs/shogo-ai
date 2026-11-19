// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Heal an UNTRUSTED workspace (SHO-442).
 *
 * The incident's workspace could not prove its `.git` descended from the
 * durable repo, so it saved nothing for a day and a half. The bytes were all
 * there; what was missing was a commit tying the live tree to the durable
 * history. These tests run the real thing against real repos:
 *   - the healed HEAD carries BOTH parents,
 *   - its tree is the live working tree, uncommitted edits included,
 *   - no working-tree file is rewritten and `git status` is clean afterwards,
 *   - the transport refs are gone (they would otherwise land in the manifest).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { reconcileRepoHistory } from '../repo-reconcile'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shogo-reconcile-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim()
}

/** A repo with the given files committed, returning its HEAD. */
function repo(name: string, files: Record<string, string>, message = 'commit'): string {
  const path = join(dir, name)
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  write(path, files)
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', message)
  return git(path, 'rev-parse', 'HEAD')
}

function write(path: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(path, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
}

describe('reconcileRepoHistory', () => {
  test('joins the durable and live histories with a commit whose tree is the live one', async () => {
    const durable = repo('durable', { 'src/App.tsx': 'durable version\n', 'README.md': 'readme\n' }, 'durable v1')
    const workspace = join(dir, 'live')
    mkdirSync(workspace, { recursive: true })
    git(workspace, 'init', '-q', '-b', 'main')
    write(workspace, { 'src/App.tsx': 'live version\n', 'notes.md': 'only here\n' })
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-q', '-m', 'live v1')
    const localHead = git(workspace, 'rev-parse', 'HEAD')

    // Work the user has not committed yet.
    write(workspace, { 'notes.md': 'edited but not committed\n' })

    const result = await reconcileRepoHistory(workspace, join(dir, 'durable'))

    expect(result.durableHead).toBe(durable)
    expect(result.localHead).toBe(localHead)
    expect(result.head).toBe(git(workspace, 'rev-parse', 'HEAD'))
    expect(git(workspace, 'rev-list', '--parents', '-n', '1', 'HEAD')).toBe(`${result.head} ${durable} ${localHead}`)

    // The tree is the working tree as it stood, uncommitted edit included.
    expect(git(workspace, 'show', `${result.head}:notes.md`)).toBe('edited but not committed')
    expect(git(workspace, 'show', `${result.head}:src/App.tsx`)).toBe('live version')

    // No file was rewritten, and the next commit is a no-op.
    expect(git(workspace, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('edited but not committed\n')
  })

  test('descends from the durable history, so a later save cannot be refused as diverged', async () => {
    const durable = repo('durable', { 'src/App.tsx': 'durable version\n' })
    const workspace = join(dir, 'live')
    mkdirSync(workspace, { recursive: true })
    git(workspace, 'init', '-q', '-b', 'main')
    write(workspace, { 'src/App.tsx': 'live version\n' })
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-q', '-m', 'live v1')

    const { head } = await reconcileRepoHistory(workspace, join(dir, 'durable'))

    expect(git(workspace, 'merge-base', '--is-ancestor', durable, head)).toBe('')
    expect(execFileSync('git', ['rev-list', '--count', head], { cwd: workspace, encoding: 'utf8' }).trim()).toBe('3')
  })

  test('an unborn live branch still adopts the durable history', async () => {
    const durable = repo('durable', { 'src/App.tsx': 'durable version\n' })
    const workspace = join(dir, 'live')
    mkdirSync(workspace, { recursive: true })
    git(workspace, 'init', '-q', '-b', 'main')
    // A working tree with no commits at all.
    write(workspace, { 'src/App.tsx': 'the template\n' })

    const result = await reconcileRepoHistory(workspace, join(dir, 'durable'))

    expect(result.localHead).toBeNull()
    expect(git(workspace, 'rev-list', '--parents', '-n', '1', 'HEAD')).toBe(`${result.head} ${durable}`)
    expect(git(workspace, 'show', `${result.head}:src/App.tsx`)).toBe('the template')
    expect(git(workspace, 'status', '--porcelain')).toBe('')
  })

  test('the transport refs do not survive, or they would land in the next manifest', async () => {
    repo('durable', { 'src/App.tsx': 'durable version\n' })
    const workspace = join(dir, 'live')
    mkdirSync(workspace, { recursive: true })
    git(workspace, 'init', '-q', '-b', 'main')
    write(workspace, { 'src/App.tsx': 'live version\n' })
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-q', '-m', 'live v1')

    await reconcileRepoHistory(workspace, join(dir, 'durable'))

    expect(git(workspace, 'for-each-ref', '--format=%(refname)', 'refs/shogo-durable/')).toBe('')
    expect(git(workspace, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main')
  })

  test('a workspace with no .git is refused rather than guessed at', async () => {
    repo('durable', { 'a.txt': 'a\n' })
    const empty = join(dir, 'empty')
    mkdirSync(empty, { recursive: true })

    await expect(reconcileRepoHistory(empty, join(dir, 'durable'))).rejects.toThrow(/no \.git/)
  })

  test('a staging dir that is not a repo is refused', async () => {
    const workspace = repo('live', { 'a.txt': 'a\n' })
    expect(workspace).toBeTruthy()
    const notARepo = join(dir, 'staging')
    mkdirSync(notARepo, { recursive: true })

    await expect(reconcileRepoHistory(join(dir, 'live'), notARepo)).rejects.toThrow(/no \.git/)
  })

  test('a failed merge leaves the live history untouched', async () => {
    repo('durable', { 'a.txt': 'a\n' })
    const workspace = join(dir, 'live')
    mkdirSync(workspace, { recursive: true })
    git(workspace, 'init', '-q', '-b', 'main')
    write(workspace, { 'a.txt': 'live\n' })
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-q', '-m', 'live v1')
    const before = git(workspace, 'rev-parse', 'HEAD')

    await expect(reconcileRepoHistory(workspace, join(dir, 'missing'))).rejects.toThrow()
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(before)
    expect(existsSync(join(workspace, 'a.txt'))).toBe(true)
  })
})
