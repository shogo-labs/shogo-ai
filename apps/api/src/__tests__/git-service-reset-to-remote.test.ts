// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `remoteBranchExists` / `resetHardToRemote` (git.service.ts) — added to fix
 * a real bug in `connectRepository` (github.service.ts): connecting a
 * project to an EXISTING, already-populated GitHub repo left the project's
 * own placeholder scaffold commit in place with no shared history with the
 * remote. Every subsequent `pullFromGitHub` (`git pull --rebase`) then
 * failed with "refusing to merge unrelated histories" — the project never
 * actually got the connected repo's content onto disk.
 *
 * Found live: connecting the issue-pipeline's `intake` project to its
 * disposable fixture repo (multi-project L1 eval) — a repo that, exactly
 * like a real user's existing repo, has its own independent history.
 *
 * These tests exercise the two new primitives against real local git repos
 * (a "remote" is just another local repo added via a file-path `origin`,
 * same as the rest of this file's siblings do for push/pull/fetch).
 * `connectRepository`'s own wiring of these two calls was verified live
 * (see the commit fixing this) since exercising it in-process would require
 * mocking GitHub's real REST API end-to-end.
 *
 * Run: bun test apps/api/src/__tests__/git-service-reset-to-remote.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import * as gitService from '../services/git.service'

let remotePath: string
let localPath: string

beforeEach(() => {
  remotePath = mkdtempSync(join(tmpdir(), 'git-reset-remote-'))
  localPath = mkdtempSync(join(tmpdir(), 'git-reset-local-'))
})

afterEach(() => {
  rmSync(remotePath, { recursive: true, force: true })
  rmSync(localPath, { recursive: true, force: true })
})

describe('remoteBranchExists', () => {
  test('false before any fetch (origin not added yet)', () => {
    // No git repo at all yet — requireGit() would throw synchronously if
    // git itself weren't available, but rev-parse on a bare/non-repo dir
    // fails cleanly and the function reports false rather than throwing.
    gitService.__resetGitAvailableForTesting()
    expect(gitService.remoteBranchExists(localPath, 'origin', 'main')).toBe(false)
  })

  test('true after fetching a remote with a real commit on that branch', async () => {
    // Build a populated "remote" (a real repo with one commit on main).
    writeFileSync(join(remotePath, 'README.md'), 'existing repo content')
    await gitService.initRepo(remotePath, { defaultBranch: 'main' })
    await gitService.commit(remotePath, { message: 'seed', author: { name: 'x', email: 'x@x.com' } })

    // Fresh local checkout with its OWN unrelated placeholder commit —
    // mirrors a freshly-created Shogo project's scaffold.
    writeFileSync(join(localPath, 'App.tsx'), 'placeholder scaffold')
    await gitService.initRepo(localPath, { defaultBranch: 'main' })
    await gitService.commit(localPath, { message: 'Initial commit', author: { name: 'x', email: 'x@x.com' } })

    await gitService.addRemote(localPath, 'origin', remotePath)
    expect(gitService.remoteBranchExists(localPath, 'origin', 'main')).toBe(false) // not fetched yet

    await gitService.fetch(localPath, { remote: 'origin' })
    expect(gitService.remoteBranchExists(localPath, 'origin', 'main')).toBe(true)
  })
})

describe('resetHardToRemote', () => {
  test('discards the local placeholder commit and adopts the remote content exactly (unrelated histories, no merge needed)', async () => {
    writeFileSync(join(remotePath, 'src.txt'), 'real repo content')
    await gitService.initRepo(remotePath, { defaultBranch: 'main' })
    await gitService.commit(remotePath, { message: 'real work', author: { name: 'x', email: 'x@x.com' } })

    writeFileSync(join(localPath, 'App.tsx'), 'placeholder scaffold')
    await gitService.initRepo(localPath, { defaultBranch: 'main' })
    await gitService.commit(localPath, { message: 'Initial commit', author: { name: 'x', email: 'x@x.com' } })

    // Sanity: with genuinely unrelated histories, a plain pull fails —
    // this is the exact failure mode that made the bug visible live.
    await gitService.addRemote(localPath, 'origin', remotePath)
    const failedPull = await gitService.pull(localPath, { remote: 'origin', branch: 'main' })
    expect(failedPull.success).toBe(false)

    await gitService.fetch(localPath, { remote: 'origin' })
    const result = await gitService.resetHardToRemote(localPath, 'origin', 'main')
    expect(result.success).toBe(true)

    // The placeholder file is gone; the remote's real content is present.
    expect(() => readFileSync(join(localPath, 'App.tsx'), 'utf-8')).toThrow()
    expect(readFileSync(join(localPath, 'src.txt'), 'utf-8')).toBe('real repo content')

    const localHead = await gitService.getHeadSha(localPath)
    const remoteHead = await gitService.getHeadSha(remotePath)
    expect(localHead).toBe(remoteHead)
  })

  test('error result (not a throw) when the branch does not exist on the remote', async () => {
    await gitService.initRepo(localPath, { defaultBranch: 'main' })
    await gitService.commit(localPath, { message: 'x', author: { name: 'x', email: 'x@x.com' } })
    const result = await gitService.resetHardToRemote(localPath, 'origin', 'main')
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
