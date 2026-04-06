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

const mockPrisma = {
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
    findFirst: async () => findFirstResult,
    findUnique: async () => findUniqueResult,
    findMany: async () => findManyResult,
    deleteMany: async () => deleteManyResult,
  },
  gitHubConnection: {
    findUnique: async () => null,
  },
}

mock.module('../lib/prisma', () => ({
  prisma: mockPrisma,
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
