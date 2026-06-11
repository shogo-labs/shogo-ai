// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the per-chat WorktreeManager (BETA: git worktrees per chat).
 *
 * These exercise the real `git` binary against a throwaway repo on disk —
 * the worktree lifecycle and merge logic are deterministic git plumbing, so
 * spawning git is the most faithful (and only meaningful) way to verify them.
 * Covers: create/re-attach, status, clean merge + fast-forward to main,
 * cold-start recreation from surviving branches, and the conflict ->
 * agent-resolves -> complete-merge path (the regression that motivated the
 * unresolvedConflictFiles() marker scan).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { WorktreeManager } from '../git-worktree'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@shogo.ai',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@shogo.ai',
    },
  })
}

let root: string
let repo: string
let mgr: WorktreeManager

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-test-'))
  repo = join(root, 'workspace')
  execFileSync('mkdir', ['-p', repo])
  git(repo, ['init', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  writeFileSync(join(repo, 'foo.txt'), 'base\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'init'])
  mgr = new WorktreeManager({ mainRepoDir: repo })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('WorktreeManager', () => {
  test('ensureWorktree creates a branch + working dir off the default branch', async () => {
    const a = await mgr.ensureWorktree('chatA')
    expect(existsSync(a.path)).toBe(true)
    expect(a.branch).toBe('shogo/chat/chatA')
    expect(await mgr.getDefaultBranch()).toBe('main')
    // Idempotent (git reports the realpath, which on macOS resolves the
    // /var -> /private/var symlink, so compare via realpath).
    const again = await mgr.ensureWorktree('chatA')
    const { realpathSync } = await import('fs')
    expect(realpathSync(again.path)).toBe(realpathSync(a.path))
  })

  test('status reports ahead count and changed files vs main', async () => {
    const a = await mgr.ensureWorktree('chatA')
    writeFileSync(join(a.path, 'new-a.txt'), 'hello\n')
    await mgr.commitWorktree('chatA', 'A: add file')
    const s = await mgr.status('chatA')
    expect(s?.ahead).toBe(1)
    expect(s?.changedFiles).toContain('new-a.txt')
  })

  test('clean merge fast-forwards main to the branch tip', async () => {
    const a = await mgr.ensureWorktree('chatA')
    writeFileSync(join(a.path, 'new-a.txt'), 'hello\n')
    await mgr.commitWorktree('chatA', 'A: add file')
    const m = await mgr.mergeBranchIntoMain('chatA')
    expect(m.outcome).toBe('clean')
    expect(existsSync(join(repo, 'new-a.txt'))).toBe(true)
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
  })

  test('recreateWorktrees restores working dirs from surviving branches (cold start)', async () => {
    const b = await mgr.ensureWorktree('chatB')
    // Simulate a cold start: the working dir is gone but the branch survives.
    rmSync(b.path, { recursive: true, force: true })
    expect((await mgr.listManagedBranches())).toContain('shogo/chat/chatB')
    await mgr.recreateWorktrees()
    expect(existsSync(mgr.pathFor('chatB'))).toBe(true)
  })

  test('conflict -> resolve -> complete merges resolved content into main', async () => {
    const c = await mgr.ensureWorktree('chatC')
    writeFileSync(join(c.path, 'foo.txt'), 'chatC change\n')
    await mgr.commitWorktree('chatC', 'C: edit foo')
    // Diverge main on the same lines to force a conflict.
    writeFileSync(join(repo, 'foo.txt'), 'main change\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'main: edit foo'])

    const conflicted = await mgr.mergeBranchIntoMain('chatC')
    expect(conflicted.outcome).toBe('conflict')
    expect(conflicted.conflictedFiles).toContain('foo.txt')
    expect(await mgr.isMergeInProgress('chatC')).toBe(true)

    // Agent resolves by editing the file (removing markers), without staging.
    writeFileSync(join(mgr.pathFor('chatC'), 'foo.txt'), 'resolved\n')
    const done = await mgr.completeConflictedMerge('chatC')
    expect(done.outcome).toBe('clean')
    expect(readFileSync(join(repo, 'foo.txt'), 'utf-8').trim()).toBe('resolved')
    expect(await mgr.isMergeInProgress('chatC')).toBe(false)
  })

  test('completeConflictedMerge refuses while conflict markers remain', async () => {
    const d = await mgr.ensureWorktree('chatD')
    writeFileSync(join(d.path, 'foo.txt'), 'chatD change\n')
    await mgr.commitWorktree('chatD', 'D: edit foo')
    writeFileSync(join(repo, 'foo.txt'), 'main change\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'main: edit foo'])

    await mgr.mergeBranchIntoMain('chatD') // leaves conflict markers in place
    // Do NOT resolve — markers still present.
    const res = await mgr.completeConflictedMerge('chatD')
    expect(res.outcome).toBe('conflict')
    expect(res.conflictedFiles).toContain('foo.txt')
  })

  test('removeWorktree tears down the dir and (optionally) the branch', async () => {
    await mgr.ensureWorktree('chatE')
    await mgr.removeWorktree('chatE', { deleteBranch: true })
    expect(existsSync(mgr.pathFor('chatE'))).toBe(false)
    expect((await mgr.listManagedBranches())).not.toContain('shogo/chat/chatE')
  })
})
