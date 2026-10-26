// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-88 acceptance, runtime side.
 *
 * The card tool path, not just the predicate: a card that comes back from
 * `work_item_move` sitting in a review-category column held by another agent
 * must be watched (`watching: true` + a real task row), and one that lands in a
 * closed column must not. The unit assertions on `isHandedOff` alone would pass
 * with the item shape the tool never sees.
 *
 * Then the prompt half: a paused session's waiting updates reach the agent as a
 * per-turn block after the cache boundary, and a running session gets nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ToolContext } from '../gateway-tools'
import { createBoardTools, HANDOFF_WATCH_UNTIL } from '../board-tools'
import { TaskRegistry } from '../task-registry'
import { AgentGateway } from '../gateway'

// ─── Card tools ──────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch
const saved = { api: process.env.SHOGO_API_URL, secret: process.env.RUNTIME_AUTH_SECRET, mode: process.env.WORKSPACE_RUNTIME, project: process.env.PROJECT_ID, workspace: process.env.WORKSPACE_ID }
let calls: Array<{ url: string; method: string; body: any }> = []
let reply: unknown = {}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: '/tmp/board-tools-sho88',
    channels: new Map(),
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'proj-1',
    ...overrides,
  }
}

async function run(name: string, params: Record<string, unknown>, context = ctx()) {
  const tool = createBoardTools(context).find((t) => t.name === name)
  if (!tool) throw new Error(`missing ${name}`)
  const result: any = await tool.execute('call-1', params as any)
  return JSON.parse(result.content[0].text)
}

const OTHER = 'project:proj-qa'
/** A card on another agent's `review` lane — lacvapps' QA column. */
const IN_REVIEW_LANE = {
  id: 'i1', key: 'PIPE-18', title: 'Refund not received', priority: 'high', assigneeUserId: null,
  assigneeAgentRef: OTHER, dueAt: null, fields: {}, threadRootMessageId: 'm1',
  lastActivityAt: '2026-10-20T00:00:00.000Z',
  column: { id: 'c9', name: 'QA', category: 'review', agentRef: OTHER },
  board: { id: 'b1', name: 'Tickets' },
}

describe('SHO-88 · handing a card into a review-category lane opens a watch', () => {
  beforeEach(() => {
    calls = []
    reply = {}
    process.env.SHOGO_API_URL = 'http://api.test'
    delete process.env.WORKSPACE_RUNTIME
    delete process.env.PROJECT_ID
    delete process.env.WORKSPACE_ID
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    for (const [key, env] of [['api', 'SHOGO_API_URL'], ['secret', 'RUNTIME_AUTH_SECRET'], ['mode', 'WORKSPACE_RUNTIME'], ['project', 'PROJECT_ID'], ['workspace', 'WORKSPACE_ID']] as const) {
      const value = saved[key]
      if (value === undefined) delete process.env[env]
      else process.env[env] = value
    }
  })

  function withRegistry() {
    const registry = new TaskRegistry()
    return { registry, context: ctx({ commandRegistry: registry } as Partial<ToolContext>) }
  }

  test('a move into an agent-held review column returns watching:true and creates the live watch', async () => {
    const { registry, context } = withRegistry()
    reply = { item: IN_REVIEW_LANE }
    const out = await run('work_item_move', { item: 'PIPE-18', column: 'QA' }, context)

    expect(out.watching).toBe(true)
    expect(out.task_id).toBeDefined()
    const track = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/internal/tasks'))
    expect(track?.body).toMatchObject({ source: 'work_item', targetRef: 'i1', until: HANDOFF_WATCH_UNTIL })
    // Live now, not dormant until someone waits on it.
    expect(registry.get(out.task_id)?.status).toBe('running')
    expect(registry.get(out.task_id)?.dormant).toBeUndefined()
  })

  test('the column agent alone is a holder, and a closed column is not', async () => {
    const { registry, context } = withRegistry()
    reply = { item: { ...IN_REVIEW_LANE, assigneeAgentRef: null } }
    const held = await run('work_item_move', { item: 'PIPE-18', column: 'QA' }, context)
    expect(held.watching).toBe(true)

    const closed = withRegistry()
    reply = { item: { ...IN_REVIEW_LANE, column: { id: 'c1', name: 'Done', category: 'done' } } }
    const before = calls.length
    const out = await run('work_item_move', { item: 'PIPE-18', column: 'Done' }, closed.context)
    expect(out.watching).toBeUndefined()
    expect(closed.registry.get(out.task_id)?.dormant).toBe(true)
    // Nothing watched it: the card is tracked lazily at most, never with the
    // hand-off pattern that would wake this session.
    const posted = calls.slice(before).filter((c) => c.method === 'POST' && c.url.endsWith('/api/internal/tasks'))
    expect(posted.every((c) => c.body.until === undefined)).toBe(true)
    expect(registry.get(held.task_id)?.dormant).toBeUndefined()
  })
})

// ─── Prompt ──────────────────────────────────────────────────────────────────

const TEST_DIR = '/tmp/test-sho88-wake-status'

function setupWorkspace(): void {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
  }))
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Identity\nTest Agent\n\n# Personality\nBe helpful.')
}

describe('SHO-88 · a paused session is told what is waiting, after the cache boundary', () => {
  let gateway: AgentGateway

  beforeEach(() => {
    setupWorkspace()
    process.env.SHOGO_API_URL = 'http://api.test'
    process.env.RUNTIME_AUTH_SECRET = 'test-runtime-secret'
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    globalThis.fetch = realFetch
    for (const [key, env] of [['api', 'SHOGO_API_URL'], ['secret', 'RUNTIME_AUTH_SECRET']] as const) {
      const value = saved[key]
      if (value === undefined) delete process.env[env]
      else process.env[env] = value
    }
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  /** The API's answer for `GET /api/internal/tasks`. */
  function answerTasks(wake: unknown): void {
    globalThis.fetch = (async () => new Response(JSON.stringify({ tasks: [], wake }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any
  }

  async function started(): Promise<AgentGateway> {
    gateway = new AgentGateway(TEST_DIR, 'test-project')
    await gateway.start()
    return gateway
  }

  function wakeSection() {
    return (gateway.lastPromptBreakdown ?? []).find((s) => s.label === 'wake-status')
  }

  test('a paused session gets the block in the dynamic zone; a running one gets none', async () => {
    const g = await started()

    answerTasks({ paused: false, wakesInARow: 0, limit: 3, waiting: [] })
    await g.refreshWakeState('sess-1')
    let prompt = (g as any).loadBootstrapContext('sess-1') as string
    expect(wakeSection()).toBeUndefined()
    expect(prompt).not.toContain('Background Updates Waiting')

    answerTasks({
      paused: true,
      wakesInARow: 3,
      limit: 3,
      waiting: [{ taskId: 't_ab12', source: 'agent_reply', title: '@Ops reply', finishedAt: null }],
    })
    await g.refreshWakeState('sess-1')
    expect(g.wakeStateFor('sess-1')?.paused).toBe(true)
    prompt = (g as any).loadBootstrapContext('sess-1') as string
    expect(prompt).toContain('## Background Updates Waiting')
    expect(prompt).toContain('- @Ops reply')
    // Per-turn, not cached: a pause coming and going must not invalidate the prefix.
    expect(wakeSection()?.zone).toBe('dynamic')
  })
})
