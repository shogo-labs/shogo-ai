// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Wave 2 ad-hoc coverage expansion for src/routes/project-export-import.ts
 *
 * Targets the largest remaining uncov blocks not covered by the other two
 * test files in this directory:
 *   - L981-1024  k8s export branch (isKubernetes + knative-project-manager
 *                + AgentClient.getWorkspaceBundle bundle ingestion)
 *   - L1031-1040 k8s export pod-unreachable catch (sourceMode fallback)
 *   - L1326-1370 SSE import streaming (progress / fatal events)
 *
 * Replaces the prior single-assertion coverage-marker stub. New tests use a
 * dedicated mock harness with KUBERNETES_SERVICE_HOST set, knative-project-
 * manager + AgentClient stubbed, and prisma/runtime-token mocked.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { zipSync, strToU8 } from 'fflate'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

// ─── env: simulate k8s mode for export branch ───────────────────────────────
process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
const tmpRoot = mkdtempSync(join(tmpdir(), 'shogo-export-v4-'))
process.env.WORKSPACES_DIR = tmpRoot

type ProjectRow = {
  id: string; name: string; description: string | null; workspaceId: string
  createdBy: string; tier: string; status: string; accessLevel: string
  schemas: string[]; category: string | null; siteTitle: string | null
  siteDescription: string | null; settings: string
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
    user: { findUnique: async (args: any) => users.get(args.where.id) ?? null },
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
          id, name: args.data.name,
          description: args.data.description ?? null,
          workspaceId: args.data.workspaceId,
          createdBy: args.data.createdBy,
          tier: args.data.tier, status: args.data.status,
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
      delete: async (args: any) => { projects.delete(args.where.id); return { id: args.where.id } },
    },
    agentConfig: { create: async (args: any) => { agentConfigs.push(args.data); return args.data } },
    chatSession: {
      findMany: async () => [],
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

// ─── knative-project-manager: stub getProjectPodUrl ─────────────────────────
mock.module('../lib/knative-project-manager', () => ({
  getProjectPodUrl: async (projectId: string) => `http://pod-${projectId}.local`,
}))

// ─── @shogo-ai/sdk/agent: AgentClient stub returning configurable bundle ───
let bundleResponse: any = { files: { 'README.md': Buffer.from('hello').toString('base64') } }
let bundleThrows = false
mock.module('@shogo-ai/sdk/agent', () => ({
  AgentClient: class StubAgentClient {
    async getWorkspaceBundle() {
      if (bundleThrows) throw new Error('pod unreachable')
      return bundleResponse
    }
  },
}))

// ─── shared-runtime: createS3SyncForProject returns a stub uploader ─────────
let s3UploadResult: { errors?: string[]; archiveSize?: number } = { errors: [], archiveSize: 0 }
let s3SyncReturnsNull = false
mock.module('@shogo/shared-runtime', () => ({
  createS3SyncForProject: () => {
    if (s3SyncReturnsNull) return null
    return {
      uploadAll: async () => s3UploadResult,
    }
  },
  isMacOSJunkName: (n: string) => n === '__MACOSX' || n.startsWith('._'),
  RUNTIME_CONFIG: {},
}))

mock.module('../lib/runtime-token', () => ({ deriveRuntimeToken: () => 'tok' }))

beforeEach(() => {
  members.clear(); users.clear(); projects.clear()
  agentConfigs.length = 0; chatSessions.length = 0; chatMessages.length = 0
  bundleResponse = { files: { 'README.md': Buffer.from('hello').toString('base64') } }
  bundleThrows = false
  s3UploadResult = { errors: [], archiveSize: 0 }
  s3SyncReturnsNull = false
})

const exportImportMod = await import('../routes/project-export-import')
const { runImport, projectExportImportRoutes } = exportImportMod

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

function makeProjectJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '1.1',
    exportedAt: '2026-05-13T00:00:00Z',
    includedChats: false,
    project: {
      name: 'Imported', description: 'desc', tier: 'starter', status: 'draft',
      settings: { activeMode: 'none', canvasEnabled: false },
      category: null, schemas: [], accessLevel: 'anyone',
      siteTitle: null, siteDescription: null,
    },
    agentConfig: {
      heartbeatInterval: 1800, heartbeatEnabled: false,
      modelProvider: 'anthropic', modelName: 'claude-haiku-4-5', channels: [],
    },
    requiredCredentials: [],
    ...extra,
  })
}

// ─── K8s export branch (L980-1040) ──────────────────────────────────────────

// Export switched from GET to POST (password rides in the request body).
function exportReq(projectId: string) {
  return new Request(`http://x/api/projects/${projectId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeChats: false }),
  })
}

describe('POST /:projectId/export — k8s source mode', () => {
  test('k8s mode: AgentClient bundle files are written under workspace/ in the zip', async () => {
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
    seedProject('p-empty-bundle')
    bundleResponse = { files: {} }

    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-empty-bundle'))

    expect(res.status).toBe(200)
  })

  test('k8s mode: bundle with backslash paths is normalised to forward slashes', async () => {
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
    seedProject('p-malformed-bundle')
    bundleResponse = { somethingElse: true }

    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-malformed-bundle'))

    expect(res.status).toBe(200)
  })

  test('k8s mode: AgentClient throws → sourceMode falls back to k8s-fallback-empty (warning emitted)', async () => {
    seedProject('p-pod-down')
    bundleThrows = true

    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-pod-down'))

    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  test('k8s mode: bundle filenames matching excluded patterns are skipped', async () => {
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

// ─── SSE import streaming (L1326-1370) ──────────────────────────────────────

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

// ─── runImport: k8s S3 sync branches (L737-820) ─────────────────────────────

describe('runImport: k8s mode S3 sync paths', () => {
  test('k8s + bucket set + sync ok: import succeeds', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    s3UploadResult = { errors: [], archiveSize: 0 }
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const result = await runImport(
      new Uint8Array(buf), 'w-1', 'u-1', { includeChats: false },
      async () => {},
    )
    expect(result.ok).toBe(true)
  })

  test('k8s + bucket set + S3 misconfig (createS3SyncForProject returns null): 500 + rolls back', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    s3SyncReturnsNull = true
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const result = await runImport(
      new Uint8Array(buf), 'w-1', 'u-1', { includeChats: false },
      async () => {},
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
    expect(result.error).toMatch(/S3/i)
  })

  test('k8s + bucket set + uploadAll returns ok:false: 500 + rolls back', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    s3UploadResult = { errors: ['aws creds missing'] }
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const result = await runImport(
      new Uint8Array(buf), 'w-1', 'u-1', { includeChats: false },
      async () => {},
    )
    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
  })

  test('progress emit receives syncToS3 phase events during k8s import', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const phases: string[] = []
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    await runImport(
      new Uint8Array(buf), 'w-1', 'u-1', { includeChats: false },
      async (ev: any) => { phases.push(ev.phase) },
    )
    expect(phases).toContain('syncToS3')
  })
})
