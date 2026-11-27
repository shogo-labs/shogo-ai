// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-607 — the `.tmp` hygiene sweep decides what to delete
 * on a real machine, so every case below is built with the real `git` binary
 * and a bare remote rather than mocked porcelain output.
 *
 * The cases follow the card's acceptance criteria literally: the plan says a
 * worktree belongs to an open card when its **branch, HEAD sha** matches, so an
 * open PR's head must protect a worktree even when the checkout sits on a
 * differently-named local branch.
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

function worktree(name: string, branch: string | null, opts: { detachAt?: string } = {}): string {
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

const backdate = (path: string, days: number) => {
  const when = (Date.now() - days * 24 * 60 * 60_000) / 1000
  utimesSync(path, when, when)
}

const indexOf = (open: CardBranchRef[], closed: CardBranchRef[]): CardBranchIndex => ({ open, closed })

const card = (over: Partial<CardBranchRef> & { key: string; branch: string | null }): CardBranchRef => ({
  number: 1,
  prs: [],
  ...over,
})

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'qa-sho607-')))
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

describe('SHO-607 acceptance', () => {
  test('AC1: a squash-merged branch whose HEAD is the closed PR head is removed with its node_modules', async () => {
    const wt = worktree('qa-merged', 'sho-607-squash')
    writeFileSync(join(wt, 'feature.txt'), 'landed\n')
    mkdirSync(join(wt, 'node_modules'))
    writeFileSync(join(wt, 'node_modules', 'dep.js'), 'module\n')
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-m', 'feature'])
    git(wt, ['push', '-u', 'origin', 'sho-607-squash'])
    const headSha = git(wt, ['rev-parse', 'HEAD'])

    git(proj, ['merge', '--squash', 'sho-607-squash'])
    git(proj, ['commit', '-m', 'squash merge'])
    git(proj, ['push', 'origin', 'main'])
    git(proj, ['push', 'origin', '--delete', 'sho-607-squash'])
    git(proj, ['fetch', '--prune'])
    // Premise of the card: after the squash + prune git says the work is unpushed.
    expect(Number(git(wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes']))).toBeGreaterThan(0)

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () =>
        indexOf([], [
          card({
            key: 'SHO-607',
            branch: 'sho-607-squash',
            prs: [{ number: 91, headRef: 'sho-607-squash', headSha, state: 'closed', merged: true }],
          }),
        ]),
      recentWindowMs: 0,
    })

    expect(report.removed.map((entry) => entry.path)).toEqual([wt])
    expect(existsSync(wt)).toBe(false)
    expect(git(proj, ['branch', '--list', 'sho-607-squash'])).toBe('')
    expect(git(proj, ['worktree', 'list'])).not.toContain('qa-merged')
  })

  test('AC2: dirty and unpushed worktrees are kept with a reason, and only node_modules is not "dirty"', async () => {
    const dirty = worktree('qa-dirty', 'sho-607-dirty')
    git(dirty, ['push', '-u', 'origin', 'sho-607-dirty'])
    writeFileSync(join(dirty, 'scratch.txt'), 'uncommitted\n')

    const unpushed = worktree('qa-unpushed', 'sho-607-unpushed')
    commitIn(unpushed, 'local.txt', 'local only\n', 'unpushed')

    // A clean, pushed worktree whose only extra files are ignored: removable.
    const merged = worktree('qa-merged-ignore', 'sho-607-merged')
    mkdirSync(join(merged, 'node_modules'))
    writeFileSync(join(merged, 'node_modules', 'x.js'), 'ignored\n')
    git(merged, ['push', '-u', 'origin', 'sho-607-merged'])
    const mergedHead = git(merged, ['rev-parse', 'HEAD'])

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () =>
        indexOf([], [
          card({
            key: 'SHO-607',
            branch: 'sho-607-merged',
            prs: [{ number: 92, headRef: 'sho-607-merged', headSha: mergedHead, state: 'closed', merged: true }],
          }),
        ]),
      recentWindowMs: 0,
    })

    const reasons = new Map(report.kept.map((entry) => [entry.path, entry.reason]))
    expect(reasons.get(dirty)).toContain('uncommitted changes')
    expect(reasons.get(unpushed)).toContain('unpushed commit')
    expect(existsSync(dirty)).toBe(true)
    expect(existsSync(unpushed)).toBe(true)
    // Ignored `node_modules` must not read as uncommitted work.
    expect(report.removed.map((entry) => entry.path)).toContain(merged)
    expect(existsSync(merged)).toBe(false)
  })

  test('AC3a: an open card protects its branch worktree and its detached-head worktree', async () => {
    const byBranch = worktree('qa-open-branch', 'sho-607-open')
    const headSha = git(byBranch, ['rev-parse', 'HEAD'])
    git(byBranch, ['push', '-u', 'origin', 'sho-607-open'])
    const detached = worktree('qa-open-detached', null, { detachAt: headSha })

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () =>
        indexOf(
          [
            card({
              key: 'SHO-607',
              branch: 'sho-607-open',
              prs: [{ number: 93, headRef: 'sho-607-open', headSha, state: 'open' }],
            }),
          ],
          [],
        ),
      recentWindowMs: 0,
    })

    expect(report.removed).toHaveLength(0)
    expect(report.kept.map((entry) => entry.path)).not.toContain(byBranch)
    expect(report.kept.map((entry) => entry.path)).not.toContain(detached)
    expect(existsSync(byBranch)).toBe(true)
    expect(existsSync(detached)).toBe(true)
  })

  test('AC3b: an open card protects a worktree at its PR head even on a differently-named local branch', async () => {
    // The reviewer checked the PR out under its own branch name — the plan says
    // an open card is matched by branch *or* HEAD sha, not by name.
    const review = worktree('qa-607-review', 'qa-607-review')
    const headSha = commitIn(review, 'pr.txt', 'the PR head\n', 'PR head')
    git(review, ['push', '-u', 'origin', 'qa-607-review'])

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () =>
        indexOf(
          [
            card({
              key: 'SHO-607',
              branch: 'sho-607-prune-tmp-worktrees',
              prs: [{ number: 94, headRef: 'sho-607-prune-tmp-worktrees', headSha, state: 'open' }],
            }),
          ],
          [],
        ),
      recentWindowMs: 0,
    })

    expect(report.removed.map((entry) => entry.path)).not.toContain(review)
    expect(existsSync(review)).toBe(true)
  })

  test('AC3c: a worktree touched in the last 15 minutes is deferred, not removed', async () => {
    const recent = worktree('qa-recent', 'sho-607-recent')
    git(recent, ['push', '-u', 'origin', 'sho-607-recent'])

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () => indexOf([], []),
      now: () => Date.now(),
    })

    expect(report.removed).toHaveLength(0)
    expect(report.deferred.map((entry) => entry.path)).toContain(recent)
    expect(existsSync(recent)).toBe(true)
  })

  test('AC4: a worktree outside .tmp, a symlink out and a folder-linked project survive', async () => {
    const elsewhere = join(tmpRoot, 'elsewhere')
    git(proj, ['worktree', 'add', '-b', 'sho-607-outside', elsewhere, 'HEAD'])
    git(elsewhere, ['push', '-u', 'origin', 'sho-607-outside'])

    const folderProject = join(tmpRoot, 'user-repo')
    mkdirSync(join(folderProject, '.tmp'), { recursive: true })
    git(folderProject, ['init', '-b', 'main'])
    writeFileSync(join(folderProject, 'keep.txt'), 'mine\n')
    git(folderProject, ['add', '-A'])
    git(folderProject, ['commit', '-m', 'user work'])
    const folderWt = join(folderProject, '.tmp', 'user-wt')
    git(folderProject, ['worktree', 'add', '-b', 'user-branch', folderWt, 'HEAD'])
    const folderHead = git(folderWt, ['rev-parse', 'HEAD'])

    const outsideRepo = join(tmpRoot, 'outside-repo')
    mkdirSync(outsideRepo)
    writeFileSync(join(outsideRepo, 'keep.txt'), 'mine too\n')
    mkdirSync(join(proj, '.tmp'), { recursive: true })
    symlinkSync(outsideRepo, join(proj, '.tmp', 'link-out'))

    const roots = tmpHygieneRoots({
      workspaceDir: proj,
      workingMode: 'managed',
      isWorkspaceRuntime: true,
      projectIds: ['p-managed', 'p-folder'],
      mounts: [
        { mount: 'p-managed', projectId: 'p-managed', kind: 'managed' },
        { mount: 'user-repo', projectId: 'p-folder', kind: 'folder' },
      ],
    })
    expect(roots).not.toContain(folderProject)

    const report = await sweepTmpHygiene({
      roots,
      loadCardBranches: async () =>
        indexOf([], [
          card({
            key: 'SHO-607',
            branch: 'user-branch',
            prs: [{ number: 95, headRef: 'user-branch', headSha: folderHead, state: 'closed', merged: true }],
          }),
        ]),
      recentWindowMs: 0,
    })

    expect(report.removed.map((entry) => entry.path)).toEqual([])
    expect(existsSync(elsewhere)).toBe(true)
    expect(existsSync(join(outsideRepo, 'keep.txt'))).toBe(true)
    expect(existsSync(join(proj, '.tmp', 'link-out'))).toBe(true)
    expect(existsSync(folderWt)).toBe(true)
  })

  test('AC5: old loose files and old non-git dirs go; recent ones and any dir with .git stay', async () => {
    const tmp = join(proj, '.tmp')
    mkdirSync(tmp, { recursive: true })
    const oldFile = join(tmp, 'old.log')
    const newFile = join(tmp, 'new.log')
    writeFileSync(oldFile, 'old\n')
    writeFileSync(newFile, 'new\n')
    backdate(oldFile, 4)

    const oldDir = join(tmp, 'artifacts1')
    mkdirSync(join(oldDir, 'nested'), { recursive: true })
    writeFileSync(join(oldDir, 'nested', 'out.json'), '{}')
    backdate(join(oldDir, 'nested', 'out.json'), 4)
    backdate(join(oldDir, 'nested'), 4)
    backdate(oldDir, 4)

    const newDir = join(tmp, 'artifacts2')
    mkdirSync(newDir)
    writeFileSync(join(newDir, 'fresh.json'), '{}')

    const repoDir = join(tmp, 'stray-clone')
    mkdirSync(repoDir)
    git(repoDir, ['init', '-b', 'main'])
    writeFileSync(join(repoDir, 'x.txt'), 'x\n')
    git(repoDir, ['add', '-A'])
    git(repoDir, ['commit', '-m', 'scratch'])
    backdate(join(repoDir, 'x.txt'), 4)
    backdate(join(repoDir, '.git'), 4)
    backdate(repoDir, 4)

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () => indexOf([], []),
      recentWindowMs: 0,
    })

    expect(bodyOf(report.loose)).toMatchObject({ files: 1, dirs: 1 })
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(newFile)).toBe(true)
    expect(existsSync(newDir)).toBe(true)
    // A dir holding `.git` is a repo, never loose scratch.
    expect(existsSync(join(repoDir, '.git'))).toBe(true)
  })

  test('fail closed: no card index means no worktree is removed, but loose scratch still goes', async () => {
    const wt = worktree('qa-no-index', 'sho-607-no-index')
    git(wt, ['push', '-u', 'origin', 'sho-607-no-index'])
    const stale = join(proj, '.tmp', 'old.log')
    writeFileSync(stale, 'old\n')
    backdate(stale, 4)

    const report = await sweepTmpHygiene({
      roots: [proj],
      loadCardBranches: async () => null,
      recentWindowMs: 0,
    })

    expect(report.removed).toHaveLength(0)
    expect(report.errors.join(' ')).toContain('card branches unavailable')
    expect(existsSync(wt)).toBe(true)
    expect(existsSync(stale)).toBe(false)
  })

  test('the close hook only touches the closing card, leaving another closed card alone', async () => {
    const mine = worktree('qa-close-mine', 'sho-607-mine')
    const mineHead = git(mine, ['rev-parse', 'HEAD'])
    git(mine, ['push', '-u', 'origin', 'sho-607-mine'])
    const other = worktree('qa-close-other', 'sho-607-other')
    git(other, ['push', '-u', 'origin', 'sho-607-other'])
    const otherHead = git(other, ['rev-parse', 'HEAD'])
    const strayFile = join(proj, '.tmp', 'old.log')
    writeFileSync(strayFile, 'old\n')
    backdate(strayFile, 4)

    const report = await pruneClosedCardTmpWorktrees({
      roots: [proj],
      card: card({
        key: 'SHO-607',
        branch: 'sho-607-mine',
        prs: [{ number: 96, headRef: 'sho-607-mine', headSha: mineHead, state: 'closed', merged: true }],
      }),
      loadCardBranches: async () =>
        indexOf([], [
          card({
            key: 'SHO-606',
            branch: 'sho-607-other',
            prs: [{ number: 97, headRef: 'sho-607-other', headSha: otherHead, state: 'closed', merged: true }],
          }),
        ]),
      recentWindowMs: 0,
    })

    expect(report.removed.map((entry) => entry.path)).toEqual([mine])
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
    // The close hook is one card's worktree, never a scratch sweep.
    expect(existsSync(strayFile)).toBe(true)
  })
})

/** Readable diff on the loose tally in a failure message. */
function bodyOf(tally: { files: number; dirs: number; bytes: number }) {
  return { files: tally.files, dirs: tally.dirs }
}
