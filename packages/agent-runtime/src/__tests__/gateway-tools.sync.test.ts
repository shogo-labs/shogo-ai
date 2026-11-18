// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4a — createServerSyncTool — modes, route shape, error fall-through
 *
 * SHO-403: the tool reports AND fixes the project's API server. Every mode
 * answers with the same shape, `routes` come from the running server where it
 * can be asked (`routesSource: 'server'`), and a failure carries `buildError`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-sync'

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

async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  const all = createTools(ctx)
  const t = all.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  const result = await t.execute('test-call', params)
  return { details: result.details as any, content: result.content }
}

/** A PreviewManager-shaped fake exposing only what `server_sync` reads. */
function fakeApiServer(overrides: any = {}) {
  const status = {
    phase: 'healthy',
    port: 3001,
    reloadedAt: 1_700_000_000_000,
    routes: ['users', 'posts'],
    routesSource: 'server',
    buildError: null,
  }
  return {
    apiServerPhase: 'healthy',
    apiServerUrl: 'http://localhost:0',
    projectId: 'proj-a',
    sync: async () => ({ ok: true, phase: 'healthy' }),
    getActiveRoutes: () => status.routes,
    fetchActiveRoutes: async () => ({ routes: status.routes, routesSource: status.routesSource }),
    getSchemaModels: () => ['User', 'Post'],
    apiServerStatus: async () => status,
    ensureApiServer: async () => status,
    restartApiServerOnly: async () => {},
    ...overrides,
  }
}

describe('createServerSyncTool', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })

  afterAll(() => clearTrustForTests())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('sync (default) returns activeRoutes prefixed with /api/, routesSource and schemaModels', async () => {
    const ctx = makeCtx({ resolveApiServer: () => fakeApiServer() as any })
    const r = await run(ctx, 'server_sync', {})
    expect(r.details.ok).toBe(true)
    expect(r.details.mode).toBe('sync')
    expect(r.details.project).toBe('proj-a')
    expect(r.details.phase).toBe('healthy')
    expect(r.details.port).toBe(3001)
    expect(r.details.activeRoutes).toEqual(['/api/users', '/api/posts'])
    expect(r.details.routesSource).toBe('server')
    expect(r.details.schemaModels).toEqual(['User', 'Post'])
    expect(r.details.url).toBe('http://localhost:0')
  })

  test('routesSource reports generated-files when the server could not be asked', async () => {
    const pm = fakeApiServer({
      fetchActiveRoutes: async () => ({ routes: ['users'], routesSource: 'generated-files' }),
      apiServerStatus: async () => ({
        phase: 'idle',
        port: null,
        reloadedAt: null,
        routes: ['users'],
        routesSource: 'generated-files',
        buildError: null,
      }),
    })
    const ctx = makeCtx({ resolveApiServer: () => pm as any })
    const r = await run(ctx, 'server_sync', { mode: 'status' })
    expect(r.details.phase).toBe('idle')
    expect(r.details.routesSource).toBe('generated-files')
    expect(r.details.activeRoutes).toEqual(['/api/users'])
  })

  test('status mode never syncs or restarts', async () => {
    let synced = 0
    let restarted = 0
    const pm = fakeApiServer({
      sync: async () => { synced++; return { ok: true, phase: 'healthy' } },
      restartApiServerOnly: async () => { restarted++ },
    })
    const ctx = makeCtx({ resolveApiServer: () => pm as any })
    await run(ctx, 'server_sync', { mode: 'status' })
    expect(synced).toBe(0)
    expect(restarted).toBe(0)
  })

  test('restart mode restarts the sidecar only, no regenerate', async () => {
    let synced = 0
    let restarted = 0
    const pm = fakeApiServer({
      sync: async () => { synced++; return { ok: true, phase: 'healthy' } },
      restartApiServerOnly: async () => { restarted++ },
    })
    const ctx = makeCtx({ resolveApiServer: () => pm as any })
    const r = await run(ctx, 'server_sync', { mode: 'restart' })
    expect(synced).toBe(0)
    expect(restarted).toBe(1)
    expect(r.details.mode).toBe('restart')
  })

  test('passes the requested project through to the resolver', async () => {
    const seen: Array<string | undefined> = []
    const ctx = makeCtx({
      resolveApiServer: (ref?: string) => {
        seen.push(ref)
        return fakeApiServer({ projectId: ref }) as any
      },
    })
    const r = await run(ctx, 'server_sync', { mode: 'status', project: 'proj-b' })
    expect(seen).toEqual(['proj-b'])
    expect(r.details.project).toBe('proj-b')
  })

  test('sync() throwing is surfaced as { ok:false, error, phase, buildError }', async () => {
    const pm = fakeApiServer({
      sync: async () => { throw new Error('prisma db push failed') },
      apiServerPhase: 'crashed',
    })
    const ctx = makeCtx({ resolveApiServer: () => pm as any })
    const r = await run(ctx, 'server_sync', {})
    expect(r.details.ok).toBe(false)
    expect(r.details.error).toContain('prisma db push failed')
    expect(r.details.buildError).toContain('prisma db push failed')
    expect(r.details.phase).toBe('crashed')
  })

  test('a crashed server reports ok:false with a non-empty buildError', async () => {
    const pm = fakeApiServer({
      ensureApiServer: async () => ({
        phase: 'crashed',
        port: null,
        reloadedAt: null,
        routes: [],
        routesSource: 'generated-files',
        buildError: 'SyntaxError: Unexpected token }',
      }),
      apiServerStatus: async () => ({
        phase: 'crashed',
        port: null,
        reloadedAt: null,
        routes: [],
        routesSource: 'generated-files',
        buildError: 'SyntaxError: Unexpected token }',
      }),
    })
    const ctx = makeCtx({ resolveApiServer: () => pm as any })
    const r = await run(ctx, 'server_sync', { mode: 'status' })
    expect(r.details.ok).toBe(false)
    expect(r.details.phase).toBe('crashed')
    expect(r.details.buildError).toContain('SyntaxError')
  })

  test('missing API server provider → ok:false with provider error', async () => {
    const ctx = makeCtx()
    const r = await run(ctx, 'server_sync', {})
    expect(r.details.ok).toBe(false)
    expect(r.details.error).toContain('API server provider not attached')
  })

  test('an unknown project resolver error is reported, not thrown', async () => {
    const ctx = makeCtx({
      resolveApiServer: () => { throw new Error('no such project') },
    })
    const r = await run(ctx, 'server_sync', { project: 'nope' })
    expect(r.details.ok).toBe(false)
    expect(r.details.error).toContain('no such project')
  })
})
