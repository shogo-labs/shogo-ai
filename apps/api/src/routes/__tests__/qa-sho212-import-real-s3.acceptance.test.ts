// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// QA acceptance (SHO-212) — the k8s import's S3 seed must actually write
// `<projectId>/project-src.tar.gz`, through the REAL `S3Sync`.
//
// `project-export-import-s3.test.ts` replaces `createS3SyncForProject` with a
// stub whose `uploadAll` always resolves, so it can only pin the *argument* the
// route passes — never the outcome the user sees. This file leaves
// `@shogo/shared-runtime` real and fakes only the AWS SDK, so `runImport` runs
// the exact code that refused the write in production (#1245's lineage guard).
//
// What this pins:
//   1. Import succeeds on a k8s API with a bucket: `syncToS3` reports ok and the
//      archive exists at `<projectId>/project-src.tar.gz` carrying the imported
//      files (i.e. the project can actually open from S3).
//   2. A real S3 failure still rolls the project row back with a 500 — the fix
//      must not have turned the hard failure into a silent success.
//   3. The lineage guard is still armed for every other caller: a fresh
//      instance created the way agent-runtime creates one (no option) still
//      refuses to overwrite the archive.
//
// Run: bun test apps/api/src/routes/__tests__/qa-sho212-import-real-s3.acceptance.test.ts

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'

// ──────────────────────────────────────────────────────────────────────
// Fake S3 — installed before any import of @shogo/shared-runtime so the
// real S3Sync talks to the in-memory store.
// ──────────────────────────────────────────────────────────────────────

const BUCKET = 'shogo-workspaces-staging'
const s3Store = new Map<string, Buffer>()
const s3State: { putError: string | null } = { putError: null }

class StubS3Error extends Error {
  name: string
  $metadata: Record<string, any>
  constructor(name: string, statusCode: number) {
    super(name)
    this.name = name
    this.$metadata = { httpStatusCode: statusCode }
  }
}

function etagOf(buf: Buffer): string {
  return `"${createHash('md5').update(buf).digest('hex')}"`
}

class MockS3Client {
  constructor(_opts: any) {}
  async send(cmd: any): Promise<any> {
    // Real command instances carry their args on `.input` and their kind in the
    // class name; keep `__type` support so either shape works.
    const type: string = cmd.__type ?? String(cmd.constructor?.name ?? '').replace(/Command$/, '')
    const { Bucket, Key, Body, IfMatch, IfNoneMatch } = cmd.input ?? cmd
    switch (type) {
      case 'HeadObject': {
        const v = s3Store.get(`${Bucket}/${Key}`)
        if (!v) throw new StubS3Error('NotFound', 404)
        return { ETag: etagOf(v) }
      }
      case 'GetObject': {
        const v = s3Store.get(`${Bucket}/${Key}`)
        if (!v) throw new StubS3Error('NoSuchKey', 404)
        return {
          ContentLength: v.length,
          ETag: etagOf(v),
          Body: {
            transformToByteArray: async () => v,
            transformToString: async () => v.toString('utf-8'),
          },
        }
      }
      case 'PutObject': {
        if (s3State.putError) throw new StubS3Error(s3State.putError, 403)
        const buf = Buffer.from(Body)
        // S3's real precondition semantics: 412 and the object is untouched.
        const current = s3Store.get(`${Bucket}/${Key}`)
        if (IfNoneMatch === '*' && current) throw new StubS3Error('PreconditionFailed', 412)
        if (IfMatch && (!current || etagOf(current) !== IfMatch)) {
          throw new StubS3Error('PreconditionFailed', 412)
        }
        s3Store.set(`${Bucket}/${Key}`, buf)
        return { ETag: etagOf(buf) }
      }
      case 'DeleteObject': {
        s3Store.delete(`${Bucket}/${Key}`)
        return {}
      }
      case 'ListObjectsV2': {
        const prefix = `${Bucket}/${Key ?? ''}`
        const keys = [...s3Store.keys()].filter((k) => k.startsWith(prefix))
        return {
          Contents: keys.map((k) => ({ Key: k.slice(BUCKET.length + 1), Size: s3Store.get(k)!.length })),
          IsTruncated: false,
        }
      }
      default:
        throw new Error(`MockS3Client: unhandled command ${type}`)
    }
  }
}

// Spread the real module so every command class shared-runtime imports stays
// available (`mock.module` replaces the whole module and a missing named export
// fails at link time); only the client that talks to the network is replaced.
const actualS3 = await import('@aws-sdk/client-s3')
mock.module('@aws-sdk/client-s3', () => ({ ...actualS3, S3Client: MockS3Client }))

// ──────────────────────────────────────────────────────────────────────
// Prisma + billing stubs (the route's non-S3 dependencies)
// ──────────────────────────────────────────────────────────────────────

const prismaState: {
  projects: Map<string, any>
  deletedProjectIds: string[]
} = { projects: new Map(), deletedProjectIds: [] }

const mockPrisma = {
  member: {
    findFirst: mock(async (_args: any) => ({ id: 'member-1', role: 'admin' })),
    findMany: mock(async (_args: any) => [{ role: 'admin', projectId: null, isBillingAdmin: false }]),
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
  agentConfig: { create: mock(async () => ({})) },
  chatSession: { create: mock(async () => ({ id: 'session-1' })) },
  chatMessage: { createMany: mock(async () => ({ count: 0 })) },
}

mock.module('../../lib/prisma', () => ({ prisma: mockPrisma }))

mock.module('../../services/billing.service', () => ({
  hasAdvancedModelAccess: async (_workspaceId: string) => false,
  canRunTechStackOnInstanceSize: async (_workspaceId: string, _techStackId: string | null | undefined) => ({
    allowed: true,
    currentSize: 'micro',
    requiredSize: null,
  }),
}))

// Real `S3Sync` — the whole point of this file.
//
// `apps/api/bunfig.toml` preloads `preload-sdk-mocks.ts`, which replaces
// `@shogo/shared-runtime` with a stub whose `createS3SyncForProject` has no
// `uploadAll` at all. That stub is why the missing option was never visible to
// an API test. Load the real module by path (a specifier the preload does not
// mock) and re-point the package name at it before importing the route.
const realS3Sync = await import('../../../../../packages/shared-runtime/src/s3-sync')

mock.module('@shogo/shared-runtime', () => ({
  ...realS3Sync,
  // None of these fixtures declare a docker-class stack, so the route's tier
  // gate short-circuits; the junk helpers are irrelevant to the bundle.
  getMinimumInstanceSize: (_techStackId?: string | null) => null,
  isMacOSJunkName: (_name: string) => false,
  isMacOSJunkPath: (_relPath: string) => false,
}))

const { runImport } = await import('../project-export-import')
import type { ImportEvent } from '../project-export-import' assert { 'resolution-mode': 'import' }
const { createS3SyncForProject } = realS3Sync

// Helpers ──────────────────────────────────────────────────────────────

function buildBundleZip(): Uint8Array {
  const projectJson = {
    version: '1.1',
    project: {
      name: 'QA Imported Project',
      description: 'imported by the SHO-212 acceptance test',
      tier: 'starter',
      status: 'draft',
      settings: { activeMode: 'none', canvasEnabled: false },
      schemas: [],
      accessLevel: 'anyone',
    },
    agentConfig: null,
  }
  return zipSync({
    'project.json': strToU8(JSON.stringify(projectJson)),
    'workspace/package.json': strToU8('{"name":"qa-imported"}\n'),
    'workspace/src/index.ts': strToU8('export const greet = () => "imported"\n'),
  })
}

function withTempArchive<T>(buf: Buffer, fn: (file: string) => T): T {
  const file = join(tmpdir(), `sho212-${process.pid}-${Math.random().toString(36).slice(2)}.tar.gz`)
  writeFileSync(file, buf)
  try {
    return fn(file)
  } finally {
    rmSync(file, { force: true })
  }
}

function archiveEntries(buf: Buffer): string[] {
  return withTempArchive(buf, (file) => {
    const res = spawnSync('tar', ['-tzf', file], { encoding: 'utf-8' })
    expect(res.status).toBe(0)
    return (res.stdout ?? '').split('\n').filter(Boolean)
  })
}

function archiveFile(buf: Buffer, entry: string): string {
  return withTempArchive(buf, (file) => {
    const res = spawnSync('tar', ['-xzOf', file, entry], { encoding: 'utf-8' })
    expect(res.status).toBe(0)
    return res.stdout ?? ''
  })
}

beforeEach(() => {
  s3Store.clear()
  s3State.putError = null
  prismaState.projects.clear()
  prismaState.deletedProjectIds = []
  for (const top of Object.values(mockPrisma) as any[]) {
    for (const fn of Object.values(top) as any[]) {
      if (typeof fn?.mockClear === 'function') fn.mockClear()
    }
  }

  process.env.KUBERNETES_SERVICE_HOST = '1'
  process.env.S3_WORKSPACES_BUCKET = BUCKET
  process.env.WORKSPACES_DIR = mkdtempSync(join(tmpdir(), 'sho212-import-'))
  // Keep the imported tree on disk so we can re-read it after the seed.
  process.env.PURGE_LOCAL_AFTER_S3 = 'false'
})

afterEach(() => {
  if (process.env.WORKSPACES_DIR) {
    rmSync(process.env.WORKSPACES_DIR, { recursive: true, force: true })
  }
  delete process.env.KUBERNETES_SERVICE_HOST
  delete process.env.S3_WORKSPACES_BUCKET
  delete process.env.WORKSPACES_DIR
})

// Tests ────────────────────────────────────────────────────────────────

describe('SHO-212 — k8s import seeds project-src.tar.gz through the real S3Sync', () => {
  test('import succeeds and the archive holds the imported files', async () => {
    const events: ImportEvent[] = []

    const result = await runImport(
      buildBundleZip(),
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      (ev) => { events.push(ev) },
    )

    // This is the assertion that failed in production before the fix:
    // result was ok=false / 500 with "S3 sync failed: refusing to write …".
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`import failed: ${result.error}`)

    const s3Events = events.filter((e) => e.phase === 'syncToS3') as Array<
      Extract<ImportEvent, { phase: 'syncToS3' }>
    >
    expect(s3Events.map((e) => e.status)).toEqual(['running', 'ok'])
    expect(prismaState.deletedProjectIds).toEqual([])

    // The archive the warm-pool runtime will downloadAll() must exist.
    const key = `${BUCKET}/${result.project.id}/project-src.tar.gz`
    const stored = s3Store.get(key)
    expect(stored).toBeDefined()

    const entries = archiveEntries(stored!)
    expect(entries).toContain('package.json')
    expect(entries).toContain('src/index.ts')
    expect(archiveFile(stored!, 'src/index.ts')).toContain('imported')
  })

  test('a real S3 rejection still rolls the project row back with a 500', async () => {
    s3State.putError = 'AccessDenied'

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
    expect(result.error).toMatch(/S3 sync failed/i)

    const s3Events = events.filter((e) => e.phase === 'syncToS3') as Array<
      Extract<ImportEvent, { phase: 'syncToS3' }>
    >
    expect(s3Events.map((e) => e.status)).toEqual(['running', 'failed'])
    expect(prismaState.deletedProjectIds.length).toBe(1)
  })

  test('the lineage guard is still armed for callers that do not opt out', async () => {
    const result = await runImport(
      buildBundleZip(),
      'workspace-1',
      'user-1',
      { includeChats: false, runBootstrap: false },
      () => {},
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // agent-runtime creates its instances with no option — it must keep
    // refusing an unanchored write, or #1245's protection is gone.
    const otherRuntime = createS3SyncForProject(
      join(process.env.WORKSPACES_DIR!, result.project.id),
      result.project.id,
    )
    expect(otherRuntime).not.toBeNull()
    const stats = await otherRuntime!.uploadAll(false)
    expect(stats.errors.join('; ')).toContain('downloadAll() was never called')
    otherRuntime!.shutdown()

    // …and the archive the import wrote is still the one on the bucket.
    expect(s3Store.has(`${BUCKET}/${result.project.id}/project-src.tar.gz`)).toBe(true)
  })
})
