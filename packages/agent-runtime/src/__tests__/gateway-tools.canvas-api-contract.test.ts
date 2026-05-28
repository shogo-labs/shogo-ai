// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas-API contract write-time hint.
 *
 * When the agent writes (or edits) a canvas/React file containing a static
 * `fetch('/api/<segment>')` for a segment with no matching server route,
 * the tool result must include a `canvasApiContract.warning` field that
 * names the orphaned routes and points at the two valid fixes (Prisma
 * model OR custom Hono route in server.tsx).
 *
 * This catches the "fetches non-existent route" failure mode in the MiMo
 * eval analysis (Bucket F1) at the moment the agent writes the bad
 * fetch, rather than waiting for the post-eval runtime check.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

import { createTools, type ToolContext } from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-canvas-api-contract'

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
    ...overrides,
  }
}

function fakeSkillServerManager(activeRoutes: string[]) {
  return {
    phase: 'ready',
    url: 'http://localhost:0',
    sync: async () => ({ ok: true, phase: 'ready' }),
    getActiveRoutes: () => activeRoutes,
    getSchemaModels: () => [],
    restartApiServerOnly: async () => {},
  }
}

async function runWrite(ctx: ToolContext, path: string, content: string) {
  const tool = createTools(ctx).find(t => t.name === 'write_file')!
  const result = await tool.execute('call-1', { path, content })
  return result.details as any
}

async function runEdit(ctx: ToolContext, path: string, oldStr: string, newStr: string) {
  const tool = createTools(ctx).find(t => t.name === 'edit_file')!
  const result = await tool.execute('call-1', { path, old_string: oldStr, new_string: newStr })
  return result.details as any
}

describe('canvas-API contract — write_file', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))
  afterAll(() => clearTrustForTests())

  test('flags fetch to non-existent route on src/*.tsx write', async () => {
    const ssm = fakeSkillServerManager(['users', 'posts'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'src/App.tsx',
      `import { useEffect } from 'react'
       export default function App() {
         useEffect(() => {
           fetch('/api/leads').then(r => r.json())
         }, [])
         return <div>app</div>
       }`,
    )
    expect(r.ok).toBe(true)
    expect(r.canvasApiContract).toBeDefined()
    expect(r.canvasApiContract.orphanedFetches).toEqual(['/api/leads'])
    expect(r.canvasApiContract.activeRoutes).toEqual(['/api/users', '/api/posts'])
    expect(r.canvasApiContract.warning).toContain('/api/leads')
    expect(r.canvasApiContract.warning).toContain('Prisma model')
    expect(r.canvasApiContract.warning).toContain('server.tsx')
  })

  test('does NOT flag fetches that match an active route', async () => {
    const ssm = fakeSkillServerManager(['users', 'leads'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'src/App.tsx',
      `fetch('/api/leads').then(r => r.json())`,
    )
    expect(r.canvasApiContract).toBeUndefined()
  })

  test('case-insensitive route matching (LEADS vs leads)', async () => {
    const ssm = fakeSkillServerManager(['Leads'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'src/x.tsx', `fetch('/api/leads')`)
    expect(r.canvasApiContract).toBeUndefined()
  })

  test('skips files outside src/ and canvas/', async () => {
    const ssm = fakeSkillServerManager(['users'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    // server.tsx contains the *handler* for /api/leads — flagging it
    // would be a false positive, since registering the route here is
    // exactly what makes the contract valid.
    const r = await runWrite(
      ctx,
      'server.tsx',
      `app.get('/api/leads', async () => fetch('/api/leads'))`,
    )
    expect(r.canvasApiContract).toBeUndefined()
  })

  test('skips generated CRUD output (src/generated/...)', async () => {
    const ssm = fakeSkillServerManager(['users'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'src/generated/api-client.tsx',
      `export const fetchLeads = () => fetch('/api/leads').then(r => r.json())`,
    )
    expect(r.canvasApiContract).toBeUndefined()
  })

  test('flags multiple distinct orphaned routes (deduped)', async () => {
    const ssm = fakeSkillServerManager(['users'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'src/App.tsx',
      `fetch('/api/leads')
       fetch('/api/leads') // duplicate, should not duplicate the warning
       fetch('/api/deals')
       fetch('/api/users')`, // valid
    )
    expect(r.canvasApiContract.orphanedFetches.sort()).toEqual(['/api/deals', '/api/leads'])
  })

  test('does nothing when there is no skillServerManager', async () => {
    const ctx = makeCtx() // no skillServerManager
    const r = await runWrite(ctx, 'src/App.tsx', `fetch('/api/anything')`)
    expect(r.canvasApiContract).toBeUndefined()
    expect(r.ok).toBe(true)
  })

  test('does nothing when the file has no static fetches', async () => {
    const ssm = fakeSkillServerManager(['users'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'src/utils.ts',
      `export function add(a: number, b: number) { return a + b }`,
    )
    expect(r.canvasApiContract).toBeUndefined()
  })

  test('ignores dynamic fetch paths (template literals with interpolation)', async () => {
    // Dynamic paths are intentionally not flagged — the regex only matches
    // static segments. Dropping a 404-prone `/api/${id}` is also a real
    // bug, but it's harder to catch reliably from static analysis.
    const ssm = fakeSkillServerManager(['users'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'src/App.tsx',
      'const id = "abc"; fetch(`/api/${id}`)',
    )
    expect(r.canvasApiContract).toBeUndefined()
  })

  test('matches absolute http://localhost:<port>/api/<seg>', async () => {
    const ssm = fakeSkillServerManager(['users'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'src/App.tsx',
      `fetch('http://localhost:3001/api/leads').then(r => r.json())`,
    )
    expect(r.canvasApiContract.orphanedFetches).toEqual(['/api/leads'])
  })

  test('flags fetches inside canvas/ files too', async () => {
    const ssm = fakeSkillServerManager(['users'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'canvas/widget.tsx',
      `fetch('/api/leads').then(r => r.json())`,
    )
    expect(r.canvasApiContract.orphanedFetches).toEqual(['/api/leads'])
  })
})

describe('canvas-API contract — edit_file', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(
      join(TEST_DIR, 'src/App.tsx'),
      `function App() { return <div>before</div> }`,
    )
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

  test('edit that introduces an orphaned fetch is flagged', async () => {
    const ssm = fakeSkillServerManager(['users'])
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runEdit(
      ctx,
      'src/App.tsx',
      'function App() { return <div>before</div> }',
      `function App() {
         fetch('/api/leads').then(r => r.json())
         return <div>after</div>
       }`,
    )
    expect(r.ok).toBe(true)
    expect(r.canvasApiContract).toBeDefined()
    expect(r.canvasApiContract.orphanedFetches).toEqual(['/api/leads'])
  })
})
