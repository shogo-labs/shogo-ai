// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4a — createServerSyncTool — phases, route shape, error fall-through
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import { FileStateCache } from '../file-state-cache'
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
  return { details: result.details, content: result.content }
}


function fakeSkillServerManager(overrides: any = {}) {
  return {
    phase: 'ready',
    url: 'http://localhost:0',
    sync: async () => ({ ok: true, phase: 'ready' }),
    getActiveRoutes: () => ['users', 'posts'],
    getSchemaModels: () => ['User', 'Post'],
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

  test('returns activeRoutes prefixed with /api/ and schemaModels', async () => {
    const ctx = makeCtx({ skillServerManager: fakeSkillServerManager() as any })
    const r = await run(ctx, 'server_sync', {})
    expect(r.details.ok).toBe(true)
    expect(r.details.phase).toBe('ready')
    expect(r.details.activeRoutes).toEqual(['/api/users', '/api/posts'])
    expect(r.details.schemaModels).toEqual(['User', 'Post'])
    expect(r.details.url).toBe('http://localhost:0')
  })

  test('sync() throwing is surfaced as { ok:false, error, phase }', async () => {
    const ssm = fakeSkillServerManager({
      sync: async () => { throw new Error('prisma db push failed') },
      phase: 'pushing-db',
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await run(ctx, 'server_sync', {})
    expect(r.details.ok).toBe(false)
    expect(r.details.error).toContain('prisma db push failed')
    expect(r.details.phase).toBe('pushing-db')
  })

  test('missing skillServerManager → ok:false with provider error', async () => {
    const ctx = makeCtx()
    const r = await run(ctx, 'server_sync', {})
    expect(r.details.ok).toBe(false)
    expect(r.details.error).toContain('API server provider not attached')
  })

  test('sync() returning ok:false propagates the phase from the result', async () => {
    const ssm = fakeSkillServerManager({
      sync: async () => ({ ok: false, phase: 'generating' }),
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await run(ctx, 'server_sync', {})
    expect(r.details.ok).toBe(false)
    expect(r.details.phase).toBe('generating')
  })
})
