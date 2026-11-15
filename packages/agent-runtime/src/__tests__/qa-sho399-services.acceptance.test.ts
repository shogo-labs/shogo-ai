// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-399 §3 — `exec({ background: true, service: true })` end to end, through
 * the real tool: it declares the service, restarts it on the next boot, and
 * `task_cancel` is the only way to undeclare one.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createTools, type ToolContext } from '../gateway-tools'
import { CommandRegistry } from '../command-registry'
import { readDeclaredServices } from '../services-registry'
import { AgentGateway } from '../gateway'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const TEST_DIR = '/tmp/qa-sho399-services'

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
    sessionId: 'chat',
    ...overrides,
  }
}

async function run(ctx: ToolContext, name: string, params: Record<string, any>) {
  const all = createTools(ctx)
  const t = all.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return (await t.execute('test-call', params)).details as any
}

let registry: CommandRegistry

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, '.shogo'), { recursive: true })
  mkdirSync(join(TEST_DIR, '.tmp'), { recursive: true })
  trustWorkspaceForTests(TEST_DIR)
  registry = new CommandRegistry()
})

afterEach(async () => {
  await registry.killAll().catch(() => {})
  clearTrustForTests()
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('a declared service', () => {
  test('service: true writes .shogo/services.json and marks the task', async () => {
    const ctx = makeCtx({ commandRegistry: registry })
    const result = await run(ctx, 'exec', { command: 'sleep 30', background: true, service: true, name: 'sleeper' })
    expect(result.error).toBeUndefined()
    expect(result.service).toBe('sleeper')
    expect(result.task_id).toMatch(/^t_/)

    const declared = readDeclaredServices(TEST_DIR)
    expect(declared).toHaveLength(1)
    expect(declared[0]).toMatchObject({ name: 'sleeper', command: 'sleep 30', sessionId: 'chat', cwd: TEST_DIR })

    // task_list marks it, so the agent can tell a service from a stray command.
    const listed = await run(ctx, 'task_list', {})
    expect(listed.tasks.find((t: any) => t.task_id === result.task_id).service).toBe(true)
  })

  test('service: true without background is refused before anything spawns', async () => {
    const ctx = makeCtx({ commandRegistry: registry })
    const result = await run(ctx, 'exec', { command: 'sleep 30', service: true })
    expect(String(result.error)).toContain('service: true needs background: true')
    expect(readDeclaredServices(TEST_DIR)).toEqual([])
  })

  test('a .tmp/ reference comes back with the warning', async () => {
    const ctx = makeCtx({ commandRegistry: registry })
    const result = await run(ctx, 'exec', {
      command: 'sleep 30 && cat .tmp/tunnel.env',
      background: true,
      service: true,
      name: 'tunnel',
    })
    expect(String(result.warning)).toContain('.tmp/` is not kept across a recycle')
  })

  test('a name that is not given defaults to the command', async () => {
    const ctx = makeCtx({ commandRegistry: registry })
    const result = await run(ctx, 'exec', { command: 'sleep 30', background: true, service: true })
    expect(result.service).toBe('sleep 30')
  })

  test('task_cancel undeclares it, so the next boot does not restart it', async () => {
    const ctx = makeCtx({ commandRegistry: registry })
    const started = await run(ctx, 'exec', { command: 'sleep 30', background: true, service: true, name: 'sleeper' })
    expect(readDeclaredServices(TEST_DIR)).toHaveLength(1)

    const cancelled = await run(ctx, 'task_cancel', { task_id: started.task_id })
    expect(cancelled.ok).toBe(true)
    expect(cancelled.undeclared_service).toBe('sleeper')
    expect(readDeclaredServices(TEST_DIR)).toEqual([])
  })
})

describe('where the registry lives (SHO-399)', () => {
  const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> => {
    const keys = ['WORKSPACE_RUNTIME', 'WORKSPACE_ANCHOR_PROJECT_ID']
    const saved = new Map(keys.map((k) => [k, process.env[k]]))
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      return await fn()
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  test('a workspace runtime writes into the anchor member, whose tree IS backed up', async () => {
    mkdirSync(join(TEST_DIR, 'anchor-1', '.shogo'), { recursive: true })
    await withEnv({ WORKSPACE_RUNTIME: 'true', WORKSPACE_ANCHOR_PROJECT_ID: 'anchor-1' }, async () => {
      const ctx = makeCtx({ commandRegistry: registry })
      await run(ctx, 'exec', { command: 'sleep 30', background: true, service: true, name: 'wa-gateway' })
      // A workspace runtime's ROOT tree is in no backup — a recycle restores
      // each member's tree only — so a root copy would be gone on the very
      // recycle this declaration exists to survive.
      expect(existsSync(join(TEST_DIR, '.shogo', 'services.json'))).toBe(false)
      expect(existsSync(join(TEST_DIR, 'anchor-1', '.shogo', 'services.json'))).toBe(true)
      expect(readDeclaredServices(TEST_DIR).map((s) => s.name)).toEqual(['wa-gateway'])
    })
  })

  test('a project runtime keeps the root, which its own source backup carries', async () => {
    await withEnv({ WORKSPACE_RUNTIME: undefined, WORKSPACE_ANCHOR_PROJECT_ID: undefined }, () => {
      const ctx = makeCtx({ commandRegistry: registry })
      return run(ctx, 'exec', { command: 'sleep 30', background: true, service: true, name: 'tunnel' })
    })
    expect(existsSync(join(TEST_DIR, '.shogo', 'services.json'))).toBe(true)
  })

  test('a declaration already at the root is still honoured', async () => {
    writeFileSync(
      join(TEST_DIR, '.shogo', 'services.json'),
      JSON.stringify({ services: [{ name: 'legacy', command: 'sleep 30', cwd: TEST_DIR, sessionId: 'chat', declaredAt: 1 }] }),
    )
    mkdirSync(join(TEST_DIR, 'anchor-1'), { recursive: true })
    await withEnv({ WORKSPACE_RUNTIME: 'true', WORKSPACE_ANCHOR_PROJECT_ID: 'anchor-1' }, () => {
      expect(readDeclaredServices(TEST_DIR).map((s) => s.name)).toEqual(['legacy'])
    })
  })
})

describe('a gateway restart', () => {
  test('restarts every declared service into its own session', async () => {
    // Declare one as the tool would, then boot a fresh gateway over the same
    // workspace: this is exactly the cold-boot / post-recycle path.
    const ctx = makeCtx({ commandRegistry: registry })
    await run(ctx, 'exec', { command: 'sleep 30', background: true, service: true, name: 'sleeper' })
    await registry.killAll().catch(() => {})

    const gateway = new AgentGateway(TEST_DIR, 'test')
    const out = await gateway.restartDeclaredServices()
    expect(out.failed).toEqual([])
    expect(out.restarted).toEqual(['sleeper'])

    const sessions = (gateway as any).commandRegistries as Map<string, CommandRegistry>
    const chatRegistry = sessions.get('chat')
    expect(chatRegistry).toBeDefined()
    const rows = chatRegistry!.listAll()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.service).toBe(true)
    expect(rows[0]!.status).toBe('running')
    await chatRegistry!.killAll().catch(() => {})
  }, 20_000)
})
