// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/routes/eval-outputs.ts — listing + import routes for the
 * eval-output filesystem catalog. Mocks node:fs and ../lib/prisma so
 * tests are platform-independent and don't touch the real disk.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

// ─── fs mock (controls every fs call the route makes) ─────────────────────

type Dirent = { name: string; isDirectory: () => boolean }

const existsSyncMock = mock((_p: string): boolean => false)
const readdirSyncMock = mock((_p: string, _opts?: any): Dirent[] => [])
const readFileSyncMock = mock((_p: string, _enc?: any): string => '')
const mkdirSyncMock = mock((_p: string, _opts?: any): void => {})
const cpSyncMock = mock((_src: string, _dst: string, _opts?: any): void => {})

mock.module('node:fs', () => ({
  existsSync: existsSyncMock,
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  cpSync: cpSyncMock,
}))

// ─── prisma mock ───────────────────────────────────────────────────────────

const projectCreateMock = mock(async (args: { data: any }) => ({
  id: 'proj_generated',
  name: args.data.name,
  description: args.data.description,
  workspaceId: args.data.workspaceId,
  createdBy: args.data.createdBy,
}))

mock.module('../lib/prisma', () => ({
  prisma: { project: { create: projectCreateMock } },
}))

const { evalOutputRoutes } = await import('../routes/eval-outputs')

// ─── helpers ───────────────────────────────────────────────────────────────

function mountApp() {
  const app = new Hono()
  app.route('/api', evalOutputRoutes())
  return app
}

const dirent = (name: string, isDir = true): Dirent => ({
  name,
  isDirectory: () => isDir,
})

beforeEach(() => {
  existsSyncMock.mockReset()
  readdirSyncMock.mockReset()
  readFileSyncMock.mockReset()
  mkdirSyncMock.mockReset()
  cpSyncMock.mockReset()
  projectCreateMock.mockReset()
  projectCreateMock.mockImplementation(async (args: { data: any }) => ({
    id: 'proj_generated',
    name: args.data.name,
    description: args.data.description,
    workspaceId: args.data.workspaceId,
    createdBy: args.data.createdBy,
  }))
})

// ─── GET /eval-outputs ─────────────────────────────────────────────────────

describe('GET /eval-outputs', () => {
  test('returns {runs: []} when EVAL_OUTPUTS_DIR does not exist', async () => {
    existsSyncMock.mockImplementation(() => false)
    const app = mountApp()
    const res = await app.request('/api/eval-outputs')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runs: [] })
  })

  test('returns parsed runs with one passing entry', async () => {
    existsSyncMock.mockImplementation((p: string) => {
      // EVAL_OUTPUTS_DIR exists, template.json exists.
      return true
    })

    readdirSyncMock.mockImplementation((p: string) => {
      // First call: list of run dirs. Second call: list of evals inside a run.
      if (p.endsWith('eval-outputs')) {
        return [dirent('next-15-2026-01-15T10-30-00')]
      }
      return [dirent('test-eval-1')]
    })

    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({
        id: 'eval_1',
        name: 'Test Eval',
        description: 'A test',
        icon: '🧪',
        eval: { passed: true, score: 95, maxScore: 100, percentage: 95 },
        tags: ['unit', 'fast'],
      })
    )

    const app = mountApp()
    const res = await app.request('/api/eval-outputs')
    const body = await res.json()
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]).toMatchObject({
      track: 'next-15',
      dirName: 'next-15-2026-01-15T10-30-00',
      entries: [
        {
          id: 'eval_1',
          name: 'Test Eval',
          description: 'A test',
          icon: '🧪',
          passed: true,
          score: { earned: 95, max: 100, percentage: 95 },
          tags: ['unit', 'fast'],
          path: 'next-15-2026-01-15T10-30-00/test-eval-1',
        },
      ],
    })
    // Timestamp normalization: dashes at positions 13/16 become colons
    expect(body.runs[0].timestamp).toBe('2026-01-15T10:30:00')
  })

  test('falls back to defaults when template.json is missing fields', async () => {
    existsSyncMock.mockImplementation(() => true)
    readdirSyncMock.mockImplementation((p: string) =>
      p.endsWith('eval-outputs') ? [dirent('plain-2026-01-01T00-00-00')] : [dirent('e1')]
    )
    readFileSyncMock.mockImplementation(() => JSON.stringify({})) // every field missing

    const app = mountApp()
    const body = await (await app.request('/api/eval-outputs')).json()
    const e = body.runs[0].entries[0]
    expect(e.id).toBe('e1') // falls back to dir name
    expect(e.name).toBe('e1')
    expect(e.description).toBe('')
    expect(e.icon).toBe('?')
    expect(e.passed).toBe(false)
    expect(e.score).toEqual({ earned: 0, max: 0, percentage: 0 })
    expect(e.tags).toEqual([])
  })

  test('skips eval directories without a template.json', async () => {
    existsSyncMock.mockImplementation((p: string) => !p.endsWith('template.json'))
    readdirSyncMock.mockImplementation((p: string) =>
      p.endsWith('eval-outputs') ? [dirent('r-2026-01-01T00-00-00')] : [dirent('no-template')]
    )
    const app = mountApp()
    const body = await (await app.request('/api/eval-outputs')).json()
    // No entries → the run is filtered out (entries.length === 0).
    expect(body.runs).toEqual([])
  })

  test('skips entries with malformed template.json without crashing', async () => {
    existsSyncMock.mockImplementation(() => true)
    readdirSyncMock.mockImplementation((p: string) =>
      p.endsWith('eval-outputs')
        ? [dirent('r-2026-01-01T00-00-00')]
        : [dirent('good'), dirent('bad')]
    )
    readFileSyncMock.mockImplementation((p: string) => {
      if (String(p).includes('bad')) return '{not json'
      return JSON.stringify({ id: 'good', eval: { passed: true } })
    })

    const app = mountApp()
    const body = await (await app.request('/api/eval-outputs')).json()
    expect(body.runs[0].entries).toHaveLength(1)
    expect(body.runs[0].entries[0].id).toBe('good')
  })

  test('sorts run directories in reverse alphabetical order (newest first)', async () => {
    existsSyncMock.mockImplementation(() => true)
    readdirSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('eval-outputs')) {
        return [
          dirent('a-2026-01-01T00-00-00'),
          dirent('c-2026-03-01T00-00-00'),
          dirent('b-2026-02-01T00-00-00'),
        ]
      }
      return [dirent('e')]
    })
    readFileSyncMock.mockImplementation(() => JSON.stringify({ eval: { passed: true } }))

    const app = mountApp()
    const body = await (await app.request('/api/eval-outputs')).json()
    expect(body.runs.map((r: any) => r.track)).toEqual(['c', 'b', 'a'])
  })

  test('falls back to dirName as track when name does not match the regex', async () => {
    existsSyncMock.mockImplementation(() => true)
    readdirSyncMock.mockImplementation((p: string) =>
      p.endsWith('eval-outputs') ? [dirent('weird_dir_name')] : [dirent('e')]
    )
    readFileSyncMock.mockImplementation(() => JSON.stringify({ eval: { passed: true } }))

    const app = mountApp()
    const body = await (await app.request('/api/eval-outputs')).json()
    expect(body.runs[0].track).toBe('weird_dir_name')
    expect(body.runs[0].timestamp).toBe('weird_dir_name')
  })

  test('only lists actual directories at the top level (filters files)', async () => {
    existsSyncMock.mockImplementation(() => true)
    readdirSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('eval-outputs')) {
        return [
          dirent('valid-2026-01-01T00-00-00', true),
          dirent('README.md', false), // file, must be filtered out
        ]
      }
      return [dirent('e1')]
    })
    readFileSyncMock.mockImplementation(() => JSON.stringify({ eval: { passed: true } }))

    const app = mountApp()
    const body = await (await app.request('/api/eval-outputs')).json()
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].track).toBe('valid')
  })
})

// ─── POST /eval-outputs/import ─────────────────────────────────────────────

describe('POST /eval-outputs/import', () => {
  function importBody(over: Record<string, unknown> = {}) {
    return JSON.stringify({
      evalOutputPath: 'run-1/eval-a',
      workspaceId: 'ws_1',
      userId: 'user_1',
      ...over,
    })
  }

  test('returns 400 when evalOutputPath is missing', async () => {
    const app = mountApp()
    const res = await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'w', userId: 'u' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing required fields')
  })

  test('returns 400 when workspaceId is missing', async () => {
    const app = mountApp()
    const res = await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evalOutputPath: 'p', userId: 'u' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 400 when userId is missing', async () => {
    const app = mountApp()
    const res = await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evalOutputPath: 'p', workspaceId: 'w' }),
    })
    expect(res.status).toBe(400)
  })

  test('returns 404 when the resolved eval directory does not exist', async () => {
    existsSyncMock.mockImplementation(() => false)
    const app = mountApp()
    const res = await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody(),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('Eval output not found')
  })

  test('strips ".." path segments to prevent traversal', async () => {
    let lastCheckedPath = ''
    existsSyncMock.mockImplementation((p: string) => {
      lastCheckedPath = p
      return false // make it 404 so the test stops here
    })
    const app = mountApp()
    await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody({ evalOutputPath: '../../etc/passwd' }),
    })
    // The path the route checked must NOT include any '..' segments.
    expect(lastCheckedPath.includes('..')).toBe(false)
  })

  test('creates a project + copies files, returns {project} shape', async () => {
    existsSyncMock.mockImplementation(() => true)
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({ name: 'From Template', description: 'tmpl desc' })
    )

    const app = mountApp()
    const res = await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.project).toEqual({
      id: 'proj_generated',
      name: 'From Template',
      description: 'tmpl desc',
    })
    expect(projectCreateMock).toHaveBeenCalledTimes(1)
    const data = projectCreateMock.mock.calls[0][0].data
    expect(data.workspaceId).toBe('ws_1')
    expect(data.createdBy).toBe('user_1')
    expect(data.tier).toBe('starter')
    expect(data.status).toBe('draft')
    expect(mkdirSyncMock).toHaveBeenCalledTimes(1)
    expect(cpSyncMock).toHaveBeenCalledTimes(1)
  })

  test('uses explicit name from body when provided (over template name)', async () => {
    existsSyncMock.mockImplementation(() => true)
    readFileSyncMock.mockImplementation(() => JSON.stringify({ name: 'Template Name' }))

    const app = mountApp()
    await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody({ name: 'Custom Name' }),
    })
    expect(projectCreateMock.mock.calls[0][0].data.name).toBe('Custom Name')
  })

  test('falls back to "Imported Eval" when template and body have no name', async () => {
    existsSyncMock.mockImplementation(() => true)
    readFileSyncMock.mockImplementation(() => JSON.stringify({}))

    const app = mountApp()
    await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody(),
    })
    expect(projectCreateMock.mock.calls[0][0].data.name).toBe('Imported Eval')
  })

  test('proceeds even when template.json is missing entirely', async () => {
    existsSyncMock.mockImplementation((p: string) => !p.endsWith('template.json'))

    const app = mountApp()
    const res = await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody(),
    })
    expect(res.status).toBe(200)
    expect(projectCreateMock).toHaveBeenCalledTimes(1)
    // No template → falls back to defaults.
    const data = projectCreateMock.mock.calls[0][0].data
    expect(data.name).toBe('Imported Eval')
  })

  test('proceeds even when template.json is malformed (caught silently)', async () => {
    existsSyncMock.mockImplementation(() => true)
    readFileSyncMock.mockImplementation(() => '{not json')

    const app = mountApp()
    const res = await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody({ name: 'Manual Name' }),
    })
    expect(res.status).toBe(200)
    expect(projectCreateMock.mock.calls[0][0].data.name).toBe('Manual Name')
  })

  test('cpSync filter excludes template.json from the copy', async () => {
    existsSyncMock.mockImplementation(() => true)
    readFileSyncMock.mockImplementation(() => JSON.stringify({}))

    const app = mountApp()
    await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody(),
    })

    const opts = cpSyncMock.mock.calls[0][2] as any
    expect(opts.recursive).toBe(true)
    expect(typeof opts.filter).toBe('function')
    expect(opts.filter('/some/path/template.json')).toBe(false)
    expect(opts.filter('/some/path/other.ts')).toBe(true)
  })

  test('uses settings JSON with activeMode=canvas', async () => {
    existsSyncMock.mockImplementation(() => true)
    readFileSyncMock.mockImplementation(() => JSON.stringify({}))

    const app = mountApp()
    await app.request('/api/eval-outputs/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: importBody(),
    })
    const data = projectCreateMock.mock.calls[0][0].data
    expect(JSON.parse(data.settings)).toEqual({ activeMode: 'canvas' })
  })
})
