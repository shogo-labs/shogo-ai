// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

interface FsState {
  exists: Set<string>
  dirs: Map<string, Array<{ name: string; isDir: boolean }>>
  files: Map<string, string>
  mkdirCalls: Array<{ path: string; opts: any }>
  cpCalls: Array<{ src: string; dest: string; opts: any }>
  readFileSyncThrow: Map<string, Error>
}

const fs: FsState = {
  exists: new Set(),
  dirs: new Map(),
  files: new Map(),
  mkdirCalls: [],
  cpCalls: [],
  readFileSyncThrow: new Map(),
}

mock.module('node:fs', () => ({
  existsSync: (p: string) => fs.exists.has(p),
  readdirSync: (p: string, _opts?: any) => {
    const entries = fs.dirs.get(p) ?? []
    return entries.map((e) => ({
      name: e.name,
      isDirectory: () => e.isDir,
    }))
  },
  readFileSync: (p: string, _enc?: string) => {
    const err = fs.readFileSyncThrow.get(p)
    if (err) throw err
    const content = fs.files.get(p)
    if (content === undefined) throw new Error(`ENOENT: ${p}`)
    return content
  },
  mkdirSync: (p: string, opts: any) => {
    fs.mkdirCalls.push({ path: p, opts })
  },
  cpSync: (src: string, dest: string, opts: any) => {
    fs.cpCalls.push({ src, dest, opts })
  },
}))

interface PrismaState {
  createCalls: Array<{ data: any }>
  createImpl: (data: any) => Promise<any>
}

const ps: PrismaState = {
  createCalls: [],
  createImpl: async (data) => ({ id: 'proj-new', ...data }),
}

mock.module('../../lib/prisma', () => ({
  prisma: {
    project: {
      create: async (args: any) => {
        ps.createCalls.push(args)
        return ps.createImpl(args.data)
      },
    },
  },
}))

const { evalOutputRoutes } = await import('../eval-outputs')

// `EVAL_OUTPUTS_DIR` in the SUT is resolved at module-load time relative
// to its own `import.meta.dir`:
//   resolve(<routes>, '../../../../packages/agent-runtime/eval-outputs')
// The mock only matches existsSync/readdirSync queries by exact string,
// so we must mirror the same resolved absolute path or every directory
// lookup will miss and `body.runs` will always be empty. The test file
// lives one level deeper than the route (in `__tests__/`), so we hop one
// extra `..` to land on the same physical directory.
const { resolve } = await import('node:path')
const EVAL_DIR = resolve(import.meta.dir, '..', '../../../../packages/agent-runtime/eval-outputs')

beforeEach(() => {
  fs.exists = new Set()
  fs.dirs = new Map()
  fs.files = new Map()
  fs.mkdirCalls = []
  fs.cpCalls = []
  fs.readFileSyncThrow = new Map()
  ps.createCalls = []
  ps.createImpl = async (data) => ({ id: 'proj-new', ...data })
})

afterEach(() => {})

describe('GET /eval-outputs', () => {
  it('returns empty runs when EVAL_OUTPUTS_DIR is missing', async () => {
    // fs.exists is empty
    const res = await evalOutputRoutes().request('/eval-outputs')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ runs: [] })
  })

  it('returns parsed runs with timestamp colon-restoration', async () => {
    fs.exists.add(EVAL_DIR)
    fs.dirs.set(EVAL_DIR, [
      { name: 'sales-2026-01-15T10-30-45.123Z', isDir: true },
    ])
    const runPath = `${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z`
    fs.dirs.set(runPath, [{ name: 'check-1', isDir: true }])
    const tpl = `${runPath}/check-1/template.json`
    fs.exists.add(tpl)
    fs.files.set(
      tpl,
      JSON.stringify({
        id: 'c1',
        name: 'Check 1',
        description: 'desc',
        icon: '✅',
        eval: { passed: true, score: 9, maxScore: 10, percentage: 90 },
        tags: ['sales'],
      }),
    )

    const res = await evalOutputRoutes().request('/eval-outputs')
    const body = await res.json()
    expect(body.runs).toHaveLength(1)
    const run = body.runs[0]
    expect(run.track).toBe('sales')
    expect(run.timestamp).toBe('2026-01-15T10:30:45.123Z')
    expect(run.dirName).toBe('sales-2026-01-15T10-30-45.123Z')
    expect(run.entries[0]).toEqual({
      id: 'c1',
      name: 'Check 1',
      description: 'desc',
      icon: '✅',
      passed: true,
      score: { earned: 9, max: 10, percentage: 90 },
      tags: ['sales'],
      path: 'sales-2026-01-15T10-30-45.123Z/check-1',
    })
  })

  it('falls back to dir name when the timestamp pattern does not match', async () => {
    fs.exists.add(EVAL_DIR)
    fs.dirs.set(EVAL_DIR, [{ name: 'no-timestamp-here', isDir: true }])
    fs.dirs.set(`${EVAL_DIR}/no-timestamp-here`, [{ name: 'c', isDir: true }])
    fs.exists.add(`${EVAL_DIR}/no-timestamp-here/c/template.json`)
    fs.files.set(`${EVAL_DIR}/no-timestamp-here/c/template.json`, '{}')

    const res = await evalOutputRoutes().request('/eval-outputs')
    const body = await res.json()
    expect(body.runs[0].track).toBe('no-timestamp-here')
    expect(body.runs[0].timestamp).toBe('no-timestamp-here')
  })

  it('zero-fills entry fields when template.json is empty', async () => {
    fs.exists.add(EVAL_DIR)
    fs.dirs.set(EVAL_DIR, [{ name: 'sales-2026-01-15T10-30-45.123Z', isDir: true }])
    fs.dirs.set(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z`, [{ name: 'fallback-eval', isDir: true }])
    const tpl = `${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/fallback-eval/template.json`
    fs.exists.add(tpl)
    fs.files.set(tpl, '{}')

    const res = await evalOutputRoutes().request('/eval-outputs')
    const body = await res.json()
    expect(body.runs[0].entries[0]).toEqual({
      id: 'fallback-eval',
      name: 'fallback-eval',
      description: '',
      icon: '?',
      passed: false,
      score: { earned: 0, max: 0, percentage: 0 },
      tags: [],
      path: 'sales-2026-01-15T10-30-45.123Z/fallback-eval',
    })
  })

  it('skips eval subdirs without a template.json', async () => {
    fs.exists.add(EVAL_DIR)
    fs.dirs.set(EVAL_DIR, [{ name: 'sales-2026-01-15T10-30-45.123Z', isDir: true }])
    fs.dirs.set(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z`, [
      { name: 'has-tpl', isDir: true },
      { name: 'no-tpl', isDir: true },
    ])
    fs.exists.add(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/has-tpl/template.json`)
    fs.files.set(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/has-tpl/template.json`, '{}')

    const res = await evalOutputRoutes().request('/eval-outputs')
    const body = await res.json()
    expect(body.runs[0].entries).toHaveLength(1)
    expect(body.runs[0].entries[0].id).toBe('has-tpl')
  })

  it('skips eval entries whose template.json is malformed', async () => {
    fs.exists.add(EVAL_DIR)
    fs.dirs.set(EVAL_DIR, [{ name: 'sales-2026-01-15T10-30-45.123Z', isDir: true }])
    fs.dirs.set(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z`, [
      { name: 'bad', isDir: true },
      { name: 'good', isDir: true },
    ])
    fs.exists.add(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/bad/template.json`)
    fs.files.set(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/bad/template.json`, 'not-json{')
    fs.exists.add(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/good/template.json`)
    fs.files.set(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/good/template.json`, '{}')

    const res = await evalOutputRoutes().request('/eval-outputs')
    const body = await res.json()
    expect(body.runs[0].entries).toHaveLength(1)
    expect(body.runs[0].entries[0].id).toBe('good')
  })

  it('omits a run entirely if it has no valid entries', async () => {
    fs.exists.add(EVAL_DIR)
    fs.dirs.set(EVAL_DIR, [
      { name: 'empty-2026-01-15T10-30-45.123Z', isDir: true },
      { name: 'has-2026-02-15T10-30-45.123Z', isDir: true },
    ])
    fs.dirs.set(`${EVAL_DIR}/empty-2026-01-15T10-30-45.123Z`, [])
    fs.dirs.set(`${EVAL_DIR}/has-2026-02-15T10-30-45.123Z`, [{ name: 'e', isDir: true }])
    fs.exists.add(`${EVAL_DIR}/has-2026-02-15T10-30-45.123Z/e/template.json`)
    fs.files.set(`${EVAL_DIR}/has-2026-02-15T10-30-45.123Z/e/template.json`, '{}')

    const res = await evalOutputRoutes().request('/eval-outputs')
    const body = await res.json()
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0].track).toBe('has')
  })

  it('sorts runs newest-first via localeCompare(b.name)', async () => {
    fs.exists.add(EVAL_DIR)
    fs.dirs.set(EVAL_DIR, [
      { name: 'a-2026-01-01T10-30-45.000Z', isDir: true },
      { name: 'b-2026-03-01T10-30-45.000Z', isDir: true },
      { name: 'c-2026-02-01T10-30-45.000Z', isDir: true },
    ])
    for (const n of ['a-2026-01-01T10-30-45.000Z', 'b-2026-03-01T10-30-45.000Z', 'c-2026-02-01T10-30-45.000Z']) {
      fs.dirs.set(`${EVAL_DIR}/${n}`, [{ name: 'e', isDir: true }])
      fs.exists.add(`${EVAL_DIR}/${n}/e/template.json`)
      fs.files.set(`${EVAL_DIR}/${n}/e/template.json`, '{}')
    }

    const res = await evalOutputRoutes().request('/eval-outputs')
    const body = await res.json()
    expect(body.runs.map((r: any) => r.track)).toEqual(['c', 'b', 'a'])
  })

  it('filters out non-directories at the top level', async () => {
    fs.exists.add(EVAL_DIR)
    fs.dirs.set(EVAL_DIR, [
      { name: 'README.md', isDir: false },
      { name: 'sales-2026-01-15T10-30-45.123Z', isDir: true },
    ])
    fs.dirs.set(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z`, [{ name: 'e', isDir: true }])
    fs.exists.add(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/e/template.json`)
    fs.files.set(`${EVAL_DIR}/sales-2026-01-15T10-30-45.123Z/e/template.json`, '{}')

    const res = await evalOutputRoutes().request('/eval-outputs')
    const body = await res.json()
    expect(body.runs).toHaveLength(1)
  })
})

describe('POST /eval-outputs/import', () => {
  beforeEach(() => {
    fs.exists.add(EVAL_DIR)
    fs.exists.add(`${EVAL_DIR}/sales/check-1`)
    fs.exists.add(`${EVAL_DIR}/sales/check-1/template.json`)
    fs.files.set(
      `${EVAL_DIR}/sales/check-1/template.json`,
      JSON.stringify({ name: 'Sales Check', description: 'A sales eval' }),
    )
  })

  it('returns 400 when evalOutputPath is missing', async () => {
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'w-1', userId: 'u-1' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('evalOutputPath')
  })

  it('returns 400 when workspaceId is missing', async () => {
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({ evalOutputPath: 'sales/check-1', userId: 'u-1' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when userId is missing', async () => {
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({ evalOutputPath: 'sales/check-1', workspaceId: 'w-1' }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the eval directory does not exist', async () => {
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({
        evalOutputPath: 'does-not-exist',
        workspaceId: 'w-1',
        userId: 'u-1',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('does-not-exist')
  })

  it('sanitizes path traversal (.. removed)', async () => {
    // After the SUT strips '..', '../../../etc/sales/check-1' becomes
    // '///etc/sales/check-1', which path.join normalizes to
    // '<EVAL_DIR>/etc/sales/check-1'. We register that exact path as
    // existing to prove the lookup escapes neither past EVAL_DIR nor
    // ends up at the original traversal target.
    fs.exists.add(`${EVAL_DIR}/etc/sales/check-1`)
    fs.exists.add(`${EVAL_DIR}/etc/sales/check-1/template.json`)
    fs.files.set(`${EVAL_DIR}/etc/sales/check-1/template.json`, '{}')
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({
        evalOutputPath: '../../../etc/sales/check-1',
        workspaceId: 'w-1',
        userId: 'u-1',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(ps.createCalls).toHaveLength(1)
    expect(fs.cpCalls[0].src).toBe(`${EVAL_DIR}/etc/sales/check-1`)
    expect(fs.cpCalls[0].src.startsWith(EVAL_DIR)).toBe(true)
  })

  it('creates a project with template name/description and copies files (excluding template.json)', async () => {
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({
        evalOutputPath: 'sales/check-1',
        workspaceId: 'w-1',
        userId: 'u-1',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(ps.createCalls).toHaveLength(1)
    const data = ps.createCalls[0].data
    expect(data.name).toBe('Sales Check')
    expect(data.description).toBe('A sales eval')
    expect(data.workspaceId).toBe('w-1')
    expect(data.createdBy).toBe('u-1')
    expect(data.tier).toBe('starter')
    expect(data.status).toBe('draft')
    expect(JSON.parse(data.settings)).toEqual({ activeMode: 'canvas' })

    expect(fs.mkdirCalls).toHaveLength(1)
    expect(fs.mkdirCalls[0].opts).toEqual({ recursive: true })

    expect(fs.cpCalls).toHaveLength(1)
    expect(fs.cpCalls[0].opts.recursive).toBe(true)
    expect(fs.cpCalls[0].opts.filter('/anywhere/template.json')).toBe(false)
    expect(fs.cpCalls[0].opts.filter('/anywhere/index.ts')).toBe(true)
  })

  it('honours an explicit name override over template.json name', async () => {
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({
        evalOutputPath: 'sales/check-1',
        workspaceId: 'w-1',
        userId: 'u-1',
        name: 'Custom Project Name',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(ps.createCalls[0].data.name).toBe('Custom Project Name')
  })

  it("defaults to 'Imported Eval' when neither override nor template name is present", async () => {
    fs.files.set(`${EVAL_DIR}/sales/check-1/template.json`, '{}')
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({
        evalOutputPath: 'sales/check-1',
        workspaceId: 'w-1',
        userId: 'u-1',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(ps.createCalls[0].data.name).toBe('Imported Eval')
    expect(ps.createCalls[0].data.description).toContain('Imported from eval output')
  })

  it('tolerates a malformed template.json and still creates the project', async () => {
    fs.files.set(`${EVAL_DIR}/sales/check-1/template.json`, 'not-json{')
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({
        evalOutputPath: 'sales/check-1',
        workspaceId: 'w-1',
        userId: 'u-1',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(ps.createCalls[0].data.name).toBe('Imported Eval')
  })

  it('handles a missing template.json (file does not exist) by using defaults', async () => {
    fs.exists.delete(`${EVAL_DIR}/sales/check-1/template.json`)
    const res = await evalOutputRoutes().request('/eval-outputs/import', {
      method: 'POST',
      body: JSON.stringify({
        evalOutputPath: 'sales/check-1',
        workspaceId: 'w-1',
        userId: 'u-1',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(ps.createCalls[0].data.name).toBe('Imported Eval')
  })

  it('places the project directory under WORKSPACES_DIR when set', async () => {
    const orig = process.env.WORKSPACES_DIR
    process.env.WORKSPACES_DIR = '/tmp/test-workspaces'
    try {
      ps.createImpl = async (data) => ({ id: 'PROJ-123', ...data })
      const res = await evalOutputRoutes().request('/eval-outputs/import', {
        method: 'POST',
        body: JSON.stringify({
          evalOutputPath: 'sales/check-1',
          workspaceId: 'w-1',
          userId: 'u-1',
        }),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(res.status).toBe(200)
      expect(fs.mkdirCalls[0].path).toBe('/tmp/test-workspaces/PROJ-123')
      expect(fs.cpCalls[0].dest).toBe('/tmp/test-workspaces/PROJ-123')
    } finally {
      if (orig === undefined) delete process.env.WORKSPACES_DIR
      else process.env.WORKSPACES_DIR = orig
    }
  })
})
