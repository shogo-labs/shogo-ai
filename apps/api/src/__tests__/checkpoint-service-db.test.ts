// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Database snapshot/restore coverage for checkpoint.service.ts.
 *
 * Kept separate from checkpoint-service.test.ts because this file mocks
 * child_process before importing the service, letting us exercise the
 * private pg_dump/psql helpers through public createCheckpoint/rollback calls.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let execCalls: Array<{ command: string; env?: NodeJS.ProcessEnv }> = []
let execImpl: (command: string, opts?: any) => Buffer | string = () => Buffer.from('')

mock.module('child_process', () => ({
  execSync: (command: string, opts?: any) => {
    execCalls.push({ command, env: opts?.env })
    return execImpl(command, opts)
  },
}))

const checkpointRows: any[] = []
let checkpointFindUnique: any = null

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async () => ({ workingMode: 'managed' }),
    },
    projectCheckpoint: {
      create: async ({ data }: any) => {
        const row = {
          id: `ckpt-${checkpointRows.length + 1}`,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          ...data,
        }
        checkpointRows.push(row)
        return row
      },
      findFirst: async () => null,
      findUnique: async () => checkpointFindUnique,
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
    gitHubConnection: {
      findUnique: async () => null,
    },
  },
}))

let gitStatusHasChanges = false
let checkoutResult = { success: true as const }
let commitCount = 0

mock.module('../services/git.service', () => ({
  initRepo: async () => ({ branch: 'main' }),
  commit: async () => {
    commitCount += 1
    return {
      sha: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${commitCount}`,
      message: `commit ${commitCount}`,
      filesChanged: 1,
      additions: 2,
      deletions: 0,
    }
  },
  getCommit: async () => null,
  saveCheckpointMetadata: async () => {},
  getStatus: async () => ({ hasChanges: gitStatusHasChanges }),
  checkout: async () => checkoutResult,
  getDiff: async () => ({ files: [], totalAdditions: 0, totalDeletions: 0 }),
}))

import { createCheckpoint, rollback } from '../services/checkpoint.service'

let workspacePath: string
const ENV_KEYS = ['DATABASE_URL', 'PROJECTS_DATABASE_URL'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  workspacePath = join(tmpdir(), `ckpt-db-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(workspacePath, { recursive: true })
  execCalls = []
  execImpl = () => Buffer.from('')
  checkpointRows.length = 0
  checkpointFindUnique = null
  gitStatusHasChanges = false
  checkoutResult = { success: true }
  commitCount = 0
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  rmSync(workspacePath, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('createCheckpoint database snapshots', () => {
  test('includeDatabase skips pg_dump when no database URL is configured', async () => {
    const result = await createCheckpoint({
      projectId: 'proj-1',
      workspacePath,
      message: 'snapshot without db env',
      includeDatabase: true,
    })

    expect(result.includesDb).toBe(true)
    expect(execCalls).toHaveLength(0)
  })

  test('includeDatabase runs pg_dump with parsed connection env', async () => {
    process.env.DATABASE_URL = 'postgres://dbuser:dbpass@db.example.com:6543/projectdb'

    await createCheckpoint({
      projectId: 'proj-1',
      workspacePath,
      message: 'snapshot with db env',
      includeDatabase: true,
    })

    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].command).toContain('pg_dump projectdb')
    expect(execCalls[0].command).toContain('.shogo/database.sql.gz')
    expect(execCalls[0].env?.PGHOST).toBe('db.example.com')
    expect(execCalls[0].env?.PGPORT).toBe('6543')
    expect(execCalls[0].env?.PGUSER).toBe('dbuser')
    expect(execCalls[0].env?.PGPASSWORD).toBe('dbpass')
  })

  test('includeDatabase propagates pg_dump failures and removes partial snapshot', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost/db'
    execImpl = () => {
      writeFileSync(join(workspacePath, '.shogo', 'database.sql.gz'), 'partial')
      throw new Error('pg_dump failed')
    }

    await expect(createCheckpoint({
      projectId: 'proj-1',
      workspacePath,
      message: 'broken db snapshot',
      includeDatabase: true,
    })).rejects.toThrow('pg_dump failed')

    expect(existsSync(join(workspacePath, '.shogo', 'database.sql.gz'))).toBe(false)
  })
})

describe('rollback database restore', () => {
  test('includeDatabase skips restore when snapshot file is absent', async () => {
    checkpointFindUnique = {
      id: 'ckpt-db',
      projectId: 'proj-1',
      commitSha: 'abc123def456',
      commitMessage: 'with db',
      branch: 'main',
      name: 'With DB',
      description: null,
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      includesDb: true,
      isAutomatic: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }

    const result = await rollback({
      projectId: 'proj-1',
      workspacePath,
      checkpointId: 'ckpt-db',
      includeDatabase: true,
    })

    expect(result.success).toBe(true)
    expect(execCalls.some((call) => call.command.includes('psql'))).toBe(false)
  })

  test('includeDatabase restores database snapshot when file and DB URL are present', async () => {
    checkpointFindUnique = {
      id: 'ckpt-db',
      projectId: 'proj-1',
      commitSha: 'abc123def456',
      commitMessage: 'with db',
      branch: 'main',
      name: null,
      description: null,
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      includesDb: true,
      isAutomatic: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }
    mkdirSync(join(workspacePath, '.shogo'), { recursive: true })
    writeFileSync(join(workspacePath, '.shogo', 'database.sql.gz'), 'gzipped')
    process.env.PROJECTS_DATABASE_URL = 'postgres://restore:secret@db.internal/restored'

    const result = await rollback({
      projectId: 'proj-1',
      workspacePath,
      checkpointId: 'ckpt-db',
      includeDatabase: true,
    })

    expect(result.success).toBe(true)
    const restoreCall = execCalls.find((call) => call.command.includes('psql'))
    expect(restoreCall).toBeDefined()
    expect(restoreCall!.command).toContain('gunzip -c')
    expect(restoreCall!.env?.PGDATABASE).toBe('restored')
    expect(restoreCall!.env?.PGUSER).toBe('restore')
  })
})
