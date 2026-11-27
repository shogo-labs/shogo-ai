// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `.tmp` hygiene (SHO-607) against the real `git` binary.
 *
 * The whole point of the module is a decision about real worktrees — squash
 * merges, pruned remote branches, detached HEADs, standalone clones and stray
 * symlinks — so these tests build a throwaway repo with a bare remote and let
 * git produce the state instead of faking it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  pruneClosedCardTmpWorktrees,
  sweepTmpHygiene,
  tmpHygieneRoots,
  type CardBranchIndex,
  type CardBranchRef,
} from '../tmp-hygiene'

const IDENT = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@shogo.ai',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@shogo.ai',
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...IDENT },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

let tmpRoot: string
let proj: string
let origin: string

function addWorktree(name: string, branch: string | null, opts: { detachAt?: string } = {}): string {
  const path = join(proj, '.tmp', name)
  mkdirSync(join(proj, '.tmp'), { recursive: true })
  if (opts.detachAt) git(proj, ['worktree', 'add', '--detach', path, opts.detachAt])
  else if (branch) git(proj, ['worktree', 'add', '-b', branch, path, 'HEAD'])
  else git(proj, ['worktree', 'add', path, 'HEAD'])
  return path
}

function commitIn(path: string, file: string, content: string, message: string): string {
  writeFileSync(join(path, file), content)
  git(path, ['add', '-A'])
  git(path, ['commit', '-m', message])
  return git(path, ['rev-parse', 'HEAD'])
}

function backdate(path: string, days: number): void {
  const when = (Date.now() - days * 24 * 60 * 60_000) / 1000
  utimesSync(path, when, when)
}

function closedCard(key: string, branch: string, headSha: string): CardBranchRef {
  return {
    key,
    number: 1,
    branch,
    prs: [{ number: 1, headRef: branch, headSha, state: 'closed', merged: true }],
  }
}

const indexOf = (open: CardBranchRef[], closed: CardBranchRef[]): CardBranchIndex => ({ open, closed })

beforeEach(() => {
  // macOS's tmpdir is a symlink to /private/var — git reports real paths.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tmp-hygiene-')))
  origin = join(tmpRoot, 'origin.git')
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'pipe' })
  proj = join(tmpRoot, 'proj')
  mkdirSync(proj)
  git(proj, ['init', '-b', 'main'])
  writeFileSync(join(proj, '.gitignore'), '.tmp/\nnode_modules/\n')
  writeFileSync(join(proj, 'a.txt'), 'base\n')
  git(proj, ['add', '-A'])
  git(proj, ['commit', '-m', 'init'])
  git(proj, ['remote', 'add', 'origin', origin])
  git(proj, ['push', '-u', 'origin', 'main'])
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('sweepTmpHygiene', () => {
  test('AC1: removes a squash-merged worktree whose HEAD is the closed PR head, node_modules with it', async () => {
    const wt = addWorktree('wt-merged', 'sho-607-squash')
    writeFileSync(join(wt, 'work.txt'), 'landed work\n')
    mkdirSync(join(wt, 'node_modules'))
    writeFileSync(join(wt, 'node_modules', 'dep.js'), 'module\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'the work'])
    git(wt, ['push', '-u', 'origin', 'sho-607-squash'])
    const headSha = git(wt, ['rev-parse', 'HEAD'])

    // Squash merge: main gets a different commit, then the remote branch is
    // pruned. `rev-list HEAD --not --remotes` now reports the work unpushed.
    git(proj, ['merge', '--squash', 'sho-607-squash'])
    git(proj, ['commit', '-m', 'squash merge SHO-607'])
    git(proj, ['push', 'origin', 'main'])
    git(proj, ['push', 'origin', '--delete', 'sho-607-squash'])
    git(proj, ['fetch', '--prune'])
    const ahead = Number(git(wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes']))
    expect(ahead).toBeGreaterThan(0)

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () => indexOf([], [closedCard('SHO-607', 'sho-607-squash', headSha)]),
      recentWindowMs: 0,
    })

    expect(report.removed.map((entry) => entry.path)).toContain(wt)
    expect(existsSync(wt)).toBe(false)
    expect(existsSync(join(wt, 'node_modules'))).toBe(false)
    expect(git(proj, ['branch', '--list', 'sho-607-squash'])).toBe('')
  })

  test('measureBytes: false still removes a clean pushed worktree and reports bytes as null', async () => {
    // The one-time cleanup turns off `du` so a full pass over hundreds of
    // worktrees finishes without being killed; removal must not depend on it.
    const wt = addWorktree('wt-fast', 'sho-607-fast')
    git(wt, ['push', '-u', 'origin', 'sho-607-fast'])

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () => indexOf([], []),
      recentWindowMs: 0,
      measureBytes: false,
    })

    const entry = report.removed.find((r) => r.path === wt)
    expect(entry).toBeDefined()
    expect(entry?.bytes).toBeNull()
    expect(existsSync(wt)).toBe(false)
  })

  test('AC2: keeps a dirty worktree and an unpushed one, with reasons', async () => {
    const dirty = addWorktree('wt-dirty', 'sho-607-dirty')
    git(dirty, ['push', '-u', 'origin', 'sho-607-dirty'])
    writeFileSync(join(dirty, 'scratch.txt'), 'not committed\n')

    const unpushed = addWorktree('wt-unpushed', 'sho-607-unpushed')
    commitIn(unpushed, 'local.txt', 'only here\n', 'unpushed work')

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () => indexOf([], []),
      recentWindowMs: 0,
    })

    expect(report.removed).toHaveLength(0)
    const byPath = new Map(report.kept.map((entry) => [entry.path, entry.reason]))
    expect(byPath.get(dirty)).toContain('uncommitted changes')
    expect(byPath.get(unpushed)).toContain('unpushed commit')
    expect(existsSync(dirty)).toBe(true)
    expect(existsSync(unpushed)).toBe(true)
  })

  test('AC3: never touches an open card worktree (branch, PR head) or one touched in the last 15 min', async () => {
    const byBranch = addWorktree('wt-open-branch', 'sho-607-open')
    const headSha = git(byBranch, ['rev-parse', 'HEAD'])
    git(byBranch, ['push', '-u', 'origin', 'sho-607-open'])
    const detached = addWorktree('wt-open-detached', null, { detachAt: headSha })
    const recent = addWorktree('wt-recent', 'sho-607-recent')
    // Its own commit: several checkouts can sit on one commit, and a head SHA
    // only names a worktree when the worktree is detached.
    commitIn(recent, 'recent.txt', 'recent work\n', 'recent work')
    git(recent, ['push', '-u', 'origin', 'sho-607-recent'])

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () =>
        indexOf(
          [{ key: 'SHO-607', number: 607, branch: 'sho-607-open', prs: [{ number: 607, headRef: 'sho-607-open', headSha }] }],
          [],
        ),
      now: () => Date.now(),
    })

    expect(report.removed).toHaveLength(0)
    expect(report.kept.map((entry) => entry.path)).not.toContain(byBranch)
    expect(report.kept.map((entry) => entry.path)).not.toContain(detached)
    expect(report.deferred.map((entry) => entry.path)).toContain(recent)
    expect(existsSync(byBranch)).toBe(true)
    expect(existsSync(detached)).toBe(true)
    expect(existsSync(recent)).toBe(true)
  })

  test('AC4: removes nothing outside the in-scope .tmp dirs', async () => {
    const elsewhere = join(tmpRoot, 'elsewhere')
    git(proj, ['worktree', 'add', '-b', 'sho-607-outside', elsewhere, 'HEAD'])
    git(elsewhere, ['push', '-u', 'origin', 'sho-607-outside'])

    mkdirSync(join(proj, '.tmp'), { recursive: true })
    const outsideRepo = join(tmpRoot, 'outside-repo')
    mkdirSync(outsideRepo)
    git(outsideRepo, ['init', '-b', 'main'])
    writeFileSync(join(outsideRepo, 'keep.txt'), 'mine\n')
    git(outsideRepo, ['add', '-A'])
    git(outsideRepo, ['commit', '-m', 'outside'])
    symlinkSync(outsideRepo, join(proj, '.tmp', 'link-out'))

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () => indexOf([], []),
      recentWindowMs: 0,
    })

    expect(report.removed).toHaveLength(0)
    expect(existsSync(elsewhere)).toBe(true)
    expect(existsSync(join(outsideRepo, 'keep.txt'))).toBe(true)
    expect(existsSync(join(proj, '.tmp', 'link-out'))).toBe(true)
  })

  test('AC5: removes old loose scratch, keeps recent entries and any dir holding .git', async () => {
    mkdirSync(join(proj, '.tmp'), { recursive: true })
    const oldFile = join(proj, '.tmp', 'old.log')
    const newFile = join(proj, '.tmp', 'new.log')
    writeFileSync(oldFile, 'old scratch\n')
    writeFileSync(newFile, 'fresh scratch\n')
    backdate(oldFile, 4)

    const oldDir = join(proj, '.tmp', 'artifacts1')
    mkdirSync(oldDir)
    writeFileSync(join(oldDir, 'out.json'), '{}')
    backdate(join(oldDir, 'out.json'), 4)
    backdate(oldDir, 4)

    const repoDir = join(proj, '.tmp', 'repoish')
    mkdirSync(join(repoDir, '.git'), { recursive: true })
    git(repoDir, ['init', '-b', 'main'])
    writeFileSync(join(repoDir, 'x.txt'), 'x\n')
    backdate(join(repoDir, 'x.txt'), 4)
    backdate(repoDir, 4)

    const report = await sweepTmpHygiene({
      roots: [proj],
      // No card index: the loose half still runs (fail-closed worktrees only).
      loadCardBranches: async () => null,
    })

    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(newFile)).toBe(true)
    expect(existsSync(repoDir)).toBe(true)
    expect(report.loose.files).toBe(1)
    expect(report.loose.dirs).toBe(1)
    expect(report.loose.bytes).toBeGreaterThan(0)
    expect(report.errors.length).toBeGreaterThan(0)
  })

  test('the close hook prunes only the closing card worktrees', async () => {
    const mine = addWorktree('wt-mine', 'sho-607-mine')
    const other = addWorktree('wt-other', 'sho-607-other')
    git(mine, ['push', '-u', 'origin', 'sho-607-mine'])
    git(other, ['push', '-u', 'origin', 'sho-607-other'])
    const mineSha = git(mine, ['rev-parse', 'HEAD'])
    const otherSha = git(other, ['rev-parse', 'HEAD'])

    const report = await pruneClosedCardTmpWorktrees({
      roots: [proj],
      card: closedCard('SHO-607', 'sho-607-mine', mineSha),
      loadCardBranches: async () => indexOf([], [closedCard('SHO-606', 'sho-607-other', otherSha)]),
      recentWindowMs: 0,
    })

    expect(report.removed.map((entry) => entry.path)).toContain(mine)
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  test('a failed card index leaves worktrees alone (fail closed)', async () => {
    const wt = addWorktree('wt-untouched', 'sho-607-untouched')
    git(wt, ['push', '-u', 'origin', 'sho-607-untouched'])

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () => null,
      recentWindowMs: 0,
    })

    expect(report.removed).toHaveLength(0)
    expect(existsSync(wt)).toBe(true)
  })
})

describe('tmpHygieneRoots', () => {
  test('excludes folder-linked projects and keeps managed members', () => {
    const roots = tmpHygieneRoots({
      workspaceDir: '/ws',
      workingMode: 'managed',
      isWorkspaceRuntime: true,
      projectIds: ['p-managed', 'p-external', 'p-folder'],
      mounts: [
        { mount: 'p-managed', projectId: 'p-managed', kind: 'managed' },
        { mount: 'p-external', projectId: 'p-external', kind: 'external' },
        { mount: 'p-folder', projectId: 'p-folder', kind: 'folder' },
      ],
    })
    expect(roots).toContain('/ws/p-managed')
    expect(roots).not.toContain('/ws/p-external')
    expect(roots).not.toContain('/ws/p-folder')
  })

  test('a single external project has no scope at all', () => {
    expect(
      tmpHygieneRoots({
        workspaceDir: '/home/me/repo',
        workingMode: 'external',
        isWorkspaceRuntime: false,
        projectIds: [],
        mounts: [],
      }),
    ).toEqual([])
  })
})
