// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Regression tests for the S3-seed leg of project import (runImport).
//
// Pre-2026-05-11: in K8s mode, runImport wrote the imported workspace to
// the API pod's local disk and stopped. The warm-pool runtime pod's
// `S3Sync.downloadAll()` then returned NOT FOUND at
// `s3://${S3_WORKSPACES_BUCKET}/<projectId>/project-src.tar.gz` and
// silently seeded the warm-pool default template, so the user saw an
// empty hello-world instead of their import.
//
// Post-fix: runImport explicitly uploads the workspace to S3 in K8s mode
// and HARD-FAILS the request on upload error (returning ok=false,
// status=500) so the importer surfaces the real problem instead of
// pretending the import succeeded.
//
// What we pin in this file:
//
//   1. Success path: S3Sync is created with the new project's id as
//      prefix, `uploadAll(false)` is called exactly once, the
//      `phase: 'syncToS3'` SSE events are emitted (running then ok), and
//      the import resolves with ok=true.
//
//   2. Failure path: uploadAll() rejects → runImport returns
//      ok=false, status=500, error matches /S3 sync failed/, the
//      `syncToS3 failed` SSE event is emitted, AND the prisma.project
//      row is deleted to roll back the partial import.
//
//   3. Non-K8s path: outside K8s mode, S3Sync is NEVER created so local
//      dev continues to work without S3 wiring.
//
// Run: bun test apps/api/src/routes/__tests__/project-export-import-s3.test.ts

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

// ──────────────────────────────────────────────────────────────────────
// Mocks must be installed BEFORE we import the route module — otherwise
// the import-time bindings (prisma, createS3SyncForProject) capture the
// real modules and our mock.module calls become no-ops.
// ──────────────────────────────────────────────────────────────────────

const prismaState: {
  projects: Map<string, any>
  members: Map<string, any>
  deletedProjectIds: string[]
} = {
  projects: new Map(),
  members: new Map(),
  deletedProjectIds: [],
}

const mockPrisma = {
  member: {
    findFirst: mock(async (_args: any) => ({ id: 'member-1', role: 'admin' })),
  },
  user: {
    findUnique: mock(async () => ({ role: 'admin' })),
  },
  project: {
    create: mock(async ({ data }: any) => {
      const id = `proj_${Math.random().toString(36).slice(2, 10)}`
      const row = { id, ...data, description: data.description ?? null }
      prismaState.projects.set(id, row)
      return row
    }),
    delete: mock(async ({ where }: any) => {
      prismaState.deletedProjectIds.push(where.id)
      prismaState.projects.delete(where.id)
      return { id: where.id }
    }),
  },
  agentConfig: {
    create: mock(async () => ({})),
  },
  chatSession: {
    create: mock(async () => ({ id: 'session-1' })),
  },
  chatMessage: {
    createMany: mock(async () => ({ count: 0 })),
  },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))

// Shared mutable handles so each test can configure the S3 mock behavior.
const s3State: {
  uploadShouldFail: boolean
  factoryReturnsNull: boolean
  createCalls: Array<{ localDir: string; projectId: string }>
  uploadCalls: number
} = {
  uploadShouldFail: false,
  factoryReturnsNull: false,
  createCalls: [],
  uploadCalls: 0,
}

mock.module('@shogo/shared-runtime', () => ({
  createS3SyncForProject: (localDir: string, projectId: string) => {
    s3State.createCalls.push({ localDir, projectId })
    if (s3State.factoryReturnsNull) return null
    return {
      uploadAll: async (_force: boolean) => {
        s3State.uploadCalls++
        if (s3State.uploadShouldFail) {
          throw new Error('simulated s3 error: AccessDenied')
        }
        return {
          downloaded: 0,
          uploaded: 1,
          deleted: 0,
          errors: [],
          lastSync: new Date(),
          archiveSize: 4_242,
        }
      },
    }
  },
  // mock.module replaces the entire module — the route under test also
  // imports isMacOSJunkName/isMacOSJunkPath, so we must re-export them
  // or Bun raises `Export named '…' not found in module` at link time.
  // The test fixtures don't contain AppleDouble (`._foo`) detritus, so a
  // no-op stub is correct.
  isMacOSJunkName: (_name: string) => false,
  isMacOSJunkPath: (_relPath: string) => false,
}))

// Dynamic import AFTER mocks so the route module captures the mocked deps.
const { runImport } = await import('../project-export-import')
import type { ImportEvent } from '../project-export-import' assert { 'resolution-mode': 'import' }

// Helpers ──────────────────────────────────────────────────────────────

function buildBundleZip(opts: { projectName?: string } = {}): Uint8Array {
  const projectJson = {
    version: '1.1',
    project: {
      name: opts.projectName ?? 'Test Imported Project',
      description: 'imported for testing',
      tier: 'starter',
      status: 'draft',
      settings: { activeMode: 'none', canvasMode: 'code', canvasEnabled: false },
      schemas: [],
      accessLevel: 'anyone',
    },
    agentConfig: null,
  }
  return zipSync({
    'project.json': strToU8(JSON.stringify(projectJson)),
    'workspace/package.json': strToU8('{"name":"hello"}\n'),
    'workspace/src/index.ts': strToU8('export const greet = () => "hi"\n'),
  })
}

beforeEach(() => {
  prismaState.projects.clear()
  prismaState.members.clear()
  prismaState.deletedProjectIds = []
  s3State.uploadShouldFail = false
  s3State.factoryReturnsNull = false
  s3State.createCalls = []
  s3State.uploadCalls = 0

  for (const top of Object.values(mockPrisma) as any[]) {
    for (const fn of Object.values(top) as any[]) {
      if (typeof fn?.mockClear === 'function') fn.mockClear()
    }
  }

  // Point WORKSPACES_DIR at a fresh temp dir per test so writes don't
  // collide between runs and don't pollute the repo working tree.
  process.env.WORKSPACES_DIR = mkdtempSync(join(tmpdir(), 'shogo-import-test-'))
})

afterEach(() => {
  if (process.env.WORKSPACES_DIR) {
    rmSync(process.env.WORKSPACES_DIR, { recursive: true, force: true })
  }
  delete process.env.KUBERNETES_SERVICE_HOST
  delete process.env.S3_WORKSPACES_BUCKET
  // Disable the optional local cleanup branch so per-test temp dirs
  // can be inspected if needed (and so we don't muddle the test by
  // having a second filesystem mutation racing the prisma rollback).
  process.env.PURGE_LOCAL_AFTER_S3 = 'false'
})

// Tests ────────────────────────────────────────────────────────────────

describe('runImport — S3 seed (k8s mode)', () => {
  test('success: uploads to S3 with project.id prefix and emits syncToS3 ok event', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '1'
    process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-test'

    const events: ImportEvent[] = []
    const zip = buildBundleZip()

    const result = await runImport(
      zip,
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      (ev) => { events.push(ev) },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return // narrow for TS

    // S3Sync was created exactly once, with the new project's id as prefix.
    expect(s3State.createCalls.length).toBe(1)
    expect(s3State.createCalls[0]!.projectId).toBe(result.project.id)
    // localDir should be the per-project subdir under WORKSPACES_DIR.
    expect(s3State.createCalls[0]!.localDir).toContain(result.project.id)

    // uploadAll(false) called exactly once.
    expect(s3State.uploadCalls).toBe(1)

    // SSE phase events: running then ok.
    const s3Events = events.filter((e) => e.phase === 'syncToS3') as Array<
      Extract<ImportEvent, { phase: 'syncToS3' }>
    >
    expect(s3Events.map((e) => e.status)).toEqual(['running', 'ok'])
    expect(s3Events[1]!.bytes).toBe(4_242)
    expect(typeof s3Events[1]!.durationMs).toBe('number')

    // Project row NOT deleted on success.
    expect(prismaState.deletedProjectIds).toEqual([])
  })

  test('failure: uploadAll rejects → ok=false, status=500, project row rolled back', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '1'
    process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-test'
    s3State.uploadShouldFail = true

    const events: ImportEvent[] = []
    const zip = buildBundleZip({ projectName: 'will-roll-back' })

    const result = await runImport(
      zip,
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      (ev) => { events.push(ev) },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(500)
    expect(result.error).toMatch(/S3 sync failed: simulated s3 error/i)

    // SSE: must have emitted a 'failed' status, not 'ok'.
    const s3Events = events.filter((e) => e.phase === 'syncToS3') as Array<
      Extract<ImportEvent, { phase: 'syncToS3' }>
    >
    expect(s3Events.map((e) => e.status)).toEqual(['running', 'failed'])
    expect(s3Events[1]!.message).toMatch(/simulated s3 error/i)

    // Rollback: the project row created earlier in runImport must be
    // deleted so the user doesn't end up with an unreachable phantom
    // project in their workspace list.
    expect(prismaState.deletedProjectIds.length).toBe(1)
    expect(mockPrisma.project.delete.mock.calls.length).toBe(1)
  })

  test('factory returns null in k8s mode → hard fail (do not pretend it worked)', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '1'
    process.env.S3_WORKSPACES_BUCKET = 'shogo-workspaces-test'
    s3State.factoryReturnsNull = true

    const events: ImportEvent[] = []
    const result = await runImport(
      buildBundleZip(),
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      (ev) => { events.push(ev) },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(500)
    // Project row rolled back.
    expect(prismaState.deletedProjectIds.length).toBe(1)
    // SSE: failed with a config message.
    const s3Events = events.filter((e) => e.phase === 'syncToS3') as Array<
      Extract<ImportEvent, { phase: 'syncToS3' }>
    >
    expect(s3Events[s3Events.length - 1]!.status).toBe('failed')
  })
})

describe('runImport — non-k8s mode (local dev)', () => {
  test('does NOT create S3Sync — local fs writes are sufficient', async () => {
    // Explicitly NOT setting KUBERNETES_SERVICE_HOST.
    process.env.S3_WORKSPACES_BUCKET = 'unused-in-local'

    const result = await runImport(
      buildBundleZip(),
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      () => {},
    )

    expect(result.ok).toBe(true)
    expect(s3State.createCalls.length).toBe(0)
    expect(s3State.uploadCalls).toBe(0)
  })
})

describe('runImport — k8s without bucket env', () => {
  test('emits skipped event with a warning and continues (does NOT roll back)', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '1'
    // S3_WORKSPACES_BUCKET intentionally unset.

    const events: ImportEvent[] = []
    const result = await runImport(
      buildBundleZip(),
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      (ev) => { events.push(ev) },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some((w) => /S3_WORKSPACES_BUCKET/.test(w))).toBe(true)

    const s3Events = events.filter((e) => e.phase === 'syncToS3') as Array<
      Extract<ImportEvent, { phase: 'syncToS3' }>
    >
    expect(s3Events.length).toBe(1)
    expect(s3Events[0]!.status).toBe('skipped')

    // No S3 call attempted, no rollback.
    expect(s3State.createCalls.length).toBe(0)
    expect(prismaState.deletedProjectIds).toEqual([])
  })
})
