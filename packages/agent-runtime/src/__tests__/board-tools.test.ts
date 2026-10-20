// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ToolContext } from '../gateway-tools'
import { createTools } from '../gateway-tools'
import { CORE_TOOL_NAMES } from '../capability-profiles'
import { BOARD_ADMIN_TOOL_NAMES, BOARD_TOOL_NAMES, createBoardTools, HANDOFF_WATCH_UNTIL, isHandedOff, PROBLEM_TOOL_NAMES } from '../board-tools'
import { TaskRegistry } from '../task-registry'
import { __setCreateRetryDelaysForTest } from '../remote-tasks'

function ctx(overrides: Partial<ToolContext> = {}, capabilityProfile?: 'personal' | 'team'): ToolContext {
  return {
    workspaceDir: '/tmp/board-tools',
    channels: new Map(),
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: true,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      capabilityProfile,
    } as any,
    projectId: 'proj-1',
    ...overrides,
  }
}

const realFetch = globalThis.fetch
const saved = { api: process.env.SHOGO_API_URL, mode: process.env.WORKSPACE_RUNTIME, project: process.env.PROJECT_ID, workspace: process.env.WORKSPACE_ID }
let calls: Array<{ url: string; method: string; body: any }> = []
let reply: unknown = {}
let status = 200
/** How many task creates the API refuses before accepting them (SHO-35). */
let taskCreateFailures = 0

beforeEach(() => {
  calls = []
  reply = {}
  status = 200
  taskCreateFailures = 0
  process.env.SHOGO_API_URL = 'http://api.test'
  delete process.env.WORKSPACE_RUNTIME
  delete process.env.PROJECT_ID
  delete process.env.WORKSPACE_ID
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (taskCreateFailures > 0 && method === 'POST' && String(url).endsWith('/api/internal/tasks')) {
      taskCreateFailures--
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } })
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, env] of [['api', 'SHOGO_API_URL'], ['mode', 'WORKSPACE_RUNTIME'], ['project', 'PROJECT_ID'], ['workspace', 'WORKSPACE_ID']] as const) {
    const value = saved[key]
    if (value === undefined) delete process.env[env]
    else process.env[env] = value
  }
})

function tool(name: string, context = ctx()) {
  const found = createBoardTools(context).find((t) => t.name === name)
  if (!found) throw new Error(`missing ${name}`)
  return found
}

async function run(name: string, params: Record<string, unknown>, context = ctx()) {
  const result: any = await tool(name, context).execute('call-1', params as any)
  return JSON.parse(result.content[0].text)
}

const BOARD = {
  id: 'b1', name: 'Tickets', slug: 'tickets', channelName: 'support', itemType: 'ticket', keyPrefix: 'SUP',
  postToChannel: 'all', requiresHumanReview: false, defaultAssigneeAgentRef: null, managedBy: 'user', archivedAt: null,
  columns: [
    { id: 'c1', name: 'New', category: 'backlog', wipLimit: null, agentRef: null, slaHours: 4 },
    { id: 'c2', name: 'Open', category: 'active', wipLimit: 10, agentRef: 'workspace', slaHours: null },
  ],
}

const ITEM = {
  id: 'i1', key: 'SUP-42', title: 'Refund not received', priority: 'high', assigneeUserId: null, assigneeAgentRef: 'workspace',
  dueAt: null, fields: { customer: 'Acme' }, threadRootMessageId: 'm1', lastActivityAt: '2026-10-14T00:00:00.000Z',
  column: { name: 'Open', category: 'active' }, board: { name: 'Tickets' },
}

describe('board tools', () => {
  test('exports one tool per name, and every name is classified as core', () => {
    const names = createBoardTools(ctx()).map((t) => t.name)
    expect(names.sort()).toEqual([...BOARD_TOOL_NAMES, ...BOARD_ADMIN_TOOL_NAMES, ...PROBLEM_TOOL_NAMES].sort())
    for (const n of names) expect(CORE_TOOL_NAMES).toContain(n)
  })

  test('registered for team runtimes and not for personal ones', () => {
    expect(createTools(ctx()).some((t) => t.name === 'work_item_create')).toBe(true)
    expect(createTools(ctx({}, 'personal')).some((t) => t.name === 'work_item_create')).toBe(false)
  })

  test('board_list compacts boards and passes the channel', async () => {
    reply = { boards: [{ ...BOARD, itemCount: 3 }] }
    const out = await run('board_list', { channel: '#support' })
    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-boards?channel=%23support&projectId=proj-1')
    expect(out.boards[0]).toMatchObject({ name: 'Tickets', channel: 'support', key_prefix: 'SUP', cards: 3 })
    expect(out.boards[0].columns).toEqual([
      { name: 'New', category: 'backlog', sla_hours: 4 },
      { name: 'Open', category: 'active', wip_limit: 10, agent: 'workspace' },
    ])
  })

  test('work_item_create posts to the board with the agent identity', async () => {
    reply = { item: ITEM }
    const out = await run('work_item_create', { board: 'Tickets', channel: 'support', title: 'Refund not received', priority: 'high', fields: { customer: 'Acme' } })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-boards/Tickets/items?channel=support')
    expect(calls[0].body).toMatchObject({ title: 'Refund not received', priority: 'high', fields: { customer: 'Acme' }, projectId: 'proj-1', sessionId: 'sess-1' })
    expect(out.item).toMatchObject({ key: 'SUP-42', column: 'Open', category: 'active', assignee_agent: 'workspace', fields: { customer: 'Acme' } })
  })

  test('work_item_comment carries the server’s mention_warnings for an ambiguous @Name', async () => {
    reply = {
      messageId: 'm-9',
      threadRootId: 'm1',
      mention_warnings: ['@New Project matches 7 people or agents — use the tag from team_directory'],
    }
    const out = await run('work_item_comment', { item: 'SUP-42', text: '@New Project status?' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-work-items/SUP-42/comments')
    expect(calls[0].body).toMatchObject({ text: '@New Project status?', projectId: 'proj-1', sessionId: 'sess-1' })
    expect(out).toMatchObject({
      ok: true,
      messageId: 'm-9',
      threadRootId: 'm1',
      mention_warnings: ['@New Project matches 7 people or agents — use the tag from team_directory'],
    })
  })

  test('work_item_move returns WIP warnings', async () => {
    reply = { item: ITEM, warnings: [{ code: 'wip_exceeded', column: 'Open', limit: 10, count: 11 }] }
    const out = await run('work_item_move', { item: 'SUP-42', column: 'Open' })
    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-work-items/SUP-42/move')
    expect(calls[0].body).toMatchObject({ column: 'Open', projectId: 'proj-1' })
    expect(out.warnings[0].code).toBe('wip_exceeded')
  })

  test('API errors come back with their code, e.g. review_required', async () => {
    status = 403
    reply = { error: { code: 'review_required', message: 'A person has to close cards on this board.' } }
    const out = await run('work_item_move', { item: 'SUP-42', column: 'Solved' })
    expect(out).toEqual({ error: 'A person has to close cards on this board.', code: 'review_required', status: 403 })
  })

  test('work_item_bulk_update sends ids and one patch', async () => {
    reply = { results: [] }
    await run('work_item_bulk_update', { items: ['SUP-1', 'SUP-2'], column: 'Solved' })
    expect(calls[0].url).toEndWith('/agent-work-items/bulk')
    expect(calls[0].body).toMatchObject({ ids: ['SUP-1', 'SUP-2'], patch: { column: 'Solved' } })
  })

  test('work_item_list joins category and priority filters', async () => {
    reply = { items: [ITEM] }
    const out = await run('work_item_list', { assignee: 'me', category: ['active', 'waiting'], priority: ['urgent', 'high'] })
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/internal/workspaces/ws-1/agent-work-items')
    expect(url.searchParams.get('category')).toBe('active,waiting')
    expect(url.searchParams.get('priority')).toBe('urgent,high')
    expect(url.searchParams.get('assignee')).toBe('me')
    expect(url.searchParams.get('limit')).toBe('50')
    expect(out.items[0].key).toBe('SUP-42')
  })

  test('board_create sends snake_case columns the API accepts', async () => {
    reply = { board: BOARD }
    await run('board_create', { channel: 'support', name: 'Tickets', item_type: 'ticket', columns: [{ name: 'New', category: 'backlog', sla_hours: 4 }] })
    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-boards')
    expect(calls[0].body).toMatchObject({ channel: 'support', name: 'Tickets', item_type: 'ticket', columns: [{ name: 'New', category: 'backlog', sla_hours: 4 }] })
  })

  test('board_update moves a board to another channel via move_to_channel', async () => {
    reply = { board: BOARD }
    await run('board_update', { board: 'Tickets', channel: 'support', move_to_channel: 'cs' })
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-boards/Tickets?channel=support')
    expect(calls[0].body.channel).toBe('cs')
  })

  test('column_delete passes move_to in the query', async () => {
    reply = { moved: 2, board: BOARD }
    const out = await run('column_delete', { board: 'Tickets', column: 'Waiting on customer', move_to: 'Open' })
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-boards/Tickets/columns/Waiting%20on%20customer?move_to=Open&projectId=proj-1')
    expect(out.moved).toBe(2)
  })

  test('board_archive with restore unarchives', async () => {
    reply = { board: BOARD }
    await run('board_archive', { board: 'Tickets', restore: true })
    expect(calls[0].body.archived).toBe(false)
  })

  test('a leading # on board names is dropped from the path', async () => {
    reply = {}
    await run('board_summary', { board: '#Tickets' })
    expect(new URL(calls[0].url).pathname).toBe('/api/internal/workspaces/ws-1/agent-boards/Tickets/summary')
  })

  test('without a workspace the tools say so and make no request', async () => {
    const out = await run('board_list', {}, ctx({ workspaceId: undefined }))
    expect(out.code).toBe('no_workspace')
    expect(calls).toHaveLength(0)
  })
})

describe('handed-off cards are watched', () => {
  const ENGINEER = 'project:proj-eng'
  const handedOff = { ...ITEM, assigneeAgentRef: ENGINEER, column: { name: 'Backlog', category: 'backlog' } }

  function withRegistry() {
    const registry = new TaskRegistry()
    return { registry, context: ctx({ commandRegistry: registry } as Partial<ToolContext>) }
  }

  test('assigning another agent starts tracking at once with the hand-off pattern', async () => {
    const { registry, context } = withRegistry()
    reply = { item: handedOff }
    const out = await run('work_item_create', { board: 'Tickets', title: 'Refund not received', assignee_agent: 'proj-eng' }, context)
    expect(out.watching).toBe(true)
    const track = calls.find((c) => c.url.endsWith('/api/internal/tasks'))
    expect(track?.body).toMatchObject({ source: 'work_item', targetRef: 'i1', until: HANDOFF_WATCH_UNTIL })
    expect(registry.get(out.task_id)?.dormant).toBeUndefined()
  })

  // SHO-35: a create the API refuses must not cost the hand-off its watch.
  test('a hand-off whose task create the API refuses is still watched, with one row', async () => {
    const { registry, context } = withRegistry()
    const restore = __setCreateRetryDelaysForTest([10, 10, 10])
    const posts = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/internal/tasks'))
    try {
      reply = { item: handedOff }
      taskCreateFailures = 2
      const out = await run('work_item_create', { board: 'Tickets', title: 'Refund not received', assignee_agent: 'proj-eng' }, context)

      // The caller no longer shrugs: the tool still reports a live watch, so
      // the agent is woken when the card comes back instead of losing it.
      expect(out.watching).toBe(true)
      expect(out.task_id).toBeDefined()
      expect(registry.get(out.task_id)?.status).toBe('running')
      expect(registry.get(out.task_id)?.dormant).toBeUndefined()

      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && posts().length < 3) await new Promise((r) => setTimeout(r, 10))
      // Refused, refused, accepted — and every attempt carries the same id, so
      // the API cannot end up with two rows (two wakes) for one card.
      expect(posts()).toHaveLength(3)
      expect(new Set(posts().map((c) => c.body.id))).toEqual(new Set([out.task_id]))

      await new Promise((r) => setTimeout(r, 50))
      expect(posts()).toHaveLength(3) // and it stops once the row exists
    } finally {
      restore()
    }
  })

  test('reading a card stays lazy, and handing it off later activates the same task', async () => {
    const { registry, context } = withRegistry()
    reply = { item: { ...ITEM, assigneeAgentRef: null } }
    const read = await run('work_item_get', { item: 'SUP-42' }, context)
    expect(read.watching).toBeUndefined()
    expect(calls.some((c) => c.url.endsWith('/api/internal/tasks'))).toBe(false)
    expect(registry.get(read.task_id)?.dormant).toBe(true)

    reply = { item: handedOff }
    const moved = await run('work_item_update', { item: 'SUP-42', assignee_agent: 'proj-eng' }, context)
    expect(moved.task_id).toBe(read.task_id)
    expect(moved.watching).toBe(true)
    expect(calls.find((c) => c.url.endsWith('/api/internal/tasks'))?.body).toMatchObject({ until: HANDOFF_WATCH_UNTIL })
    expect(registry.get(read.task_id)?.dormant).toBeUndefined()
  })

  test('a card the agent holds itself, or one already in review, is not watched', () => {
    expect(isHandedOff({ assignee_agent: 'project:proj-1', category: 'active' }, 'project:proj-1')).toBe(false)
    expect(isHandedOff({ assignee_agent: ENGINEER, category: 'review' }, 'workspace')).toBe(false)
    expect(isHandedOff({ assignee_agent: null, column_agent: ENGINEER, category: 'active' }, 'workspace')).toBe(true)
    expect(isHandedOff({ assignee_agent: null, category: 'active' }, 'workspace')).toBe(false)
  })

  test('the hand-off pattern matches the API card event lines that need the assigner', () => {
    const until = new RegExp(HANDOFF_WATCH_UNTIL, 'i')
    for (const line of ['moved to Review (review)', 'moved to Needs attention (waiting)', 'moved to Done (done)', 'agent stopped with the card still in In progress', 'agent failed on the card']) {
      expect(until.test(`assigned to Engineer\n${line}`)).toBe(true)
    }
    for (const line of ['moved to In progress (active)', 'comment: waiting on review (review) soon', 'assigned to Engineer']) {
      expect(until.test(line)).toBe(false)
    }
  })
})

describe('templates', () => {
  test('board_create starts from a board template; given values win', async () => {
    reply = { board: BOARD }
    await run('board_create', { template: 'renewals', channel: 'cs' })
    expect(calls[0].body).toMatchObject({ channel: 'cs', name: 'Renewals', item_type: 'deal', key_prefix: 'REN' })
    expect(calls[0].body.columns.map((c: any) => c.name)).toEqual(['Upcoming', 'In conversation', 'At risk', 'Renewed', 'Churned'])
    expect(calls[0].body.template).toBeUndefined()
  })

  test('board_create rejects an unknown template and a missing name', async () => {
    expect((await run('board_create', { template: 'support' })).code).toBe('unknown_template')
    expect((await run('board_create', { channel: 'sales' })).code).toBe('invalid')
    expect(calls).toHaveLength(0)
  })

  test('work_template_add writes shogo-system.yaml and is a no-op the second time', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'work-template-'))
    try {
      const first = await run('work_template_add', { template: 'freelancer' }, ctx({ workspaceDir: dir }))
      expect(first.added).toContain('board #sales Pipeline')
      const yaml = readFileSync(join(dir, 'shogo-system.yaml'), 'utf-8')
      expect(yaml).toContain('key: finance-agent')
      const again = await run('work_template_add', { template: 'sales' }, ctx({ workspaceDir: dir }))
      expect(again.added).toEqual([])
      expect(readFileSync(join(dir, 'shogo-system.yaml'), 'utf-8')).toBe(yaml)
      expect((await run('work_template_add', { template: 'x', manifestPath: '../evil.yaml' }, ctx({ workspaceDir: dir }))).code).toBe('invalid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(calls).toHaveLength(0)
  })

  test('work_template_list filters by kind', async () => {
    const out = await run('work_template_list', { kind: 'company' })
    expect(out.templates.map((t: any) => t.id)).toEqual(['saas-startup', 'agency', 'ecommerce', 'nonprofit', 'freelancer', 'local-services'])
  })
})
