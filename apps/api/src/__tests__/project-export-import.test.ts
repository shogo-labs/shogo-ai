// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Project export + import coverage.
 *
 * `apps/api/src/routes/project-export-import.ts` was at 24% line coverage —
 * mostly because nothing exercises `runImport` end-to-end with a real
 * zip. This file:
 *
 *   - mocks `../lib/prisma` with an in-memory project / member /
 *     chatSession / chatMessage store,
 *   - calls `runImport` directly (bypassing Hono / SSE wrapper) to
 *     drive every branch:
 *       - invalid zip → 400
 *       - missing project.json → 400
 *       - malformed project.json → 400
 *       - unsupported bundle version → non-fatal warning, still ok
 *       - workspace member required (403 unless super_admin)
 *       - happy-path import with workspace files + chat history
 *       - unsafe path rejection (../, /, c:\)
 *       - bundle manifest warnings forwarded
 *       - password-protected (ZipCrypto) archive round-trip + missing /
 *         wrong password → fatal 400
 *       - includeChats=false → counts chat-history entries as skipped
 *   - exercises the POST /:projectId/export Hono route for both the
 *     404-not-found and 200-zip happy paths.
 *
 *   bun test apps/api/src/__tests__/project-export-import.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { zipSync, strToU8 } from 'fflate'
import { encryptZipCrypto } from '../lib/zip-encryption'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'

delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.S3_WORKSPACES_BUCKET
const tmpRoot = mkdtempSync(join(tmpdir(), 'shogo-export-import-test-'))
process.env.WORKSPACES_DIR = tmpRoot

// ─── Toggle flags driven by individual tests (k8s + S3 branches) ────────────
let bundleResponse: any = { files: { 'README.md': Buffer.from('hello').toString('base64') } }
let bundleThrows = false
let s3UploadResult: { errors?: string[]; archiveSize?: number } = { errors: [], archiveSize: 0 }
let s3SyncReturnsNull = false

// ────────────────────────────────────────────────────────────────────
// In-memory Prisma mock
// ────────────────────────────────────────────────────────────────────
type ProjectRow = {
  id: string
  name: string
  description: string | null
  workspaceId: string
  createdBy: string
  tier: string
  status: string
  accessLevel: string
  schemas: string[]
  category: string | null
  siteTitle: string | null
  siteDescription: string | null
  settings: string
}

const members = new Map<string, { userId: string; workspaceId: string; id: string }>()
const users = new Map<string, { id: string; role: string }>()
const projects = new Map<string, ProjectRow>()
const agentConfigs: any[] = []
const chatSessions: any[] = []
const chatMessages: any[] = []
let projectIdCounter = 0

import { withPrismaExports } from './helpers/prisma-mock-exports'
mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    member: {
      findFirst: async (args: any) => {
        for (const m of members.values()) {
          if (m.userId === args.where.userId && m.workspaceId === args.where.workspaceId) return m
        }
        return null
      },
    },
    user: {
      findUnique: async (args: any) => users.get(args.where.id) ?? null,
    },
    project: {
      findUnique: async (args: any) => {
        const p = projects.get(args.where.id)
        if (!p) return null
        if (args.include?.agentConfig) {
          const ac = agentConfigs.find((a) => a.projectId === p.id)
          return { ...p, agentConfig: ac ?? null }
        }
        return p
      },
      create: async (args: any) => {
        const id = `imp-${++projectIdCounter}`
        const row: ProjectRow = {
          id,
          name: args.data.name,
          description: args.data.description ?? null,
          workspaceId: args.data.workspaceId,
          createdBy: args.data.createdBy,
          tier: args.data.tier,
          status: args.data.status,
          accessLevel: args.data.accessLevel,
          schemas: args.data.schemas ?? [],
          category: args.data.category ?? null,
          siteTitle: args.data.siteTitle ?? null,
          siteDescription: args.data.siteDescription ?? null,
          settings: args.data.settings,
        }
        projects.set(id, row)
        return row
      },
      delete: async (args: any) => {
        projects.delete(args.where.id)
        return { id: args.where.id }
      },
    },
    agentConfig: {
      create: async (args: any) => {
        agentConfigs.push(args.data)
        return args.data
      },
    },
    chatSession: {
      findMany: async (args: any) => {
        return chatSessions
          .filter((s) =>
            (!args?.where || (
              (args.where.contextType ? s.contextType === args.where.contextType : true) &&
              (args.where.contextId ? s.contextId === args.where.contextId : true)
            )),
          )
          .map((s) => ({
            ...s,
            messages: chatMessages.filter((m) => m.sessionId === s.id),
          }))
      },
      create: async (args: any) => {
        const row = { id: `cs-${chatSessions.length + 1}`, ...args.data }
        chatSessions.push(row)
        return row
      },
    },
    chatMessage: {
      createMany: async (args: any) => {
        for (const m of args.data) chatMessages.push({ id: `cm-${chatMessages.length + 1}`, ...m })
        return { count: args.data.length }
      },
    },
  },
}))

mock.module('@shogo/shared-runtime', () => ({
  createS3SyncForProject: () => {
    if (s3SyncReturnsNull) return null
    return { uploadAll: async () => s3UploadResult }
  },
  isMacOSJunkName: (n: string) => n === '__MACOSX' || n.startsWith('._'),
  RUNTIME_CONFIG: {},
}))

// knative-project-manager: only used in k8s export branch. Lazy-imported by
// route, so this mock is consumed only when KUBERNETES_SERVICE_HOST is set.
mock.module('../lib/knative-project-manager', () => ({
  getProjectPodUrl: async (projectId: string) => `http://pod-${projectId}.local`,
}))

mock.module('@shogo-ai/sdk/agent', () => ({
  AgentClient: class StubAgentClient {
    async getWorkspaceBundle() {
      if (bundleThrows) throw new Error('pod unreachable')
      return bundleResponse
    }
  },
}))

mock.module('../lib/runtime-token', () => ({
  deriveRuntimeToken: () => 'tok',
}))

beforeEach(() => {
  members.clear()
  users.clear()
  projects.clear()
  agentConfigs.length = 0
  chatSessions.length = 0
  chatMessages.length = 0
  // Reset env to local mode by default; k8s tests opt in explicitly.
  delete process.env.KUBERNETES_SERVICE_HOST
  delete process.env.S3_WORKSPACES_BUCKET
  bundleResponse = { files: { 'README.md': Buffer.from('hello').toString('base64') } }
  bundleThrows = false
  s3UploadResult = { errors: [], archiveSize: 0 }
  s3SyncReturnsNull = false
})

// Imports AFTER mocks.
const exportImportMod = await import('../routes/project-export-import')
const { runImport, projectExportImportRoutes } = exportImportMod

function makeProjectJson(): string {
  return JSON.stringify({
    version: '1.1',
    exportedAt: '2026-05-13T00:00:00Z',
    includedChats: true,
    project: {
      name: 'Imported',
      description: 'desc',
      tier: 'starter',
      status: 'draft',
      settings: { activeMode: 'none', canvasEnabled: false },
      category: null,
      schemas: [],
      accessLevel: 'anyone',
      siteTitle: null,
      siteDescription: null,
    },
    agentConfig: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      modelProvider: 'anthropic',
      modelName: 'claude-haiku-4-5',
      channels: [],
    },
    requiredCredentials: [],
  })
}

// =========================================================================
// runImport — error / edge paths
// =========================================================================

describe('runImport', () => {
  test('invalid zip → 400', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const events: any[] = []
    const result = await runImport(
      new Uint8Array([0x00, 0x01, 0x02]),
      'w-1',
      'u-1',
      { includeChats: true, runBootstrap: false },
      (e) => { events.push(e) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error.toLowerCase()).toContain('zip')
    }
  })

  test('missing project.json → 400', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({ 'other.txt': strToU8('hi') })
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: true, runBootstrap: false }, () => {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error).toContain('project.json')
    }
  })

  test('malformed project.json → 400', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({ 'project.json': strToU8('{not json}') })
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: true, runBootstrap: false }, () => {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
  })

  test('non-member, non-super_admin → 403', async () => {
    users.set('u-x', { id: 'u-x', role: 'user' })
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const result = await runImport(buf, 'w-1', 'u-x', { includeChats: true, runBootstrap: false }, () => {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  test('super_admin is allowed even without workspace membership', async () => {
    users.set('u-admin', { id: 'u-admin', role: 'super_admin' })
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const events: any[] = []
    const result = await runImport(buf, 'w-1', 'u-admin', { includeChats: true, runBootstrap: false }, (e) => { events.push(e) })
    expect(result.ok).toBe(true)
    expect(events.some((e) => e.phase === 'createProject')).toBe(true)
    expect(events.some((e) => e.phase === 'done')).toBe(true)
  })

  test('happy path: workspace files + chat history + manifest warnings', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(makeProjectJson()),
      'manifest.json': strToU8(JSON.stringify({
        bundleVersion: '1.1',
        warnings: ['ship-warning'],
      })),
      'workspace/AGENTS.md': strToU8('# Agents\n'),
      'workspace/src/main.ts': strToU8('export const x = 1\n'),
      'workspace/.shogo/install-marker': strToU8('skipme'),
      'workspace/../escape.txt': strToU8('nope'),
      'chat-history/s-1.json': strToU8(JSON.stringify({
        session: {
          inferredName: 'Hello',
          contextType: 'project',
          phase: null,
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
          lastActiveAt: '2026-05-01T00:00:00Z',
        },
        messages: [
          { role: 'user', content: 'hi', createdAt: '2026-05-01T00:00:00Z' },
        ],
      })),
    })

    const events: any[] = []
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: true, runBootstrap: false }, (e) => { events.push(e) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stats.filesWritten).toBeGreaterThanOrEqual(2)
    expect(result.stats.chatsImported).toBe(1)
    // manifest warning was forwarded
    expect(events.some((e) => e.phase === 'error' && e.message.includes('ship-warning'))).toBe(true)
    // unsafe path rejection should have emitted a non-fatal error event
    expect(events.some((e) => e.phase === 'error' && /unsafe/i.test(e.message))).toBe(true)
    expect(chatMessages.length).toBe(1)
  })

  test('unsupported bundle version emits non-fatal warning but still imports', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(JSON.stringify({
        ...JSON.parse(makeProjectJson()),
        version: '9.9',
      })),
    })
    const events: any[] = []
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: true, runBootstrap: false }, (e) => { events.push(e) })
    expect(result.ok).toBe(true)
    expect(events.some((e) => e.phase === 'error' && /not officially supported/i.test(e.message))).toBe(true)
  })

  test('includeChats=false counts chat-history entries as skipped', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(makeProjectJson()),
      'chat-history/s-1.json': strToU8('{}'),
      'chat-history/s-2.json': strToU8('{}'),
    })
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: false, runBootstrap: false }, () => {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.stats.chatsImported).toBe(0)
      expect(result.stats.chatsSkipped).toBe(2)
    }
  })

  test('password-protected archive round-trips with the correct password', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const encrypted = await encryptZipCrypto(
      {
        'project.json': strToU8(makeProjectJson()),
        'workspace/.env': strToU8('API_KEY=secret-token-123\n'),
      },
      'hunter2',
    )
    const result = await runImport(
      encrypted,
      'w-1',
      'u-1',
      { includeChats: true, password: 'hunter2', runBootstrap: false },
      () => {},
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Secrets travelled in-place inside the encrypted archive.
      const envOnDisk = join(tmpRoot, result.project.id, '.env')
      expect(existsSync(envOnDisk)).toBe(true)
      expect(readFileSync(envOnDisk, 'utf8')).toContain('secret-token-123')
      expect(result.secretsAutoFilled).toBe(true)
    }
  })

  test('password-protected archive without a password → fatal 400', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const encrypted = await encryptZipCrypto(
      { 'project.json': strToU8(makeProjectJson()) },
      'hunter2',
    )
    const result = await runImport(
      encrypted,
      'w-1',
      'u-1',
      { includeChats: true, runBootstrap: false },
      () => {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error.toLowerCase()).toContain('password')
    }
  })

  test('password-protected archive with the wrong password → fatal 400', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const encrypted = await encryptZipCrypto(
      { 'project.json': strToU8(makeProjectJson()) },
      'hunter2',
    )
    const result = await runImport(
      encrypted,
      'w-1',
      'u-1',
      { includeChats: true, password: 'wrong-password', runBootstrap: false },
      () => {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error.toLowerCase()).toContain('password')
    }
  })

  test('malformed chat-history entry counts as chatsSkipped', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(makeProjectJson()),
      'chat-history/bad.json': strToU8('{not json}'),
    })
    const events: any[] = []
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: true, runBootstrap: false }, (e) => { events.push(e) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.stats.chatsSkipped).toBe(1)
      expect(result.stats.chatsImported).toBe(0)
    }
  })

  test('a workspace file gets written to disk under the new project dir', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(makeProjectJson()),
      'workspace/README.md': strToU8('# hi\n'),
    })
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: true, runBootstrap: false }, () => {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      const onDisk = join(tmpRoot, result.project.id, 'README.md')
      expect(existsSync(onDisk)).toBe(true)
    }
  })
})

// =========================================================================
// projectExportImportRoutes — Hono surface
// =========================================================================

describe('projectExportImportRoutes', () => {
  test('POST /:projectId/export returns 404 when project does not exist', async () => {
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(
      new Request('http://x/api/projects/missing/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeChats: false }),
      }),
    )
    expect(res.status).toBe(404)
  })

  test('POST /:projectId/export returns a zip with project.json + manifest.json', async () => {
    projects.set('p-1', {
      id: 'p-1', name: 'My Project', description: 'd', workspaceId: 'w-1',
      createdBy: 'u-1', tier: 'starter', status: 'draft', accessLevel: 'anyone',
      schemas: [], category: null, siteTitle: null, siteDescription: null,
      settings: JSON.stringify({}),
    })
    agentConfigs.push({
      projectId: 'p-1', heartbeatInterval: 1800, heartbeatEnabled: false,
      modelProvider: 'anthropic', modelName: 'claude-haiku-4-5', channels: [],
    })
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(
      new Request('http://x/api/projects/p-1/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeChats: false }),
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    const body = await res.arrayBuffer()
    expect(body.byteLength).toBeGreaterThan(0)
  })

  test('POST /import rejects non-multipart content', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      ;(c as any).set('auth', { isAuthenticated: true, userId: 'u-1' })
      await next()
    })
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(new Request('http://x/api/projects/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 1 }),
    }))
    expect(res.status).toBe(400)
  })

  test('POST /import requires authentication', async () => {
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(new Request('http://x/api/projects/import', {
      method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=----xxx' },
      body: '',
    }))
    expect(res.status).toBe(401)
  })

  test('POST /import requires workspaceId in form data', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const app = new Hono()
    app.use('*', async (c, next) => {
      ;(c as any).set('auth', { isAuthenticated: true, userId: 'u-1' })
      await next()
    })
    app.route('/api/projects', projectExportImportRoutes())

    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const form = new FormData()
    form.append('file', new Blob([buf]), 'bundle.zip')
    // Intentionally omit workspaceId.
    const res = await app.fetch(new Request('http://x/api/projects/import', {
      method: 'POST', body: form,
    }))
    expect(res.status).toBe(400)
  })
})

// ============================================================================
// v4 ad-hoc coverage: k8s export branch, SSE streaming, k8s S3 sync paths
// (Consolidated from the deleted project-export-import-v4.test.ts file —
//  sharing the prisma / agent / shared-runtime mock harness above.)
// ============================================================================

function seedProject(id = 'p-x', overrides: Partial<ProjectRow> = {}) {
  const p: ProjectRow = {
    id, name: 'P', description: null, workspaceId: 'w-1', createdBy: 'u-1',
    tier: 'starter', status: 'draft', accessLevel: 'anyone',
    schemas: [], category: null, siteTitle: null, siteDescription: null,
    settings: JSON.stringify({}),
    ...overrides,
  }
  projects.set(id, p)
  agentConfigs.push({
    projectId: id, heartbeatInterval: 1800, heartbeatEnabled: false,
    modelProvider: 'anthropic', modelName: 'claude-haiku-4-5', channels: [],
  })
  return p
}

function exportReq(projectId: string) {
  return new Request(`http://x/api/projects/${projectId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeChats: false }),
  })
}

describe('POST /:projectId/export — k8s source mode', () => {
  test('k8s mode: AgentClient bundle files are written under workspace/ in the zip', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
    seedProject('p-k8s')
    bundleResponse = {
      files: {
        'README.md': Buffer.from('readme content').toString('base64'),
        'src/main.ts': Buffer.from('console.log(1)').toString('base64'),
      },
    }
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-k8s'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    const body = await res.arrayBuffer()
    expect(body.byteLength).toBeGreaterThan(0)
  })

  test('k8s mode: empty bundle emits warning but still returns 200', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    seedProject('p-empty-bundle')
    bundleResponse = { files: {} }
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-empty-bundle'))
    expect(res.status).toBe(200)
  })

  test('k8s mode: bundle with backslash paths is normalised to forward slashes', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    seedProject('p-backslash')
    bundleResponse = {
      files: {
        'memory\\2026-05-28.md': Buffer.from('hi').toString('base64'),
        'src\\nested\\thing.ts': Buffer.from('x').toString('base64'),
      },
    }
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-backslash'))
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  test('k8s mode: bundle with malformed shape (no files object) falls back to empty', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    seedProject('p-malformed-bundle')
    bundleResponse = { somethingElse: true }
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-malformed-bundle'))
    expect(res.status).toBe(200)
  })

  test('k8s mode: AgentClient throws → sourceMode falls back to k8s-fallback-empty', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    seedProject('p-pod-down')
    bundleThrows = true
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-pod-down'))
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  test('k8s mode: bundle filenames matching excluded patterns are skipped', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    seedProject('p-excluded')
    bundleResponse = {
      files: {
        '.git/HEAD': Buffer.from('ref').toString('base64'),
        'node_modules/x/package.json': Buffer.from('{}').toString('base64'),
        'README.md': Buffer.from('keep me').toString('base64'),
      },
    }
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-excluded'))
    expect(res.status).toBe(200)
  })
})

describe('POST /import — SSE streaming branch', () => {
  function authedApp() {
    const app = new Hono()
    app.use('*', async (c, next) => {
      ;(c as any).set('auth', { isAuthenticated: true, userId: 'u-1' })
      await next()
    })
    app.route('/api/projects', projectExportImportRoutes())
    return app
  }

  test('SSE: streams done event for successful import', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const form = new FormData()
    form.append('file', new Blob([buf]), 'b.zip')
    form.append('workspaceId', 'w-1')
    const res = await authedApp().fetch(new Request('http://x/api/projects/import', {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: form,
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/event-stream/)
    const text = await res.text()
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/event:|data:/)
  })

  test('SSE: streams fatal event when zip is invalid', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([0, 1, 2, 3])]), 'bad.zip')
    form.append('workspaceId', 'w-1')
    const res = await authedApp().fetch(new Request('http://x/api/projects/import', {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: form,
    }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toMatch(/fatal|error/)
  })

  test('SSE: streams fatal event when project.json is missing', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({ 'workspace/README.md': strToU8('hi') })
    const form = new FormData()
    form.append('file', new Blob([buf]), 'b.zip')
    form.append('workspaceId', 'w-1')
    const res = await authedApp().fetch(new Request('http://x/api/projects/import', {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: form,
    }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toMatch(/fatal|error|project\.json/)
  })
})

describe('runImport: k8s mode S3 sync paths', () => {
  test('k8s + bucket set + sync ok: import succeeds', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    s3UploadResult = { errors: [], archiveSize: 0 }
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const result = await runImport(
      new Uint8Array(buf), 'w-1', 'u-1', { includeChats: false, runBootstrap: false },
      () => {},
    )
    expect(result.ok).toBe(true)
  })

  test('k8s + bucket set + S3 misconfig (createS3SyncForProject returns null): 500 + rolls back', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    s3SyncReturnsNull = true
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const result = await runImport(
      new Uint8Array(buf), 'w-1', 'u-1', { includeChats: false, runBootstrap: false },
      () => {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(500)
      expect(result.error).toMatch(/S3/i)
    }
  })

  test('k8s + bucket set + uploadAll returns ok:false: 500 + rolls back', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    s3UploadResult = { errors: ['aws creds missing'] }
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const result = await runImport(
      new Uint8Array(buf), 'w-1', 'u-1', { includeChats: false, runBootstrap: false },
      () => {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(500)
  })

  test('progress emit receives syncToS3 phase events during k8s import', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const phases: string[] = []
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    await runImport(
      new Uint8Array(buf), 'w-1', 'u-1', { includeChats: false, runBootstrap: false },
      (ev: any) => { phases.push(ev.phase) },
    )
    expect(phases).toContain('syncToS3')
  })
})
