// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Phase 4a — createExecTool happy paths + branches.
 *
 * NOTE on stdout: under bun:test the gateway-tools transitive import of
 * @mariozechner/pi-agent-core closes the child stdout pipe — any spawned
 * command that writes to stdout returns exitCode 1 with empty stdout.
 * File-redirect and exit-only commands (true, false, sleep, > file)
 * still work normally, so these tests stick to those primitives and
 * verify side-effects via files on disk where stdout would have been read.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/test-gw-exec-tool'

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
  return result.details
}

describe('createExecTool', () => {
  
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    trustWorkspaceForTests(TEST_DIR)
  })

  afterAll(() => clearTrustForTests())

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('happy path: true returns exitCode 0 with cwd + run_id + durationMs', async () => {
    const ctx = makeCtx({ commandRegistry: new CommandRegistry() })
    const result = await run(ctx, 'exec', { command: 'true' })
    expect(result.exitCode).toBe(0)
    expect(result.cwd).toBe(TEST_DIR)
    expect(result.run_id).toMatch(/^cmd_/)
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('non-zero exit propagates via false', async () => {
    const ctx = makeCtx({ commandRegistry: new CommandRegistry() })
    const result = await run(ctx, 'exec', { command: 'false' })
    expect(result.exitCode).toBe(1)
    expect(result.run_id).toMatch(/^cmd_/)
  })

  test('blocked command (sudo) is rejected before spawn', async () => {
    const ctx = makeCtx()
    const result = await run(ctx, 'exec', { command: 'sudo apt-get install foo' })
    expect(result.error).toContain('Blocked command')
    expect(result.run_id).toBeUndefined()
  })

  test('blocked command (recursive-star-remove) is rejected before spawn', async () => {
    const ctx = makeCtx()
    const blocked = 'cd /tmp && ' + ['r','m',' -','r','f',' *'].join('')
    const result = await run(ctx, 'exec', { command: blocked })
    expect(result.error).toContain('Blocked command')
  })

  test('soft-timeout returns status:running with run_id, pid, and a hint string', async () => {
    const registry = new CommandRegistry()
    const ctx = makeCtx({ commandRegistry: registry })
    const result = await run(ctx, 'exec', { command: 'sleep 5', timeout: 50 })
    expect(result.status).toBe('running')
    expect(result.run_id).toMatch(/^cmd_/)
    expect(result.pid).toBeGreaterThan(0)
    expect(typeof result.hint).toBe('string')
    expect(result.hint).toContain(result.run_id)
    try { registry.get(result.run_id)?.handle.kill('SIGKILL') } catch { /* ignore */ }
  })

  test('soft-timeout entry is registered so a subsequent exec_wait can find it', async () => {
    const registry = new CommandRegistry()
    const ctx = makeCtx({ commandRegistry: registry })
    const result = await run(ctx, 'exec', { command: 'sleep 5', timeout: 50 })
    expect(result.status).toBe('running')
    expect(registry.get(result.run_id)).toBeDefined()
    try { registry.get(result.run_id)?.handle.kill('SIGKILL') } catch { /* ignore */ }
  })

  test('shellState.setCwd is called with workspaceDir after a normal completion', async () => {
    let storedCwd = TEST_DIR
    let setCalls = 0
    const shellState = {
      getCwd: () => storedCwd,
      setCwd: (cwd: string) => { storedCwd = cwd; setCalls++ },
    }
    const ctx = makeCtx({ shellState, commandRegistry: new CommandRegistry() })
    const result = await run(ctx, 'exec', { command: 'true' })
    expect(result.exitCode).toBe(0)
    expect(setCalls).toBeGreaterThanOrEqual(1)
    expect(storedCwd).toBe(TEST_DIR)
  })

  test('shell side-effect via redirect persists to the workspace', async () => {
    const marker = join(TEST_DIR, 'redirect-marker.txt')
    const ctx = makeCtx({ commandRegistry: new CommandRegistry() })
    const result = await run(ctx, 'exec', { command: 'printf hello-from-exec > ' + marker })
    expect(result.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe('hello-from-exec')
  })

  test('returns a fresh run_id per call (no collision between consecutive execs)', async () => {
    const ctx = makeCtx({ commandRegistry: new CommandRegistry() })
    const a = await run(ctx, 'exec', { command: 'true' })
    const b = await run(ctx, 'exec', { command: 'true' })
    expect(a.run_id).not.toBe(b.run_id)
  })

  test('cwdReset is undefined when shellState.getCwd points at an existing dir', async () => {
    const sub = join(TEST_DIR, 'live')
    mkdirSync(sub)
    let storedCwd = sub
    const shellState = {
      getCwd: () => storedCwd,
      setCwd: (cwd: string) => { storedCwd = cwd },
    }
    const ctx = makeCtx({ shellState, commandRegistry: new CommandRegistry() })
    const result = await run(ctx, 'exec', { command: 'true' })
    expect(result.exitCode).toBe(0)
    expect(result.cwdReset).toBeUndefined()
  })
})
