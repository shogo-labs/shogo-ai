// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Checkpoint Service Tests
 *
 * Tests the checkpoint creation flow end-to-end with mocked Prisma
 * and real temporary git repos.
 *
 * Run: bun test apps/api/src/__tests__/checkpoint-service.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Mock Prisma before importing the service under test
// ---------------------------------------------------------------------------

let createdCheckpoints: any[] = []
let findFirstResult: any = null
let findUniqueResult: any = null
let findManyResult: any[] = []
let deleteManyResult = { count: 0 }
let findManyArgs: any[] = []
let deleteManyArgs: any[] = []
let projectRecord: any = { workingMode: 'managed' }
let gitHubConnectionResult: any = null
let githubConfigured = false
const pushToGitHubCalls: any[] = []

const mockPrisma = {
  project: {
    findUnique: async () => projectRecord,
  },
  projectCheckpoint: {
    create: async ({ data }: any) => {
      const record = {
        id: `ckpt-${createdCheckpoints.length + 1}`,
        ...data,
        createdAt: new Date(),
      }
      createdCheckpoints.push(record)
      return record
    },
    findFirst: async (args: any) => typeof findFirstResult === 'function' ? findFirstResult(args) : findFirstResult,
    findUnique: async (args: any) => typeof findUniqueResult === 'function' ? findUniqueResult(args) : findUniqueResult,
    findMany: async (args: any) => {
      findManyArgs.push(args)
      return findManyResult
    },
    deleteMany: async (args: any) => {
      deleteManyArgs.push(args)
      return deleteManyResult
    },
  },
  gitHubConnection: {
    findUnique: async () => gitHubConnectionResult,
  },
}

mock.module('../lib/prisma', () => ({
  prisma: mockPrisma,
}))

mock.module('../services/github.service', () => ({
  isConfigured: () => githubConfigured,
  pushToGitHub: async (...args: any[]) => {
    pushToGitHubCalls.push(args)
  },
}))

// Must import after mocking
import * as checkpointService from '../services/checkpoint.service'
import * as gitService from '../services/git.service'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let workspacePath: string

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'ckpt-test-'))
  createdCheckpoints = []
  findFirstResult = null
  findUniqueResult = null
  findManyResult = []
  findManyArgs = []
  deleteManyArgs = []
  projectRecord = { workingMode: 'managed' }
  gitHubConnectionResult = null
  githubConfigured = false
  pushToGitHubCalls.length = 0
})

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true })
})

// =============================================================================
// createCheckpoint
// =============================================================================

describe('createCheckpoint', () => {
  test('creates a checkpoint with git commit and DB record', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'content')
    await gitService.initRepo(workspacePath)

    writeFileSync(join(workspacePath, 'new.txt'), 'new content')

    const result = await checkpointService.createCheckpoint({
      projectId: 'proj-1',
      workspacePath,
      message: 'test checkpoint',
    })

    expect(result.commitSha).toHaveLength(40)
    expect(result.message).toBe('test checkpoint')
    expect(result.isAutomatic).toBe(false)

    expect(createdCheckpoints.length).toBeGreaterThanOrEqual(1)
    const dbRecord = createdCheckpoints.find(c => c.commitMessage === 'test checkpoint')
    expect(dbRecord).toBeDefined()
    expect(dbRecord.projectId).toBe('proj-1')
  })

  test('returns existing checkpoint when nothing to commit', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'content')
    await gitService.initRepo(workspacePath)

    const headCommit = await gitService.getCommit(workspacePath, 'HEAD')

    // Simulate an existing checkpoint in the DB for this SHA
    findFirstResult = {
      id: 'existing-ckpt',
      projectId: 'proj-1',
      commitSha: headCommit!.sha,
      commitMessage: 'Initial commit',
      branch: 'main',
      name: null,
      description: null,
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      includesDb: false,
      isAutomatic: false,
      createdAt: new Date(),
    }

    const result = await checkpointService.createCheckpoint({
      projectId: 'proj-1',
      workspacePath,
      message: 'no changes',
    })

    expect(result.id).toBe('existing-ckpt')
    expect(result.commitSha).toBe(headCommit!.sha)
  })

  test('creates DB record for no-change commit when no existing checkpoint', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'content')
    await gitService.initRepo(workspacePath)

    // No existing checkpoint for this SHA
    findFirstResult = null

    const result = await checkpointService.createCheckpoint({
      projectId: 'proj-1',
      workspacePath,
      message: 'snapshot',
    })

    expect(result.commitSha).toHaveLength(40)
    expect(createdCheckpoints.length).toBe(1)
  })

  test('sets isAutomatic flag', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'content')
    await gitService.initRepo(workspacePath)

    writeFileSync(join(workspacePath, 'auto.txt'), 'auto')

    const result = await checkpointService.createCheckpoint({
      projectId: 'proj-1',
      workspacePath,
      message: 'AI: edit_file (1 tool calls)',
      isAutomatic: true,
    })

    expect(result.isAutomatic).toBe(true)
    const dbRecord = createdCheckpoints.find(c => c.isAutomatic === true)
    expect(dbRecord).toBeDefined()
  })

  test('throws for nonexistent workspace', async () => {
    expect(
      checkpointService.createCheckpoint({
        projectId: 'proj-1',
        workspacePath: '/nonexistent/path',
        message: 'should fail',
      })
    ).rejects.toThrow('Workspace not found')
  })

  test('throws typed disabled error for external projects', async () => {
    projectRecord = { workingMode: 'external' }

    await expect(
      checkpointService.createCheckpoint({
        projectId: 'proj-1',
        workspacePath,
        message: 'external should fail',
      })
    ).rejects.toMatchObject({
      name: 'CheckpointsDisabledError',
      code: 'checkpoints_disabled_in_external_mode',
    })
  })

  test('handles special characters in checkpoint messages', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'content')
    await gitService.initRepo(workspacePath)

    writeFileSync(join(workspacePath, 'special.txt'), 'content')

    const result = await checkpointService.createCheckpoint({
      projectId: 'proj-1',
      workspacePath,
      message: 'AI: mcp_$(inject) | edit_file `template` (3 tool calls)',
    })

    expect(result.commitSha).toHaveLength(40)
    expect(result.message).toBe('AI: mcp_$(inject) | edit_file `template` (3 tool calls)')
  })
})

// =============================================================================
// listCheckpoints
// =============================================================================

describe('listCheckpoints', () => {
  test('returns mapped checkpoint results', async () => {
    findManyResult = [
      {
        id: 'ckpt-1',
        projectId: 'proj-1',
        commitSha: 'abc123def456',
        commitMessage: 'checkpoint 1',
        branch: 'main',
        name: 'Named Checkpoint',
        description: 'A description',
        filesChanged: 3,
        additions: 10,
        deletions: 2,
        includesDb: false,
        isAutomatic: false,
        createdAt: new Date('2026-01-01'),
      },
    ]

    const results = await checkpointService.listCheckpoints('proj-1')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('ckpt-1')
    expect(results[0].commitSha).toBe('abc123def456')
    expect(results[0].message).toBe('checkpoint 1')
    expect(results[0].name).toBe('Named Checkpoint')
  })

  test('applies before cursor and limit when listing checkpoints', async () => {
    const beforeDate = new Date('2026-02-02T00:00:00Z')
    findUniqueResult = { id: 'cursor', createdAt: beforeDate }
    findManyResult = []

    await checkpointService.listCheckpoints('proj-1', { limit: 10, before: 'cursor' })

    expect(findManyArgs[0].take).toBe(10)
    expect(findManyArgs[0].where).toEqual({
      projectId: 'proj-1',
      createdAt: { lt: beforeDate },
    })
  })

  test('ignores before cursor when checkpoint is missing', async () => {
    findUniqueResult = null
    findManyResult = []

    await checkpointService.listCheckpoints('proj-1', { before: 'missing' })

    expect(findManyArgs[0].where).toEqual({ projectId: 'proj-1' })
  })
})

// =============================================================================
// getCheckpoint
// =============================================================================

describe('getCheckpoint', () => {
  test('returns null for nonexistent checkpoint', async () => {
    findUniqueResult = null
    const result = await checkpointService.getCheckpoint('nonexistent')
    expect(result).toBeNull()
  })

  test('returns checkpoint details', async () => {
    findUniqueResult = {
      id: 'ckpt-1',
      projectId: 'proj-1',
      commitSha: 'abc123',
      commitMessage: 'test',
      branch: 'main',
      name: null,
      description: null,
      filesChanged: 1,
      additions: 5,
      deletions: 0,
      includesDb: false,
      isAutomatic: true,
      createdAt: new Date(),
    }

    const result = await checkpointService.getCheckpoint('ckpt-1')
    expect(result).not.toBeNull()
    expect(result!.commitSha).toBe('abc123')
    expect(result!.isAutomatic).toBe(true)
  })
})

// =============================================================================
// getCheckpointByCommit
// =============================================================================

describe('getCheckpointByCommit', () => {
  test('returns null when no checkpoint has the commit sha', async () => {
    findFirstResult = null
    expect(await checkpointService.getCheckpointByCommit('proj-1', 'missing-sha')).toBeNull()
  })

  test('returns checkpoint details for a project + commit sha', async () => {
    const createdAt = new Date('2026-03-01T00:00:00Z')
    findFirstResult = {
      id: 'ckpt-sha',
      projectId: 'proj-1',
      commitSha: 'abc123',
      commitMessage: 'by sha',
      branch: 'main',
      name: 'By SHA',
      description: null,
      filesChanged: 2,
      additions: 3,
      deletions: 1,
      includesDb: false,
      isAutomatic: false,
      createdAt,
    }

    const result = await checkpointService.getCheckpointByCommit('proj-1', 'abc123')

    expect(result).toEqual({
      id: 'ckpt-sha',
      commitSha: 'abc123',
      branch: 'main',
      name: 'By SHA',
      description: null,
      message: 'by sha',
      filesChanged: 2,
      additions: 3,
      deletions: 1,
      includesDb: false,
      isAutomatic: false,
      createdAt,
    })
  })
})

// =============================================================================
// rollback guard paths
// =============================================================================

describe('rollback guard paths', () => {
  test('returns an error when checkpoint is missing', async () => {
    findUniqueResult = null

    const result = await checkpointService.rollback({
      projectId: 'proj-1',
      workspacePath,
      checkpointId: 'missing',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Checkpoint not found')
  })

  test('returns an error when checkpoint belongs to a different project', async () => {
    findUniqueResult = {
      id: 'ckpt-other',
      projectId: 'other-project',
      commitSha: 'abc123',
      commitMessage: 'other',
      branch: 'main',
      name: null,
      description: null,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      includesDb: false,
      isAutomatic: false,
      createdAt: new Date(),
    }

    const result = await checkpointService.rollback({
      projectId: 'proj-1',
      workspacePath,
      checkpointId: 'ckpt-other',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Checkpoint does not belong to this project')
  })

  test('returns previous checkpoint details when git checkout fails', async () => {
    const createdAt = new Date('2026-04-01T00:00:00Z')
    findUniqueResult = {
      id: 'ckpt-bad-sha',
      projectId: 'proj-1',
      commitSha: 'definitely-not-a-real-sha',
      commitMessage: 'bad target',
      branch: 'main',
      name: 'Bad target',
      description: 'broken',
      filesChanged: 4,
      additions: 5,
      deletions: 6,
      includesDb: false,
      isAutomatic: false,
      createdAt,
    }

    const result = await checkpointService.rollback({
      projectId: 'proj-1',
      workspacePath,
      checkpointId: 'ckpt-bad-sha',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.previousCheckpoint).toMatchObject({
      id: 'ckpt-bad-sha',
      commitSha: 'definitely-not-a-real-sha',
      message: 'bad target',
      filesChanged: 4,
      additions: 5,
      deletions: 6,
      createdAt,
    })
  })
})

// =============================================================================
// getDiff
// =============================================================================

describe('getDiff', () => {
  test('returns null when source checkpoint is missing', async () => {
    findUniqueResult = null
    expect(await checkpointService.getDiff(workspacePath, 'missing')).toBeNull()
  })

  test('returns git diff between two checkpoints', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'one\n')
    await gitService.initRepo(workspacePath)
    const first = await gitService.getCommit(workspacePath, 'HEAD')

    writeFileSync(join(workspacePath, 'file.txt'), 'one\ntwo\n')
    const second = await gitService.commit(workspacePath, { message: 'second' })

    findUniqueResult = ({ where }: any) => {
      if (where.id === 'from') {
        return {
          id: 'from',
          commitSha: first!.sha,
        }
      }
      if (where.id === 'to') {
        return {
          id: 'to',
          commitSha: second!.sha,
        }
      }
      return null
    }

    const diff = await checkpointService.getDiff(workspacePath, 'from', 'to')

    expect(diff).not.toBeNull()
    expect(diff!.checkpointId).toBe('from')
    expect(diff!.commitSha).toBe(first!.sha)
    expect(diff!.totalAdditions).toBeGreaterThanOrEqual(1)
    expect(diff!.files.some((f) => f.path === 'file.txt')).toBe(true)
  })
})

// =============================================================================
// ensureGitRepo
// =============================================================================

describe('ensureGitRepo', () => {
  test('initializes git repo in existing directory', async () => {
    writeFileSync(join(workspacePath, 'file.txt'), 'content')
    await checkpointService.ensureGitRepo(workspacePath)
    expect(gitService.isGitRepo(workspacePath)).toBe(true)
  })

  test('creates directory if it does not exist', async () => {
    const newPath = join(workspacePath, 'subdir', 'nested')
    await checkpointService.ensureGitRepo(newPath)
    expect(gitService.isGitRepo(newPath)).toBe(true)
  })
})

// =============================================================================
// pruneCheckpoints
// =============================================================================

describe('pruneCheckpoints', () => {
  test('returns 0 when checkpoint count is within keepCount', async () => {
    findManyResult = [
      { id: 'one', createdAt: new Date(), name: null },
      { id: 'two', createdAt: new Date(), name: null },
    ]

    const pruned = await checkpointService.pruneCheckpoints('proj-1', { keepCount: 5 })

    expect(pruned).toBe(0)
    expect(deleteManyArgs).toHaveLength(0)
  })

  test('deletes checkpoints beyond keepCount while preserving recent named checkpoints', async () => {
    const now = new Date()
    const old = new Date('2020-01-01T00:00:00Z')
    findManyResult = [
      { id: 'keep-newest', createdAt: now, name: null },
      { id: 'keep-named-recent', createdAt: now, name: 'Release' },
      { id: 'delete-old-1', createdAt: old, name: null },
      { id: 'delete-old-2', createdAt: old, name: 'Old named' },
    ]

    const pruned = await checkpointService.pruneCheckpoints('proj-1', {
      keepCount: 1,
      keepDays: 30,
    })

    expect(pruned).toBe(2)
    expect(deleteManyArgs[0].where.id.in).toEqual(['delete-old-1', 'delete-old-2'])
  })

  test('returns 0 when all overflow checkpoints are named and still within retention', async () => {
    const now = new Date()
    findManyResult = [
      { id: 'keep-newest', createdAt: now, name: null },
      { id: 'keep-named', createdAt: now, name: 'Milestone' },
    ]

    const pruned = await checkpointService.pruneCheckpoints('proj-1', {
      keepCount: 1,
      keepDays: 30,
    })

    expect(pruned).toBe(0)
    expect(deleteManyArgs).toHaveLength(0)
  })
})

// =============================================================================
// syncAfterCheckpoint
// =============================================================================

describe('syncAfterCheckpoint', () => {
  test('skips when no GitHub connection, sync disabled, or app not configured', async () => {
    await checkpointService.syncAfterCheckpoint('proj-1', workspacePath)
    expect(pushToGitHubCalls).toHaveLength(0)

    gitHubConnectionResult = { projectId: 'proj-1', syncEnabled: false }
    await checkpointService.syncAfterCheckpoint('proj-1', workspacePath)
    expect(pushToGitHubCalls).toHaveLength(0)

    gitHubConnectionResult = { projectId: 'proj-1', syncEnabled: true }
    githubConfigured = false
    await checkpointService.syncAfterCheckpoint('proj-1', workspacePath)
    expect(pushToGitHubCalls).toHaveLength(0)
  })

  test('pushes to GitHub when sync is enabled and GitHub is configured', async () => {
    gitHubConnectionResult = { projectId: 'proj-1', syncEnabled: true }
    githubConfigured = true

    await checkpointService.syncAfterCheckpoint('proj-1', workspacePath)

    expect(pushToGitHubCalls).toEqual([['proj-1', workspacePath]])
  })
})
