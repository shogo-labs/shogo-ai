// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4b — gateway-tools branches + error paths.
 *
 * Targets the post-write hooks that fire when the agent writes
 * `prisma/schema.prisma` or `custom-routes.ts`:
 *
 *   - `maybeSchemaSync` (gateway-tools.ts:964) — model-detection gate,
 *     happy path, sync()-throws, orphaned-fetch warning.
 *   - `maybeCustomRoutesSync` (gateway-tools.ts:1025) — drift-heal
 *     branches: noop, regenerate (SDK auto-gen), patched (hand-edited),
 *     failed, drift-check exception, fast-restart throw.
 *   - `formatToolInstallMessage` (gateway-tools.ts:3265) — three auth
 *     branches (active / authUrl present / needs_auth fallback).
 *
 * No real Prisma, no real Hono — `skillServerManager` is a fake whose
 * methods we instrument. `server-tsx-drift` runs against real on-disk
 * fixtures so the drift detection logic itself is also exercised.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  createTools,
  formatToolInstallMessage,
  type ToolContext,
} from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-sync-branches'

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

function fakeSkillServerManager(overrides: Record<string, any> = {}) {
  return {
    phase: 'ready',
    url: 'http://localhost:0',
    sync: async () => ({ ok: true, phase: 'ready' }),
    getActiveRoutes: () => ['users', 'posts'],
    getSchemaModels: () => ['User', 'Post'],
    restartApiServerOnly: async () => {},
    ...overrides,
  }
}

async function runWrite(ctx: ToolContext, path: string, content: string) {
  const tool = createTools(ctx).find(t => t.name === 'write_file')!
  const result = await tool.execute('call-1', { path, content })
  return result.details
}

function writeShogoConfig(opts: { customRoutesPath?: string; apiBasePath?: string; ext?: string }) {
  const config = {
    outputs: [
      {
        generate: ['server'],
        fileExtension: opts.ext ?? 'tsx',
        serverConfig: {
          customRoutesPath: opts.customRoutesPath ?? './custom-routes',
          apiBasePath: opts.apiBasePath ?? '/api',
        },
      },
    ],
  }
  writeFileSync(join(TEST_DIR, 'shogo.config.json'), JSON.stringify(config, null, 2))
}

describe('maybeSchemaSync — branches via write_file(prisma/schema.prisma)', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))
  afterAll(() => clearTrustForTests())

  test('no skillServerManager → returns base result (no apiServer block)', async () => {
    const ctx = makeCtx()
    const r = await runWrite(ctx, 'prisma/schema.prisma', 'model User { id Int @id }\n')
    expect(r.ok).toBe(true)
    expect(r.path).toBe('prisma/schema.prisma')
    expect((r as any).apiServer).toBeUndefined()
  })

  test('schema with no model { ... } blocks → skipped (no sync triggered)', async () => {
    let syncCalls = 0
    const ssm = fakeSkillServerManager({ sync: async () => { syncCalls++; return { ok: true, phase: 'ready' } } })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'prisma/schema.prisma', '// just comments, no models\n')
    expect(r.ok).toBe(true)
    expect((r as any).apiServer).toBeUndefined()
    expect(syncCalls).toBe(0)
  })

  test('happy path → activeRoutes prefixed with /api/, no warning when no orphaned fetches', async () => {
    const ssm = fakeSkillServerManager()
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(
      ctx,
      'prisma/schema.prisma',
      'generator client { provider = "prisma-client-js" }\nmodel User { id Int @id }\n',
    )
    expect((r as any).apiServer.synced).toBe(true)
    expect((r as any).apiServer.phase).toBe('ready')
    expect((r as any).apiServer.activeRoutes).toEqual(['/api/users', '/api/posts'])
    expect((r as any).apiServer.orphanedFetches).toBeUndefined()
    expect((r as any).apiServer.warning).toBeUndefined()
  })

  test('sync() throws → synced:false with error + hint, schema content not deleted', async () => {
    const ssm = fakeSkillServerManager({
      sync: async () => { throw new Error('prisma db push failed: SQLITE_BUSY') },
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'prisma/schema.prisma', 'model User { id Int @id }\n')
    expect((r as any).apiServer.synced).toBe(false)
    expect((r as any).apiServer.error).toContain('SQLITE_BUSY')
    expect((r as any).apiServer.hint).toContain('Check the schema')
    expect(existsSync(join(TEST_DIR, 'prisma/schema.prisma'))).toBe(true)
  })

  test('orphaned fetches detected → warning + orphanedFetches list (deduped)', async () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(
      join(TEST_DIR, 'src/App.tsx'),
      `
      function load() {
        fetch('/api/leads').then(r => r.json())
        fetch('/api/leads') // dup — should be dedup'd
        fetch('/api/users') // matches an active route
      }
      `,
    )
    const ssm = fakeSkillServerManager({ getActiveRoutes: () => ['users', 'posts'] })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'prisma/schema.prisma', 'model User { id Int @id }\n')
    const apiServer = (r as any).apiServer
    expect(apiServer.synced).toBe(true)
    expect(apiServer.orphanedFetches).toBeDefined()
    const routes = apiServer.orphanedFetches.map((o: any) => o.route)
    expect(routes).toContain('/api/leads')
    expect(routes.filter((x: string) => x === '/api/leads').length).toBe(1)
    expect(apiServer.warning).toContain('Your schema is missing models')
  })
})

describe('maybeCustomRoutesSync — drift heal branches via write_file(custom-routes.ts)', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))
  afterAll(() => clearTrustForTests())

  test('no skillServerManager → returns base result, no apiServer block', async () => {
    const ctx = makeCtx()
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    expect(r.ok).toBe(true)
    expect((r as any).apiServer).toBeUndefined()
  })

  test('no shogo.config.json → drift check returns drifted:false, fast restart path runs', async () => {
    let restartCalls = 0
    const ssm = fakeSkillServerManager({
      restartApiServerOnly: async () => { restartCalls++ },
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    expect((r as any).apiServer.serverRestarted).toBe(true)
    expect((r as any).apiServer.phase).toBe('ready')
    expect(restartCalls).toBe(1)
    expect((r as any).apiServer.hint).toContain('custom-routes.ts changes are live')
  })

  test('restartApiServerOnly throws on fast path → serverRestarted:false with error + hint', async () => {
    const ssm = fakeSkillServerManager({
      restartApiServerOnly: async () => { throw new Error('port 38554 in use') },
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    expect((r as any).apiServer.serverRestarted).toBe(false)
    expect((r as any).apiServer.error).toContain('port 38554 in use')
    expect((r as any).apiServer.hint).toContain('syntax errors')
  })

  test('drift detected, SDK auto-generated server.tsx → regenerate branch calls sync()', async () => {
    writeShogoConfig({ customRoutesPath: './custom-routes' })
    writeFileSync(
      join(TEST_DIR, 'server.tsx'),
      `// Auto-generated by @shogo-ai/sdk\n` +
      `import { Hono } from 'hono'\n` +
      `const app = new Hono()\n` +
      `export default app\n`,
    )
    let syncCalls = 0
    const ssm = fakeSkillServerManager({
      sync: async () => { syncCalls++; return { ok: true, phase: 'ready' } },
      restartApiServerOnly: async () => { throw new Error('should not be called') },
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    expect(syncCalls).toBe(1)
    expect((r as any).apiServer.regenerated).toBe(true)
    expect((r as any).apiServer.serverRestarted).toBe(true)
    expect((r as any).apiServer.hint).toContain('Regenerated from shogo.config.json')
  })

  test('drift detected, regenerate branch + sync() returning ok:false → error surfaced', async () => {
    writeShogoConfig({ customRoutesPath: './custom-routes' })
    writeFileSync(
      join(TEST_DIR, 'server.tsx'),
      `// Auto-generated by @shogo-ai/sdk\nimport { Hono } from 'hono'\nexport default new Hono()\n`,
    )
    const ssm = fakeSkillServerManager({
      sync: async () => ({ ok: false, phase: 'failed', error: 'codegen failed' }),
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    expect((r as any).apiServer.regenerated).toBe(true)
    expect((r as any).apiServer.phase).toBe('failed')
    expect((r as any).apiServer.error).toBe('codegen failed')
  })

  test('drift detected, hand-edited server.tsx → patched branch, restart called', async () => {
    writeShogoConfig({ customRoutesPath: './custom-routes' })
    writeFileSync(
      join(TEST_DIR, 'server.tsx'),
      `// I wrote this myself, totally hand-rolled, no auto-gen marker\n` +
      `import { Hono } from 'hono'\n` +
      `import { serve } from '@hono/node-server'\n\n` +
      `const app = new Hono()\n` +
      `app.get('/', (c) => c.text('hi'))\n\n` +
      `export default app\n`,
    )
    let restartCalls = 0
    let syncCalls = 0
    const ssm = fakeSkillServerManager({
      sync: async () => { syncCalls++; return { ok: true, phase: 'ready' } },
      restartApiServerOnly: async () => { restartCalls++ },
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    expect(restartCalls).toBe(1)
    expect(syncCalls).toBe(0)
    expect((r as any).apiServer.patched).toBe(true)
    expect((r as any).apiServer.serverRestarted).toBe(true)
    expect((r as any).apiServer.hint).toContain('Inserted the two')

    const patched = readFileSync(join(TEST_DIR, 'server.tsx'), 'utf-8')
    expect(patched).toContain("from './custom-routes'")
    expect(patched).toMatch(/app\.route\(\s*['"]\/api['"]\s*,\s*customRoutes\s*\)/)
  })

  test('drift check throws (corrupt shogo.config.json) → swallowed, fast restart still runs', async () => {
    writeFileSync(join(TEST_DIR, 'shogo.config.json'), '{ this is not valid json ::')
    writeFileSync(join(TEST_DIR, 'server.tsx'), 'export default {}\n')
    let restartCalls = 0
    const ssm = fakeSkillServerManager({
      restartApiServerOnly: async () => { restartCalls++ },
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    expect(restartCalls).toBe(1)
    expect((r as any).apiServer.serverRestarted).toBe(true)
  })

  test('drift detected but already healed (idempotent noop) → falls through to fast restart', async () => {
    writeShogoConfig({ customRoutesPath: './custom-routes' })
    writeFileSync(
      join(TEST_DIR, 'server.tsx'),
      `import { Hono } from 'hono'\n` +
      `import customRoutes from './custom-routes'\n\n` +
      `const app = new Hono()\n` +
      `app.route('/api', customRoutes)\n\n` +
      `export default app\n`,
    )
    let restartCalls = 0
    const ssm = fakeSkillServerManager({
      restartApiServerOnly: async () => { restartCalls++ },
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    expect(restartCalls).toBe(1)
    expect((r as any).apiServer.serverRestarted).toBe(true)
    expect((r as any).apiServer.regenerated).toBeUndefined()
    expect((r as any).apiServer.patched).toBeUndefined()
  })

  test('drift detected, hand-edited server.tsx with no import anchors → failed branch with hint', async () => {
    writeShogoConfig({ customRoutesPath: './custom-routes' })
    // Hand-edited (no auto-gen marker) AND no top-level imports → insertImport
    // can't find an anchor → healServerTsxDrift returns mode: 'failed'.
    writeFileSync(
      join(TEST_DIR, 'server.tsx'),
      `// I wrote this myself\nconst app = { route: () => {} }\nexport default app\n`,
    )
    let restartCalls = 0
    const ssm = fakeSkillServerManager({
      restartApiServerOnly: async () => { restartCalls++ },
    })
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.ts', 'export default {} as any\n')
    const api = (r as any).apiServer
    expect(api.serverRestarted).toBe(false)
    expect(String(api.error)).toContain('self-heal failed')
    expect(String(api.error)).toContain('could not locate a place to insert')
    expect(String(api.hint)).toContain("import customRoutes from")
    expect(String(api.hint)).toContain("app.route(")
    expect(restartCalls).toBe(0)
  })

  test('custom-routes.tsx (with x) extension also triggers the sync path', async () => {
    const ssm = fakeSkillServerManager()
    const ctx = makeCtx({ skillServerManager: ssm as any })
    const r = await runWrite(ctx, 'custom-routes.tsx', 'export default {} as any\n')
    expect((r as any).apiServer.serverRestarted).toBe(true)
  })
})

describe('formatToolInstallMessage — auth branches', () => {
  test('auth.status !== needs_auth → "Auth is active" line', () => {
    const msg = formatToolInstallMessage('googlecalendar', ['GCAL_LIST', 'GCAL_CREATE'], { status: 'active' })
    expect(msg).toContain('"googlecalendar" installed with 2 tool(s)')
    expect(msg).toContain('Auth is active')
    expect(msg).not.toContain('Connect button')
    expect(msg).toContain('GCAL_LIST')
  })

  test('auth needs_auth + authUrl present → Connect button instruction, never leaks URL', () => {
    const msg = formatToolInstallMessage(
      'slack',
      ['SLACK_SEND_MESSAGE'],
      { status: 'needs_auth', authUrl: 'https://oauth.example/connect?secret=abc123' },
    )
    expect(msg).toContain('Connect button')
    expect(msg).not.toContain('abc123')
    expect(msg).not.toContain('https://oauth.example')
    expect(msg).toContain('SLACK_SEND_MESSAGE')
  })

  test('auth needs_auth without authUrl → fallback Tools-panel message', () => {
    const msg = formatToolInstallMessage('jira', ['JIRA_LIST_BOARDS'], { status: 'needs_auth' })
    expect(msg).toContain('Auth status: needs_auth')
    expect(msg).toContain('Tools panel')
    expect(msg).not.toContain('Connect button')
  })

  test('empty toolNames → still renders sample placeholder', () => {
    const msg = formatToolInstallMessage('mystery', [], { status: 'active' })
    expect(msg).toContain('MYSTERY_<TOOL>')
    expect(msg).toContain('installed with 0 tool(s)')
  })

  test('>5 tool names → truncated with ", ..." in the example list', () => {
    const tools = ['A_ONE', 'A_TWO', 'A_THREE', 'A_FOUR', 'A_FIVE', 'A_SIX', 'A_SEVEN']
    const msg = formatToolInstallMessage('a', tools, { status: 'active' })
    expect(msg).toContain('A_ONE, A_TWO, A_THREE, A_FOUR, A_FIVE, ...')
    expect(msg).not.toContain('A_SIX')
  })
})
