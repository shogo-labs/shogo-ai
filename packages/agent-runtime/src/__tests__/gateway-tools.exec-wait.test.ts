// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4a — createExecWaitTool — pattern, cached, timeout_ms=0, regex error
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import { FileStateCache } from '../file-state-cache'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-exec-wait'

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


describe('createExecWaitTool', () => {
  
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })

  afterAll(() => clearTrustForTests())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('no commandRegistry on context → error', async () => {
    const ctx = makeCtx()
    const r = await run(ctx, 'exec_wait', { run_id: 'cmd_x' })
    expect(r.details.error).toContain('CommandRegistry not available')
  })

  test('unknown run_id → error mentions the missing id', async () => {
    const ctx = makeCtx({ commandRegistry: new CommandRegistry() })
    const r = await run(ctx, 'exec_wait', { run_id: 'cmd_missing' })
    expect(r.details.error).toContain('Unknown run_id')
    expect(r.details.error).toContain('cmd_missing')
  })

  test('timeout_ms=0 returns running snapshot without blocking', async () => {
    const registry = new CommandRegistry()
    const ctx = makeCtx({ commandRegistry: registry })
    const launched = (await run(ctx, 'exec', { command: 'sleep 5', timeout: 50 })).details
    expect(launched.status).toBe('running')

    const start = Date.now()
    const r = await run(ctx, 'exec_wait', { run_id: launched.run_id, timeout_ms: 0 })
    const elapsed = Date.now() - start
    expect(r.details.status).toBe('running')
    expect(r.details.run_id).toBe(launched.run_id)
    expect(elapsed).toBeLessThan(500)
    try { registry.get(launched.run_id)?.handle.kill('SIGKILL') } catch {}
  })

  test('cached finalResult is returned without re-waiting', async () => {
    const registry = new CommandRegistry()
    const ctx = makeCtx({ commandRegistry: registry })
    const seeded = (await run(ctx, 'exec', { command: 'true' })).details
    await new Promise(r => setTimeout(r, 50))
    expect(registry.get(seeded.run_id)?.finalResult).toBeDefined()
    const r = await run(ctx, 'exec_wait', { run_id: seeded.run_id })
    expect(r.details.exitCode).toBe(0)
    expect(r.details.run_id).toBe(seeded.run_id)
  })

  test('invalid regex pattern → error mentions Invalid pattern regex', async () => {
    const registry = new CommandRegistry()
    const ctx = makeCtx({ commandRegistry: registry })
    const launched = (await run(ctx, 'exec', { command: 'sleep 5', timeout: 50 })).details
    expect(launched.status).toBe('running')
    const r = await run(ctx, 'exec_wait', { run_id: launched.run_id, pattern: '[unclosed', timeout_ms: 0 })
    expect(r.details.error).toContain('Invalid pattern regex')
    try { registry.get(launched.run_id)?.handle.kill('SIGKILL') } catch {}
  })

  test('soft-timeout exhausted while still running returns running snapshot', async () => {
    const registry = new CommandRegistry()
    const ctx = makeCtx({ commandRegistry: registry })
    const launched = (await run(ctx, 'exec', { command: 'sleep 5', timeout: 50 })).details
    const start = Date.now()
    const r = await run(ctx, 'exec_wait', { run_id: launched.run_id, timeout_ms: 80 })
    const elapsed = Date.now() - start
    expect(r.details.status).toBe('running')
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(2000)
    try { registry.get(launched.run_id)?.handle.kill('SIGKILL') } catch {}
  })
})
