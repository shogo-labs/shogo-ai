// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-123 acceptance — QA. A background `agent_spawn` that fails must finish its
 * task with the cause, because the `[Task update]` is the only thing the parent
 * ever sees for it. The foreground path is covered by
 * `gateway-tools.agent-spawn.test.ts`; this is the branch that turns a failure
 * into a note, which is where the placeholder used to come from.
 */

import { describe, test, expect, mock } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { TaskRegistry, formatTaskNotification } from '../task-registry'
import { taskOutputDir } from '../task-output'

mock.module('../subagent', () => ({
  runSubagent: async () => ({}),
  getBuiltinSubagentConfig: () => ({ toolNames: ['read_file'], model: 'claude-sonnet-4-5' }),
  loadCustomAgents: () => [],
}))

const _gw = await import('../gateway-tools')
const createTools = _gw.createTools

const TEST_DIR = '/tmp/qa-sho123-spawn'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, budgetMs = 2_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

function failedInstance(overrides: Record<string, any> = {}) {
  const result = {
    toolCalls: 0,
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    agentId: 'agent-browser-qa',
    effectiveModelId: 'claude-sonnet-4-5',
    responseText: '',
    responseEmpty: true,
    error: { message: 'browser tool missing: the browser capability is disabled' },
    ...overrides,
  }
  return {
    status: 'failed',
    model: 'claude-sonnet-4-5',
    recentActivity: [{ summary: 'read_file packages/agent-runtime/src/server.ts' }, { summary: 'exec rg -n app.get' }],
    promise: Promise.resolve(result),
  }
}

function makeCtx(registry: TaskRegistry, instance: any): any {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'qa-sho123',
    sessionId: 'session-1',
    mainSessionIds: ['session-1'],
    commandRegistry: registry,
    agentManager: {
      spawn: () => ({ ok: true, instanceId: 'inst-1' }),
      getInstance: () => instance,
      getInstanceMessages: () => null,
      getConfig: () => undefined,
      listTypes: () => [],
      register: () => ({ ok: true }),
    },
  }
}

async function spawnBackground(instance: any) {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  const registry = new TaskRegistry({ outputDir: taskOutputDir(TEST_DIR, 'chat-1'), workspaceDir: TEST_DIR })
  const ctx = makeCtx(registry, instance)
  const tool = createTools(ctx).find((t) => t.name === 'agent_spawn')!
  const res = (await tool.execute('call-1', { type: 'browser_qa', prompt: 'check the page', background: true })).details as any
  expect(res.status).toBe('running')
  expect(res.task_id).toMatch(/^t_/)
  await until(() => registry.get(res.task_id)?.status !== 'running')
  return { registry, taskId: res.task_id as string }
}

describe('AC8: a background subagent that fails reports why, not a placeholder', () => {
  test('the task finishes failed, carries the cause in its summary and its [Task update]', async () => {
    const { registry, taskId } = await spawnBackground(failedInstance())
    const entry = registry.get(taskId)!

    expect(entry.status).toBe('failed')
    expect(String(entry.result?.summary)).toContain('browser tool missing')
    expect(String(entry.result?.summary)).not.toContain('returned no output')

    const note = formatTaskNotification(registry.buildNotification(entry))
    expect(note).toContain('[Task update]')
    expect(note).toContain('failed')
    expect(note).toContain('browser tool missing')
  })

  test('the placeholder still appears for a run that completed with genuinely empty text', async () => {
    const instance = {
      status: 'completed',
      model: 'claude-sonnet-4-5',
      recentActivity: [],
      promise: Promise.resolve({
        toolCalls: 1,
        iterations: 1,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        agentId: 'agent-explore',
        effectiveModelId: 'claude-sonnet-4-5',
        responseText: '',
      }),
    }
    const { registry, taskId } = await spawnBackground(instance)
    const entry = registry.get(taskId)!
    expect(entry.status).toBe('completed')
    expect(String(entry.result?.summary)).toContain('returned no output')
  })
})
