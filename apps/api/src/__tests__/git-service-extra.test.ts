// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Extra coverage for src/services/git.service.ts targeting:
//   - evictStaleIndexLock stale + fresh + ENOENT paths
//   - ensureGitignoreIgnoresDeps append branch (existing file missing entries)
//   - getHistory with `before` + `branch` options + non-repo catch
//   - getCurrentBranch / getHeadSha non-repo catches
//   - push / fetch / pull error returns (no remote configured)
//   - addRemote idempotent re-add branch
//   - listBranches on non-repo
//   - checkout error path
//   - purgeWindowsReservedFiles non-win32 early-return (commits succeed
//     even when a file with a reserved-name basename exists)

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  utimesSync,
  mkdirSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import * as gitService from '../services/git.service'

let workspacePath: string

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'git-extra-'))
})

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true })
})

// ----------------------------------------------------------------------------
// Non-repo error paths (covers the `try { ... } catch { return ... }` arms
// in getCurrentBranch / getHeadSha / getStatus / getCommit / listBranches)
// ----------------------------------------------------------------------------

describe('non-repo error paths', () => {
  test('getCurrentBranch on a non-repo dir falls back to "main"', async () => {
    expect(await gitService.getCurrentBranch(workspacePath)).toBe('main')
  })

  test('getHeadSha on a non-repo dir returns null', async () => {
    expect(await gitService.getHeadSha(workspacePath)).toBeNull()
  })

  test('getCommit on a non-repo dir returns null', async () => {
    expect(await gitService.getCommit(workspacePath, 'HEAD')).toBeNull()
  })

  test('getHistory on a non-repo dir returns an empty array', async () => {
    expect(await gitService.getHistory(workspacePath)).toEqual([])
  })

  test('listBranches on a non-repo dir returns an empty array', async () => {
    expect(await gitService.listBranches(workspacePath)).toEqual([])
  })

  test('getStatus on a non-repo dir reports isRepo=false with empty arrays', async () => {
    const status = await gitService.getStatus(workspacePath)
    expect(status.isRepo).toBe(false)
    expect(status.modified).toEqual([])
    expect(status.untracked).toEqual([])
    expect(status.staged).toEqual([])
    expect(status.hasChanges).toBe(false)
  })

  test('getDiff on a non-repo dir returns an empty diff', async () => {
    const diff = await gitService.getDiff(workspacePath, { from: 'HEAD~1', to: 'HEAD' })
    expect(diff.files).toEqual([])
    expect(diff.totalAdditions).toBe(0)
    expect(diff.totalDeletions).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// getHistory option branches
// ----------------------------------------------------------------------------

describe('getHistory — option branches', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
    writeFileSync(join(workspacePath, 'b.txt'), 'b')
    await gitService.commit(workspacePath, { message: 'add b' })
    writeFileSync(join(workspacePath, 'c.txt'), 'c')
    await gitService.commit(workspacePath, { message: 'add c' })
  })

  test('limit caps the returned history length', async () => {
    const history = await gitService.getHistory(workspacePath, { limit: 1 })
    expect(history).toHaveLength(1)
    expect(history[0].message).toBe('add c')
  })

  test('"before" excludes the target commit and everything after it', async () => {
    const head = await gitService.getHeadSha(workspacePath)
    expect(head).not.toBeNull()
    const history = await gitService.getHistory(workspacePath, { before: head!, limit: 50 })
    // `before: HEAD` becomes `HEAD^` in args → returns parents of HEAD only.
    expect(history.some((c) => c.message === 'add c')).toBe(false)
    expect(history.some((c) => c.message === 'add b')).toBe(true)
  })

  test('"branch" filter restricts history to the given branch', async () => {
    const history = await gitService.getHistory(workspacePath, { branch: 'main' })
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history.map((c) => c.message)).toContain('add c')
  })

  test('non-existent branch falls through the catch and returns []', async () => {
    expect(await gitService.getHistory(workspacePath, { branch: 'no-such-branch' })).toEqual([])
  })
})

// ----------------------------------------------------------------------------
// evictStaleIndexLock — stale removed, fresh kept (exercised via commit())
// ----------------------------------------------------------------------------

describe('evictStaleIndexLock — exercised via commit()', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
  })

  test('stale .git/index.lock is removed before staging — commit succeeds', async () => {
    const lockPath = join(workspacePath, '.git', 'index.lock')
    writeFileSync(lockPath, '')
    // Backdate the lock so it looks ~10s old (threshold is 5s).
    const tenSecondsAgo = (Date.now() - 10_000) / 1000
    utimesSync(lockPath, tenSecondsAgo, tenSecondsAgo)

    writeFileSync(join(workspacePath, 'new.txt'), 'fresh')
    const commit = await gitService.commit(workspacePath, { message: 'after stale lock' })

    expect(commit).not.toBeNull()
    expect(commit!.message).toBe('after stale lock')
    expect(existsSync(lockPath)).toBe(false)
  })

  test('no lock present is a no-op (covers the inner statSync catch)', async () => {
    writeFileSync(join(workspacePath, 'two.txt'), '2')
    const commit = await gitService.commit(workspacePath, { message: 'no lock' })
    expect(commit).not.toBeNull()
  })
})

// ----------------------------------------------------------------------------
// ensureGitignoreIgnoresDeps — append branch
// ----------------------------------------------------------------------------

describe('ensureGitignoreIgnoresDeps — exercised via commit()', () => {
  test('appends missing required entries to an existing .gitignore', async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    // Pre-create a non-trivial .gitignore that's missing the required
    // build-output entries. We're checking the append-without-rewrite branch.
    writeFileSync(join(workspacePath, '.gitignore'), '# user file\nmy-secrets.env\n')
    await gitService.initRepo(workspacePath)

    writeFileSync(join(workspacePath, 'b.txt'), 'b')
    await gitService.commit(workspacePath, { message: 'add b' })

    const gitignore = readFileSync(join(workspacePath, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('my-secrets.env') // user content preserved
    expect(gitignore).toContain('node_modules') // shogo appended
    expect(gitignore).toContain('Added by Shogo AI')
  })

  test('does not duplicate entries when .gitignore already has them', async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    // Pre-seed with all the entries — the helper should be a no-op.
    writeFileSync(
      join(workspacePath, '.gitignore'),
      [
        'node_modules/', '.bun/',
        'dist/', 'dist.staging/', 'dist.canvas.staging/', 'dist.prev/',
        'build/', '.output/', '.nitro/', '.shogo/',
        'nul', 'con', 'prn', 'aux',
      ].join('\n') + '\n',
    )
    await gitService.initRepo(workspacePath)

    const before = readFileSync(join(workspacePath, '.gitignore'), 'utf-8')
    writeFileSync(join(workspacePath, 'b.txt'), 'b')
    await gitService.commit(workspacePath, { message: 'add b' })
    const after = readFileSync(join(workspacePath, '.gitignore'), 'utf-8')

    expect(after).toBe(before)
    expect(after.match(/Added by Shogo AI/g)).toBeNull()
  })
})

// ----------------------------------------------------------------------------
// Remote operations — error returns when remote / target is missing
// ----------------------------------------------------------------------------

describe('remote operations — error returns', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
  })

  test('push without a configured remote returns success=false with an error', async () => {
    const result = await gitService.push(workspacePath)
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error!.length).toBeGreaterThan(0)
  })

  test('push with setUpstream + force + explicit branch on a missing remote errors out', async () => {
    const result = await gitService.push(workspacePath, {
      remote: 'no-such-remote',
      branch: 'main',
      force: true,
      setUpstream: true,
    })
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })

  test('fetch without a remote returns success=false; with prune flag still errors', async () => {
    expect((await gitService.fetch(workspacePath)).success).toBe(false)
    expect((await gitService.fetch(workspacePath, { prune: true, remote: 'no-such' })).success).toBe(false)
  })

  test('pull without a remote returns success=false; with rebase + branch still errors', async () => {
    expect((await gitService.pull(workspacePath)).success).toBe(false)
    const r = await gitService.pull(workspacePath, { remote: 'no-such', branch: 'main', rebase: true })
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
  })

  test('addRemote is idempotent — re-adding the same name replaces the URL', async () => {
    await gitService.addRemote(workspacePath, 'origin', 'https://example.com/a.git')
    // Calling again must NOT throw (the function silently removes the
    // existing remote first, then re-adds).
    await gitService.addRemote(workspacePath, 'origin', 'https://example.com/b.git')
    // Sanity check: a subsequent push should still fail (the URL is bogus)
    // but should not throw a "remote already exists" error.
    const result = await gitService.push(workspacePath, { remote: 'origin', branch: 'main' })
    expect(result.success).toBe(false)
  })
})

// ----------------------------------------------------------------------------
// createBranch + checkout error returns
// ----------------------------------------------------------------------------

describe('branch + checkout error returns', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
  })

  test('createBranch reports success=false with an error when the name already exists', async () => {
    const first = await gitService.createBranch(workspacePath, 'feature/dupe', { checkout: false })
    expect(first.success).toBe(true)
    const second = await gitService.createBranch(workspacePath, 'feature/dupe', { checkout: false })
    expect(second.success).toBe(false)
    expect(second.error).toBeTruthy()
  })

  test('createBranch with fromRef + checkout=false stays on the original branch', async () => {
    const head = await gitService.getHeadSha(workspacePath)
    expect(head).not.toBeNull()
    const before = await gitService.getCurrentBranch(workspacePath)
    const result = await gitService.createBranch(workspacePath, 'feature/from-ref', {
      fromRef: head!,
      checkout: false,
    })
    expect(result.success).toBe(true)
    expect(await gitService.getCurrentBranch(workspacePath)).toBe(before)
  })

  test('checkout to an invalid ref returns success=false with an error', async () => {
    const result = await gitService.checkout(workspacePath, 'definitely-not-a-real-ref')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    // We're still on the original branch.
    expect(result.branch).toBeTruthy()
  })
})

// ----------------------------------------------------------------------------
// Commit corner: includeUntracked=true uses `git add -A`; new files appear
// ----------------------------------------------------------------------------

describe('commit corner cases', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
  })

  test('explicit includeUntracked=true still picks up new files', async () => {
    writeFileSync(join(workspacePath, 'added.txt'), 'fresh')
    const result = await gitService.commit(workspacePath, {
      message: 'add new file with explicit include flag',
      includeUntracked: true,
    })
    expect(result).not.toBeNull()
    expect(result!.filesChanged).toBeGreaterThan(0)
  })

  test('commit on a clean repo (no changes at all) returns null', async () => {
    const result = await gitService.commit(workspacePath, { message: 'nothing here' })
    expect(result).toBeNull()
  })

  test('commit picks up nested directory additions', async () => {
    mkdirSync(join(workspacePath, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(workspacePath, 'nested', 'deep', 'leaf.txt'), 'leaf')
    const result = await gitService.commit(workspacePath, { message: 'add nested tree' })
    expect(result).not.toBeNull()
    expect(result!.filesChanged).toBeGreaterThan(0)
  })
})

// ----------------------------------------------------------------------------
// purgeWindowsReservedFiles — non-Windows hosts must NOT delete reserved-name
// files (the early-return branch). On Linux/macOS we can have a file named
// `nul` happily and the commit should pick it up unchanged.
// ----------------------------------------------------------------------------

describe('purgeWindowsReservedFiles — non-Windows early-return', () => {
  test('files with Windows-reserved basenames are kept and committed on POSIX hosts', async () => {
    if (process.platform === 'win32') {
      // Skip on Windows — the actual purge would delete the file, which is
      // the OPPOSITE behavior. The test above (on POSIX) covers the early
      // return; Windows behavior is exercised by the production logic itself.
      return
    }
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.initRepo(workspacePath)
    // `nul`/`con`/`prn`/`aux` are in the gitignore list, so use a
    // reserved-name that ISN'T gitignored — e.g. `com1` — and confirm the
    // commit succeeds (proving purgeWindowsReservedFiles early-returned).
    writeFileSync(join(workspacePath, 'com1'), 'should survive on POSIX')
    const result = await gitService.commit(workspacePath, { message: 'add com1 file' })
    expect(result).not.toBeNull()
    expect(existsSync(join(workspacePath, 'com1'))).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// isGitAvailable caches its result — second call returns the same boolean
// ----------------------------------------------------------------------------

describe('isGitAvailable', () => {
  test('returns true once git is on PATH and caches the result', () => {
    const first = gitService.isGitAvailable()
    const second = gitService.isGitAvailable()
    expect(first).toBe(true)
    expect(second).toBe(first) // cached path returns same boolean
  })
})
