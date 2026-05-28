// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Edge-branch coverage for src/services/git.service.ts. Targets the
// uncovered error/branch paths the two existing test files
// (git-service.test.ts + git-service-extra.test.ts) don't exercise.
//
// Uses REAL git repos in tmp dirs (same pattern as the existing tests)
// so we drive the actual execFileSync/fs paths, not just mock returns.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync,
  utimesSync, chmodSync,
} from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

import * as gitService from '../services/git.service'

let workspacePath: string
beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'git-edge-'))
})
afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true })
})

function git(args: string[]) {
  return execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe', encoding: 'utf-8' })
}

describe('initRepo — "nothing to commit" branch (L532-538)', () => {
  test('initRepo on an EMPTY workspace creates repo + tolerates empty initial commit', async () => {
    // Empty dir, no files. The commit step will hit:
    //   "nothing to commit (create/copy files and use 'git add' to track)"
    // which the source swallows.
    const result = await gitService.initRepo(workspacePath)
    expect(result.created).toBe(true)
    expect(result.branch).toBe('main')
    expect(gitService.isGitRepo(workspacePath)).toBe(true)
  })

  test('initRepo on a workspace containing only excluded files still succeeds', async () => {
    // node_modules is in our default .gitignore; the only file added to
    // index will be the .gitignore we generate ourselves, but if there
    // are no other files the "nothing to commit" path is exercised on
    // setups where the gitignore step doesn't write.
    mkdirSync(join(workspacePath, 'node_modules', 'foo'), { recursive: true })
    writeFileSync(join(workspacePath, 'node_modules', 'foo', 'index.js'), 'x')
    const result = await gitService.initRepo(workspacePath)
    expect(result.created).toBe(true)
  })
})

describe('commit — "nothing to commit" branch (L709-715)', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
  })

  test('commit() returns null when there are no staged changes', async () => {
    // After initRepo, the index is clean. A second commit without any
    // staged changes hits the "nothing to commit" detection at L709-715.
    const result = await gitService.commit(workspacePath, 'no-op', 'Author', 'a@b.com')
    expect(result).toBeNull()
  })

  test('commit() with real changes returns the new commit', async () => {
    writeFileSync(join(workspacePath, 'b.txt'), 'b')
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    git(['add', 'b.txt'])
    const result = await gitService.commit(workspacePath, 'add b', 'Author', 'a@b.com')
    expect(result).not.toBeNull()
    expect(result?.sha).toMatch(/^[0-9a-f]+$/)
  })

  test('commit() WITHOUT author still hits the --author optional branch', async () => {
    writeFileSync(join(workspacePath, 'c.txt'), 'c')
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    const result = await gitService.commit(workspacePath, 'add c')
    expect(result).not.toBeNull()
  })
})

describe('getDiff — file status switch branches (L893-905)', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'tracked.txt'), 'original')
    writeFileSync(join(workspacePath, 'will-delete.txt'), 'gone')
    writeFileSync(join(workspacePath, 'will-rename.txt'), 'rename me')
    await gitService.initRepo(workspacePath)
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    // initRepo already ran `git add -A` + `git commit -m 'Initial commit'`,
    // so all three files are already in HEAD. We just need to make the
    // ADDITIONAL changes for each test below.
  })

  test('captures status="deleted" for removed file (L890-892)', async () => {
    unlinkSync(join(workspacePath, 'will-delete.txt'))
    git(['add', '-A'])
    git(['commit', '-m', 'delete one'])
    const diff = await gitService.getDiff(workspacePath, 'HEAD~1', 'HEAD')
    const deletedEntry = diff.files.find((f) => f.path === 'will-delete.txt')
    expect(deletedEntry?.status).toBe('deleted')
  })

  test('captures status="renamed" for renamed file (L893-895)', async () => {
    git(['mv', 'will-rename.txt', 'renamed.txt'])
    git(['commit', '-m', 'rename'])
    const diff = await gitService.getDiff(workspacePath, 'HEAD~1', 'HEAD')
    // Rename detection in git --name-status emits 'R' (or 'R100')
    const renamedEntry = diff.files.find(
      (f) => f.path === 'renamed.txt' || f.status === 'renamed',
    )
    expect(renamedEntry?.status).toBe('renamed')
  })

  test('captures status="added" for new file (L887-889)', async () => {
    writeFileSync(join(workspacePath, 'fresh.txt'), 'new')
    git(['add', 'fresh.txt'])
    git(['commit', '-m', 'add fresh'])
    const diff = await gitService.getDiff(workspacePath, 'HEAD~1', 'HEAD')
    const addedEntry = diff.files.find((f) => f.path === 'fresh.txt')
    expect(addedEntry?.status).toBe('added')
  })
})

describe('ensureGitignoreEntries — read failure branch (L370)', () => {
  test('ensureGitignoreEntries(): readFileSync failure is swallowed and returns', async () => {
    await gitService.initRepo(workspacePath)
    const gitignorePath = join(workspacePath, '.gitignore')
    // Replace .gitignore with a DIRECTORY of the same name — readFileSync(path,'utf-8')
    // on a directory throws EISDIR, hitting the catch at L370.
    unlinkSync(gitignorePath)
    mkdirSync(gitignorePath)

    // ensureGitignoreEntries() is private (used internally by initRepo).
    // Easiest way to trigger it post-init is another initRepo() call
    // which detects the existing repo and re-runs ensureGitignoreEntries().
    // The call should NOT throw despite the EISDIR.
    const result = await gitService.initRepo(workspacePath)
    expect(result.created).toBe(false)
  })
})

describe('removeStaleIndexLock — error path (L440-445)', () => {
  test('removes a stale .git/index.lock left by a previous aborted commit', async () => {
    writeFileSync(join(workspacePath, 'x.txt'), 'x')
    await gitService.initRepo(workspacePath)
    const lockPath = join(workspacePath, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    // Age the lockfile so removal kicks in (the source treats locks > 60s as stale)
    const oldTime = new Date(Date.now() - 5 * 60 * 1000)
    utimesSync(lockPath, oldTime, oldTime)

    // Now run a commit() which calls removeStaleIndexLock() at the top.
    // Should silently remove the lock and proceed.
    writeFileSync(join(workspacePath, 'y.txt'), 'y')
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    const result = await gitService.commit(workspacePath, 'after lock cleanup', 'A', 'a@b.com')
    expect(result).not.toBeNull()
  })
})

describe('checkout — "unlink warnings non-fatal" branch (L965-998)', () => {
  test('checkout to current HEAD is a no-op success', async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(workspacePath, 'b.txt'), 'b')
    git(['add', '-A'])
    git(['commit', '-m', 'second'])

    const head = await gitService.getHeadSha(workspacePath)
    expect(head).toBeTruthy()

    const result = await gitService.checkout(workspacePath, head!)
    expect(result.success).toBe(true)
  })

  test('checkout to a non-existent ref fails gracefully (L999-1004)', async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
    const result = await gitService.checkout(workspacePath, 'does-not-exist-xyzzy')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
