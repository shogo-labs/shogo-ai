// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Git Service Tests
 *
 * Tests the low-level git operations used by the checkpoint system.
 * Uses real temporary git repos to validate correctness.
 *
 * Run: bun test apps/api/src/__tests__/git-service.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import * as gitService from '../services/git.service'

let workspacePath: string

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'git-test-'))
})

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true })
})

// =============================================================================
// initRepo
// =============================================================================

describe('initRepo', () => {
  test('creates a git repo with correct config', async () => {
    writeFileSync(join(workspacePath, 'hello.txt'), 'world')

    const result = await gitService.initRepo(workspacePath)
    expect(result.created).toBe(true)
    expect(result.branch).toBe('main')
    expect(gitService.isGitRepo(workspacePath)).toBe(true)
  })

  test('returns created=false for existing repo', async () => {
    writeFileSync(join(workspacePath, 'hello.txt'), 'world')
    await gitService.initRepo(workspacePath)

    const result = await gitService.initRepo(workspacePath)
    expect(result.created).toBe(false)
    expect(result.branch).toBe('main')
  })

  test('uses custom default branch', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'content')
    const result = await gitService.initRepo(workspacePath, { defaultBranch: 'develop' })
    expect(result.branch).toBe('develop')
  })
})

// =============================================================================
// commit
// =============================================================================

describe('commit', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'initial.txt'), 'initial')
    await gitService.initRepo(workspacePath)
  })

  test('commits new files and returns metadata', async () => {
    writeFileSync(join(workspacePath, 'new-file.txt'), 'new content')

    const result = await gitService.commit(workspacePath, {
      message: 'add new file',
    })

    expect(result).not.toBeNull()
    expect(result!.sha).toHaveLength(40)
    expect(result!.message).toBe('add new file')
    expect(result!.filesChanged).toBeGreaterThan(0)
  })

  test('returns null when nothing to commit', async () => {
    const result = await gitService.commit(workspacePath, {
      message: 'empty commit',
    })
    expect(result).toBeNull()
  })

  test('handles commit messages with pipe characters', async () => {
    writeFileSync(join(workspacePath, 'pipe.txt'), 'content')
    const result = await gitService.commit(workspacePath, {
      message: 'feat: support A | B | C',
    })

    expect(result).not.toBeNull()
    expect(result!.message).toBe('feat: support A | B | C')
  })

  test('handles commit messages with backticks', async () => {
    writeFileSync(join(workspacePath, 'backtick.txt'), 'content')
    const result = await gitService.commit(workspacePath, {
      message: 'fix: handle `template` literals',
    })

    expect(result).not.toBeNull()
    expect(result!.message).toBe('fix: handle `template` literals')
  })

  test('handles commit messages with $() shell expansion syntax', async () => {
    writeFileSync(join(workspacePath, 'shell.txt'), 'content')
    const result = await gitService.commit(workspacePath, {
      message: 'AI: mcp_$(evil) write_file (2 tool calls)',
    })

    expect(result).not.toBeNull()
    expect(result!.message).toBe('AI: mcp_$(evil) write_file (2 tool calls)')
  })

  test('handles commit messages with double quotes', async () => {
    writeFileSync(join(workspacePath, 'quotes.txt'), 'content')
    const result = await gitService.commit(workspacePath, {
      message: 'Rollback to "Pre-deploy snapshot"',
    })

    expect(result).not.toBeNull()
    expect(result!.message).toBe('Rollback to "Pre-deploy snapshot"')
  })

  test('handles commit messages with single quotes', async () => {
    writeFileSync(join(workspacePath, 'squote.txt'), 'content')
    const result = await gitService.commit(workspacePath, {
      message: "fix: don't break on edge case",
    })

    expect(result).not.toBeNull()
    expect(result!.message).toBe("fix: don't break on edge case")
  })

  test('handles commit messages with ${} variable expansion', async () => {
    writeFileSync(join(workspacePath, 'var.txt'), 'content')
    const result = await gitService.commit(workspacePath, {
      message: 'AI: ${HOME} ${PATH} injection test',
    })

    expect(result).not.toBeNull()
    expect(result!.message).toBe('AI: ${HOME} ${PATH} injection test')
  })

  test('commits with author override', async () => {
    writeFileSync(join(workspacePath, 'authored.txt'), 'content')
    const result = await gitService.commit(workspacePath, {
      message: 'authored commit',
      author: 'Test User',
      email: 'test@example.com',
    })

    expect(result).not.toBeNull()
    expect(result!.author).toBe('Test User')
    expect(result!.authorEmail).toBe('test@example.com')
  })

  test('handles includeUntracked=false', async () => {
    // Create a tracked file and modify it
    writeFileSync(join(workspacePath, 'tracked.txt'), 'modified')
    await gitService.commit(workspacePath, { message: 'track it' })
    writeFileSync(join(workspacePath, 'tracked.txt'), 'modified again')

    // Also create an untracked file
    writeFileSync(join(workspacePath, 'untracked.txt'), 'new')

    const result = await gitService.commit(workspacePath, {
      message: 'tracked only',
      includeUntracked: false,
    })

    expect(result).not.toBeNull()

    // Untracked file should still be untracked
    const status = await gitService.getStatus(workspacePath)
    expect(status.untracked).toContain('untracked.txt')
  })
})

// =============================================================================
// getCommit
// =============================================================================

describe('getCommit', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'initial.txt'), 'initial')
    await gitService.initRepo(workspacePath)
  })

  test('returns commit details for HEAD', async () => {
    const commit = await gitService.getCommit(workspacePath, 'HEAD')

    expect(commit).not.toBeNull()
    expect(commit!.sha).toHaveLength(40)
    expect(commit!.shortSha).toHaveLength(7)
    expect(commit!.message).toBe('Initial commit')
    expect(commit!.author).toBe('Shogo AI')
    expect(commit!.authorEmail).toBe('ai@shogo.dev')
    expect(commit!.date).toBeInstanceOf(Date)
    expect(commit!.date.getTime()).not.toBeNaN()
  })

  test('parses message with pipe characters correctly', async () => {
    writeFileSync(join(workspacePath, 'pipe.txt'), 'x')
    await gitService.commit(workspacePath, {
      message: 'feat: A | B | C | D',
    })

    const commit = await gitService.getCommit(workspacePath, 'HEAD')
    expect(commit!.message).toBe('feat: A | B | C | D')
    expect(commit!.author).toBe('Shogo AI')
    expect(commit!.authorEmail).toBe('ai@shogo.dev')
    expect(commit!.date.getTime()).not.toBeNaN()
  })

  test('returns null for nonexistent ref', async () => {
    const commit = await gitService.getCommit(workspacePath, 'nonexistent-ref')
    expect(commit).toBeNull()
  })

  test('returns file stats for commits with changes', async () => {
    writeFileSync(join(workspacePath, 'stats.txt'), 'line1\nline2\nline3\n')
    await gitService.commit(workspacePath, { message: 'add stats file' })

    const commit = await gitService.getCommit(workspacePath, 'HEAD')
    expect(commit!.filesChanged).toBe(1)
    expect(commit!.additions).toBe(3)
  })
})

// =============================================================================
// getStatus
// =============================================================================

describe('getStatus', () => {
  test('returns isRepo=false for non-repo', async () => {
    const status = await gitService.getStatus(workspacePath)
    expect(status.isRepo).toBe(false)
    expect(status.hasChanges).toBe(false)
  })

  test('detects untracked files', async () => {
    await gitService.initRepo(workspacePath)
    writeFileSync(join(workspacePath, 'new.txt'), 'new')

    const status = await gitService.getStatus(workspacePath)
    expect(status.isRepo).toBe(true)
    expect(status.untracked).toContain('new.txt')
    expect(status.hasChanges).toBe(true)
  })

  test('detects modified files', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'original')
    await gitService.initRepo(workspacePath)

    writeFileSync(join(workspacePath, 'file.txt'), 'modified')

    const status = await gitService.getStatus(workspacePath)
    expect(status.modified).toContain('file.txt')
    expect(status.hasChanges).toBe(true)
  })

  test('detects staged files', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'original')
    await gitService.initRepo(workspacePath)

    writeFileSync(join(workspacePath, 'staged.txt'), 'staged content')
    const { execFileSync } = require('child_process')
    execFileSync('git', ['add', 'staged.txt'], { cwd: workspacePath, stdio: 'pipe' })

    const status = await gitService.getStatus(workspacePath)
    expect(status.staged).toContain('staged.txt')
    expect(status.hasChanges).toBe(true)
  })

  test('reports no changes on clean repo', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'content')
    await gitService.initRepo(workspacePath)

    const status = await gitService.getStatus(workspacePath)
    expect(status.hasChanges).toBe(false)
    expect(status.staged).toHaveLength(0)
    expect(status.modified).toHaveLength(0)
    expect(status.untracked).toHaveLength(0)
  })
})

// =============================================================================
// getHistory
// =============================================================================

describe('getHistory', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'initial.txt'), 'initial')
    await gitService.initRepo(workspacePath)
  })

  test('returns commit history', async () => {
    writeFileSync(join(workspacePath, 'a.txt'), 'a')
    await gitService.commit(workspacePath, { message: 'commit A' })

    writeFileSync(join(workspacePath, 'b.txt'), 'b')
    await gitService.commit(workspacePath, { message: 'commit B' })

    const history = await gitService.getHistory(workspacePath)
    expect(history.length).toBe(3) // Initial + A + B
    expect(history[0].message).toBe('commit B')
    expect(history[1].message).toBe('commit A')
    expect(history[2].message).toBe('Initial commit')
  })

  test('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(workspacePath, `file-${i}.txt`), `content-${i}`)
      await gitService.commit(workspacePath, { message: `commit ${i}` })
    }

    const history = await gitService.getHistory(workspacePath, { limit: 2 })
    expect(history.length).toBe(2)
  })

  test('handles pipe characters in commit messages', async () => {
    writeFileSync(join(workspacePath, 'pipe.txt'), 'x')
    await gitService.commit(workspacePath, { message: 'A | B | C' })

    const history = await gitService.getHistory(workspacePath, { limit: 1 })
    expect(history[0].message).toBe('A | B | C')
    expect(history[0].sha).toHaveLength(40)
    expect(history[0].date.getTime()).not.toBeNaN()
  })
})

// =============================================================================
// getDiff
// =============================================================================

describe('getDiff', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'initial.txt'), 'initial')
    await gitService.initRepo(workspacePath)
  })

  test('returns diff between two commits', async () => {
    const beforeSha = (await gitService.getCommit(workspacePath, 'HEAD'))!.sha

    writeFileSync(join(workspacePath, 'added.txt'), 'new file\nwith lines\n')
    writeFileSync(join(workspacePath, 'initial.txt'), 'modified')
    await gitService.commit(workspacePath, { message: 'changes' })

    const diff = await gitService.getDiff(workspacePath, beforeSha, 'HEAD')

    expect(diff.files.length).toBe(2)
    expect(diff.totalAdditions).toBeGreaterThan(0)

    const addedFile = diff.files.find(f => f.path === 'added.txt')
    expect(addedFile).toBeDefined()
    expect(addedFile!.status).toBe('added')

    const modifiedFile = diff.files.find(f => f.path === 'initial.txt')
    expect(modifiedFile).toBeDefined()
    expect(modifiedFile!.status).toBe('modified')
  })

  test('returns empty diff for identical refs', async () => {
    const sha = (await gitService.getCommit(workspacePath, 'HEAD'))!.sha
    const diff = await gitService.getDiff(workspacePath, sha, sha)
    expect(diff.files).toHaveLength(0)
    expect(diff.totalAdditions).toBe(0)
    expect(diff.totalDeletions).toBe(0)
  })

  test('detects deleted files', async () => {
    const beforeSha = (await gitService.getCommit(workspacePath, 'HEAD'))!.sha

    unlinkSync(join(workspacePath, 'initial.txt'))
    await gitService.commit(workspacePath, { message: 'delete file' })

    const diff = await gitService.getDiff(workspacePath, beforeSha, 'HEAD')
    const deleted = diff.files.find(f => f.path === 'initial.txt')
    expect(deleted).toBeDefined()
    expect(deleted!.status).toBe('deleted')
  })
})

// =============================================================================
// checkout
// =============================================================================

describe('checkout', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'initial.txt'), 'initial')
    await gitService.initRepo(workspacePath)
  })

  test('checks out a previous commit', async () => {
    const firstSha = (await gitService.getCommit(workspacePath, 'HEAD'))!.sha

    writeFileSync(join(workspacePath, 'new.txt'), 'content')
    await gitService.commit(workspacePath, { message: 'second' })

    // Checkout the first commit
    const result = await gitService.checkout(workspacePath, firstSha, { force: true })
    expect(result.success).toBe(true)

    // new.txt should not exist at the first commit
    const { existsSync } = require('fs')
    expect(existsSync(join(workspacePath, 'new.txt'))).toBe(false)
  })

  test('creates a new branch on checkout', async () => {
    const result = await gitService.checkout(workspacePath, 'HEAD', {
      createBranch: 'feature-branch',
    })
    expect(result.success).toBe(true)
    expect(result.branch).toBe('feature-branch')
  })

  test('returns error for invalid ref', async () => {
    const result = await gitService.checkout(workspacePath, 'nonexistent-branch-abc123')
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})

// =============================================================================
// branch operations
// =============================================================================

describe('branch operations', () => {
  beforeEach(async () => {
    writeFileSync(join(workspacePath, 'initial.txt'), 'initial')
    await gitService.initRepo(workspacePath)
  })

  test('createBranch creates and checks out new branch', async () => {
    const result = await gitService.createBranch(workspacePath, 'new-branch')
    expect(result.success).toBe(true)

    const branch = await gitService.getCurrentBranch(workspacePath)
    expect(branch).toBe('new-branch')
  })

  test('listBranches returns all branches', async () => {
    await gitService.createBranch(workspacePath, 'branch-a', { checkout: false })
    await gitService.createBranch(workspacePath, 'branch-b', { checkout: false })

    const branches = await gitService.listBranches(workspacePath)
    const names = branches.map(b => b.name)
    expect(names).toContain('main')
    expect(names).toContain('branch-a')
    expect(names).toContain('branch-b')

    const current = branches.find(b => b.isCurrent)
    expect(current?.name).toBe('main')
  })
})

// =============================================================================
// checkpoint metadata
// =============================================================================

describe('checkpoint metadata', () => {
  test('saves and reads checkpoint metadata', async () => {
    const metadata = {
      id: 'test-123',
      name: 'Test Checkpoint',
      description: 'A test',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: 'user-1',
      includesDb: false,
    }

    await gitService.saveCheckpointMetadata(workspacePath, metadata)
    const read = await gitService.readCheckpointMetadata(workspacePath)

    expect(read).not.toBeNull()
    expect(read!.id).toBe('test-123')
    expect(read!.name).toBe('Test Checkpoint')
    expect(read!.includesDb).toBe(false)
  })

  test('returns null when no metadata exists', async () => {
    const read = await gitService.readCheckpointMetadata(workspacePath)
    expect(read).toBeNull()
  })
})
