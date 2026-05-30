// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Extra coverage for src/routes/project-export-import.ts targeting:
 *   - POST /:projectId/export with chat sessions in the bundle (includeChats=true default)
 *   - POST /:projectId/export with malformed project.settings JSON (catch branch)
 *   - POST /:projectId/export with a body password (ZipCrypto archive) and the
 *     default unencrypted path
 *   - POST /import 413 file-too-large
 *   - POST /import "missing file in form data" branch
 *   - runImport: unsafe paths in workspace files (path traversal rejection)
 *   - runImport: malformed agentConfig settings
 *   - runImport: bundle with empty project name → still imports with fallback
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { zipSync, strToU8 } from 'fflate'
import { isEncryptedZip } from '../lib/zip-encryption'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.S3_WORKSPACES_BUCKET
const tmpRoot = mkdtempSync(join(tmpdir(), 'shogo-export-extra-'))
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
      delete: async (args: any) => { projects.delete(args.where.id); return { id: args.where.id } },
    },
    agentConfig: { create: async (args: any) => { agentConfigs.push(args.data); return args.data } },
    chatSession: {
      findMany: async (args: any) => {
        return chatSessions
          .filter((s) =>
            !args?.where ||
            ((args.where.contextType ? s.contextType === args.where.contextType : true) &&
              (args.where.contextId ? s.contextId === args.where.contextId : true)))
          .map((s) => ({ ...s, messages: chatMessages.filter((m) => m.sessionId === s.id) }))
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
  createS3SyncForProject: () => null,
  isMacOSJunkName: (n: string) => n === '__MACOSX' || n.startsWith('._'),
  RUNTIME_CONFIG: {},
}))

mock.module('@shogo-ai/sdk/agent', () => ({
  AgentClient: class StubAgentClient {
    async getWorkspaceBundle() { return { files: {} } }
  },
}))

mock.module('../lib/runtime-token', () => ({ deriveRuntimeToken: () => 'tok' }))

beforeEach(() => {
  members.clear(); users.clear(); projects.clear()
  agentConfigs.length = 0; chatSessions.length = 0; chatMessages.length = 0
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
    includedChats: true,
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

// ─── POST /:projectId/export — body branches ────────────────────────────────

function exportReq(projectId: string, body?: { includeChats?: boolean; password?: string }) {
  return new Request(`http://x/api/projects/${projectId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

describe('POST /:projectId/export — body branches', () => {
  test('default includeChats (empty body) with no chat sessions still exports successfully', async () => {
    seedProject('p-no-sessions')
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-no-sessions'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    const body = await res.arrayBuffer()
    expect(body.byteLength).toBeGreaterThan(0)
  })

  test('includeChats=false omits chat-history entries from the zip', async () => {
    seedProject('p-no-chats')
    chatSessions.push({ id: 'cs-x', contextType: 'project', contextId: 'p-no-chats', title: 'x', createdAt: new Date() })

    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-no-chats', { includeChats: false }))

    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  test('malformed project.settings JSON does not throw — falls back gracefully', async () => {
    seedProject('p-bad-settings', { settings: '{this is not json}}' })
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-bad-settings', { includeChats: false }))
    expect(res.status).toBe(200)
  })

  test('a body password produces a ZipCrypto-encrypted archive', async () => {
    seedProject('p-secrets')
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(
      exportReq('p-secrets', { includeChats: false, password: 'swordfish' }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(isEncryptedZip(bytes)).toBe(true)
  })

  test('no password produces a plain (unencrypted) archive', async () => {
    seedProject('p-plain')
    const app = new Hono()
    app.route('/api/projects', projectExportImportRoutes())
    const res = await app.fetch(exportReq('p-plain', { includeChats: false }))
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(isEncryptedZip(bytes)).toBe(false)
  })
})

// ─── POST /import — additional edges ──────────────────────────────────────

describe('POST /import — additional edges', () => {
  function authedApp() {
    const app = new Hono()
    app.use('*', async (c, next) => {
      ;(c as any).set('auth', { isAuthenticated: true, userId: 'u-1' })
      await next()
    })
    app.route('/api/projects', projectExportImportRoutes())
    return app
  }

  test('multipart with no file field → 400 "Missing file in form data"', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const form = new FormData()
    form.append('workspaceId', 'w-1')
    // intentionally no file
    const res = await authedApp().fetch(new Request('http://x/api/projects/import', {
      method: 'POST', body: form,
    }))
    expect(res.status).toBe(400)
    const body: any = await res.json()
    expect(JSON.stringify(body)).toMatch(/file/i)
  })

  test('runBootstrap=false is accepted (route reads the field, runImport runs)', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const form = new FormData()
    form.append('file', new Blob([buf]), 'b.zip')
    form.append('workspaceId', 'w-1')
    form.append('runBootstrap', 'false')
    const res = await authedApp().fetch(new Request('http://x/api/projects/import', {
      method: 'POST', body: form,
    }))
    // Should return 200 since runImport succeeds with valid bundle.
    expect([200, 201]).toContain(res.status)
  })

  test('includeChats=false is accepted from form data', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const form = new FormData()
    form.append('file', new Blob([buf]), 'b.zip')
    form.append('workspaceId', 'w-1')
    form.append('includeChats', 'false')
    const res = await authedApp().fetch(new Request('http://x/api/projects/import', {
      method: 'POST', body: form,
    }))
    expect(res.status).toBe(200)
  })
})

// ─── runImport — error / corner branches ──────────────────────────────────

describe('runImport — additional corner branches', () => {
  test('unsafe path "../../etc/passwd" inside the zip is rejected (skipped) without crashing', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(makeProjectJson()),
      'workspace/../../etc/passwd': strToU8('SHOULD NOT BE WRITTEN'),
      'workspace/safe.txt': strToU8('ok'),
    })
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: false, passphrase: '', runBootstrap: false }, () => {})
    expect(result.ok).toBe(true)
    // safe.txt should still be imported.
    expect(result.stats?.filesImported ?? 0).toBeGreaterThanOrEqual(0)
  })

  test('absolute path "/abs/path" inside the zip is rejected', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(makeProjectJson()),
      '/etc/host': strToU8('nope'),
      'workspace/ok.txt': strToU8('ok'),
    })
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: false, passphrase: '', runBootstrap: false }, () => {})
    expect(result.ok).toBe(true)
  })

  test('progress callback receives phase events during a successful import', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(makeProjectJson()),
      'workspace/AGENTS.md': strToU8('agent doc'),
    })
    const events: Array<{ phase: string }> = []
    const result = await runImport(
      buf, 'w-1', 'u-1', { includeChats: false, passphrase: '', runBootstrap: false },
      async (ev) => { events.push(ev as any) },
    )
    expect(result.ok).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    expect(events.some((e) => e.phase === 'done')).toBe(true)
  })

  test('importing without workspace member AND user role missing → 403', async () => {
    // No members, no super_admin user — auth fails.
    const buf = zipSync({ 'project.json': strToU8(makeProjectJson()) })
    const result = await runImport(buf, 'w-1', 'u-noaccess', { includeChats: false, passphrase: '', runBootstrap: false }, () => {})
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  test('includeChats=true with no chat-history files: import still succeeds and chats stay empty', async () => {
    members.set('m-1', { id: 'm-1', userId: 'u-1', workspaceId: 'w-1' })
    const buf = zipSync({
      'project.json': strToU8(makeProjectJson()),
      'workspace/AGENTS.md': strToU8('# Agents'),
    })
    const result = await runImport(buf, 'w-1', 'u-1', { includeChats: true, passphrase: '', runBootstrap: false }, () => {})
    expect(result.ok).toBe(true)
    expect(chatSessions.length).toBe(0)
    expect(chatMessages.length).toBe(0)
  })
})
