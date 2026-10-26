// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { CompanyWorld, type WorldSeed } from './world'
import type { SimWorkerScript } from './workers'
import { compileInstallBody } from '../tool-mocks-runtime'

const COLUMNS = [
  { name: 'Backlog', category: 'backlog' as const },
  { name: 'In progress', category: 'active' as const },
  { name: 'Blocked', category: 'waiting' as const },
  { name: 'Needs attention', category: 'waiting' as const },
  { name: 'Done', category: 'done' as const },
]

const WORKERS: SimWorkerScript[] = [
  { id: 'price', match: 'price', team: 'bill', teamLabel: 'billing', beats: [
    { afterHours: 1, action: 'start', text: 'On {key}.' },
    { afterHours: 2, action: 'ask', waitsOn: { decision: 'price' }, text: 'Need the price from Dana.' },
    { afterHours: 3, action: 'finish', text: 'Price set.' },
  ] },
  { id: 'page', match: 'page', team: 'market', teamLabel: 'marketing', beats: [
    { afterHours: 1, action: 'block', waitsOn: { cards: ['price'] }, text: 'Waiting on the price.' },
    { afterHours: 4, action: 'finish', text: 'Page live.' },
  ] },
  { id: 'test', match: 'load test', team: 'eng', teamLabel: 'engineering', beats: [
    { afterHours: 1, action: 'fail', text: 'Quota exceeded.' },
    { afterHours: 2, action: 'finish', text: 'Passed.' },
  ] },
  { id: 'docs', match: 'docs', team: 'doc', teamLabel: 'docs', beats: [
    { afterHours: 1, action: 'start', text: 'On it.' },
    { afterHours: 1, action: 'silent', text: '' },
    { afterHours: 2, action: 'finish', text: 'Docs done.' },
  ] },
]

function seed(extra: Partial<WorldSeed> = {}): WorldSeed {
  return {
    now: '2026-10-13T09:00:00.000Z',
    arm: 'A',
    me: 'Workspace Agent',
    people: [{ id: 'dana', name: 'Dana Brooks' }, { id: 'tom', name: 'Tom Walsh' }],
    channels: [{ name: 'launch' }, { name: 'finance' }],
    boards: [
      { id: 'bil', name: 'Billing', channel: 'finance', itemType: 'task', keyPrefix: 'BIL', columns: COLUMNS },
      { id: 'mkt', name: 'Marketing', channel: 'launch', itemType: 'task', keyPrefix: 'MKT', columns: [...COLUMNS.slice(0, 2), { name: 'Agent queue', category: 'active', agent: 'marketing-agent' }, ...COLUMNS.slice(2)] },
      { id: 'eng', name: 'Engineering', channel: 'launch', itemType: 'task', keyPrefix: 'ENG', columns: COLUMNS, defaultAgent: 'eng-agent' },
    ],
    items: [],
    agents: [
      { key: 'billing-agent', name: 'Billing Agent', capabilities: {}, files: [] },
      { key: 'marketing-agent', name: 'Marketing Agent', capabilities: {}, files: [] },
      { key: 'eng-agent', name: 'Engineering Agent', capabilities: {}, files: [] },
      { key: 'docs-agent', name: 'Docs Agent', capabilities: {}, files: [] },
    ],
    workforce: {
      workers: WORKERS,
      humanReplies: [{ id: 'dana-price', person: 'dana', match: 'price', decision: 'price', text: '$39, approved.' }],
    },
    ...extra,
  }
}

const item = (w: CompanyWorld, key: string) => w.snapshot().items.find((i) => i.key === key)!
const run = (w: CompanyWorld, key: string) => w.snapshot().workforce!.runs.find((r) => r.item === key)

describe('Workforce', () => {
  test('cards with no agent never move; assigned cards get worked', () => {
    const w = new CompanyWorld(seed())
    w.handle('work_item_create', { board: 'Billing', title: 'Unowned price' })
    const created = w.handle('work_item_create', { board: 'Billing', title: 'Docs for billing', assignee_agent: 'Docs Agent' }) as any
    expect(created.task_id).toMatch(/^t_sim/)
    w.advance(10)
    expect(item(w, 'BIL-1').column).toBe('Backlog')
    expect(item(w, 'BIL-2').column).toBe('In progress')
    expect(item(w, 'BIL-2').history.some((e) => e.author === 'Docs Agent' && e.text === 'On it.')).toBe(true)
  })

  test('board default agents and agent columns hand cards off', () => {
    const w = new CompanyWorld(seed())
    w.handle('work_item_create', { board: 'Engineering', title: 'Load test at 5x' })
    expect(item(w, 'ENG-1').assigneeAgent).toBe('eng-agent')
    w.handle('work_item_create', { board: 'Marketing', title: 'Pricing page' })
    w.handle('work_item_move', { item: 'MKT-1', column: 'Agent queue' })
    expect(item(w, 'MKT-1').assigneeAgent).toBe('marketing-agent')
    expect(run(w, 'MKT-1')?.status).toBe('running')
  })

  test('an unknown agent is an error', () => {
    const w = new CompanyWorld(seed())
    expect(w.handle('work_item_create', { board: 'Billing', title: 'x', assignee_agent: 'nobody' })).toMatchObject({ error: expect.stringContaining('No agent') })
  })

  test('tagging an agent with a card key hands it the card and returns tasks', () => {
    const w = new CompanyWorld(seed())
    w.handle('work_item_create', { board: 'Billing', title: 'Copilot price' })
    const out = w.handle('team_chat_post', { channel: 'finance', text: '@Billing Agent please take BIL-1' }) as any
    expect(out.task_ids).toHaveLength(1)
    expect(run(w, 'BIL-1')?.agent).toBe('billing-agent')
  })

  test('naming another agent\'s card in a post does not take it away', () => {
    const w = new CompanyWorld(seed())
    w.handle('work_item_create', { board: 'Billing', title: 'Copilot price', assignee_agent: 'billing-agent' })
    w.handle('work_item_create', { board: 'Marketing', title: 'Pricing page', assignee_agent: 'marketing-agent' })
    w.handle('team_chat_post', { channel: 'launch', text: '@Marketing Agent once BIL-1 is done, MKT-1 can go' })
    expect(run(w, 'BIL-1')?.agent).toBe('billing-agent')
    expect(item(w, 'BIL-1').assigneeAgent).toBe('billing-agent')
  })

  test('the wrong team declines the card', () => {
    const w = new CompanyWorld(seed())
    w.handle('work_item_create', { board: 'Billing', title: 'Copilot price', assignee_agent: 'marketing-agent' })
    w.advance(2)
    expect(run(w, 'BIL-1')?.status).toBe('declined')
    expect(item(w, 'BIL-1').history.at(-1)?.text).toContain('billing work')
  })

  test('tagging the agent that declined a card gets a fresh reply that wait reports', () => {
    const w = new CompanyWorld(seed())
    w.handle('work_item_create', { board: 'Billing', title: 'Copilot price', assignee_agent: 'marketing-agent' })
    w.advance(2)
    const out = w.handle('team_chat_post', { channel: 'launch', text: '@Marketing Agent BIL-1 has been sitting for days, please pick it up' }) as any
    expect(out.tasks[0]).toMatchObject({ status: 'running' })
    const waited = w.handle('wait', { task_ids: out.task_ids }) as any
    expect(waited).toMatchObject({ outcome: 'declined', last_update: expect.stringContaining('not mine') })
    expect(item(w, 'BIL-1').history.filter((e) => e.text.includes('billing work'))).toHaveLength(2)
  })

  test('wait returns a task that already finished before it sleeps', () => {
    const w = new CompanyWorld(seed())
    const slow = w.handle('work_item_create', { board: 'Marketing', title: 'Pricing page', assignee_agent: 'marketing-agent' }) as any
    const fast = w.handle('work_item_create', { board: 'Billing', title: 'Copilot price', assignee_agent: 'docs-agent' }) as any
    w.advance(2)
    expect(run(w, 'BIL-1')?.status).toBe('declined')
    expect(run(w, 'MKT-1')?.status).toBe('blocked')
    const before = w.snapshot().now
    const first = w.handle('wait', { task_ids: [fast.task_id, slow.task_id] }) as any
    expect(first.task_id === fast.task_id || first.task_id === slow.task_id).toBe(true)
    expect(w.snapshot().now).toBe(before)
    const second = w.handle('wait', { task_ids: [fast.task_id, slow.task_id] }) as any
    expect(second.task_id).not.toBe(first.task_id)
    expect(w.snapshot().now).toBe(before)
  })

  test('a decision unblocks only once the person answers and the agent is handed the card again', () => {
    const w = new CompanyWorld(seed())
    w.handle('work_item_create', { board: 'Billing', title: 'Copilot price', assignee_agent: 'billing-agent' })
    w.advance(4)
    expect(run(w, 'BIL-1')?.status).toBe('blocked')
    expect(item(w, 'BIL-1').column).toBe('Blocked')
    expect(w.snapshot().messages.some((m) => m.author === 'Billing Agent' && m.kind === 'decision')).toBe(true)

    w.handle('work_item_comment', { item: 'BIL-1', text: '@Billing Agent try again' })
    expect(run(w, 'BIL-1')?.status).toBe('blocked')
    expect(item(w, 'BIL-1').history.at(-1)?.text).toContain('Still waiting')

    w.handle('team_chat_post', { channel: 'finance', text: '@Dana what price should Copilot have?' })
    w.advance(3)
    expect(w.snapshot().workforce!.decisions).toContain('price')
    expect(w.snapshot().messages.some((m) => m.author === 'Dana Brooks' && m.text.includes('$39'))).toBe(true)
    expect(run(w, 'BIL-1')?.status).toBe('blocked')

    w.handle('work_item_update', { item: 'BIL-1', assignee_agent: 'billing-agent' })
    w.advance(4)
    expect(run(w, 'BIL-1')?.status).toBe('done')
    expect(item(w, 'BIL-1').column).toBe('Done')
  })

  test('card dependencies unblock when the other card is done; settled waits are skipped', () => {
    const w = new CompanyWorld(seed({ workforce: { workers: WORKERS, decisions: ['price'] } }))
    w.handle('work_item_create', { board: 'Marketing', title: 'Pricing page', assignee_agent: 'marketing-agent' })
    w.advance(2)
    expect(run(w, 'MKT-1')?.status).toBe('blocked')
    w.handle('team_chat_post', { channel: 'launch', text: '@Marketing Agent please retry MKT-1' })
    expect(run(w, 'MKT-1')?.status).toBe('blocked')
    w.handle('work_item_create', { board: 'Billing', title: 'Copilot price', assignee_agent: 'billing-agent' })
    w.advance(10)
    expect(item(w, 'BIL-1').column).toBe('Done')
    expect(item(w, 'BIL-1').history.some((e) => e.text.includes('Need the price'))).toBe(false)
    w.handle('team_chat_post', { channel: 'launch', text: '@Marketing Agent BIL-1 is done, MKT-1 is unblocked' })
    w.advance(5)
    expect(item(w, 'MKT-1').column).toBe('Done')
  })

  test('a quiet agent picks back up when tagged without a card', () => {
    const w = new CompanyWorld(seed())
    w.handle('work_item_create', { board: 'Engineering', title: 'API docs', assignee_agent: 'docs-agent' })
    w.advance(5)
    expect(run(w, 'ENG-1')?.status).toBe('silent')
    const out = w.handle('team_chat_post', { channel: 'launch', text: '@Docs Agent how are you getting on?' }) as any
    expect(out.tasks[0].title).toContain('Docs Agent')
    w.advance(3)
    expect(run(w, 'ENG-1')?.status).toBe('done')
    expect(w.snapshot().messages.some((m) => m.author === 'Docs Agent' && m.text.includes('ENG-1'))).toBe(true)
  })

  test('wait advances simulated time until a task settles', () => {
    const w = new CompanyWorld(seed())
    const created = w.handle('work_item_create', { board: 'Engineering', title: 'Load test at 5x' }) as any
    const before = Date.parse(w.snapshot().now)
    const out = w.handle('wait', { task_ids: [created.task_id] }) as any
    expect(out).toMatchObject({ task_id: created.task_id, outcome: 'failed', status: 'failed' })
    expect(Date.parse(w.snapshot().now) - before).toBe(3_600_000)
    expect(item(w, 'ENG-1').column).toBe('Needs attention')
    expect((w.handle('task_list', {}) as any).tasks).toHaveLength(1)
  })

  test('wait and task_list fall through to the real tools when nothing is simulated', async () => {
    const compiled = compileInstallBody({ mocks: {}, sim: seed() }, { sleepFn: async () => {} })
    expect(await compiled.fns.wait({ task_ids: ['t_exec1'] })).toBe('__passthrough')
    expect(await compiled.fns.task_list({})).toBe('__passthrough')
  })

  test('project_create adds an agent; project_call hands it cards', () => {
    const w = new CompanyWorld(seed({ agents: [] }))
    expect(w.handle('project_create', { name: 'Billing Agent' })).toMatchObject({ ok: true, project: { id: 'proj-billing-agent' } })
    w.handle('work_item_create', { board: 'Billing', title: 'Copilot price' })
    const out = w.handle('project_call', { project: 'billing-agent', message: 'Please do BIL-1', wait: false }) as any
    expect(out.task_id).toMatch(/^t_sim/)
    expect(run(w, 'BIL-1')?.agent).toBe('billing-agent')
  })

  test('file tools aimed at a simulated agent write its files; others run for real', async () => {
    const w = new CompanyWorld(seed())
    expect(w.handle('write_file', { project: 'Billing Agent', path: 'AGENTS.md', content: '# Billing\nOwn the SKU.' })).toMatchObject({ ok: true, project: 'billing-agent' })
    expect(w.handle('edit_file', { project: 'billing-agent', path: 'AGENTS.md', old_string: 'SKU', new_string: 'Copilot SKU' })).toMatchObject({ ok: true })
    expect(w.handle('read_file', { project: 'proj-billing-agent', path: 'AGENTS.md' })).toMatchObject({ content: '# Billing\nOwn the Copilot SKU.' })
    expect(w.snapshot().agents.find((a) => a.key === 'billing-agent')!.files).toEqual(['AGENTS.md'])
    expect(w.handle('write_file', { project: 'nobody', path: 'AGENTS.md', content: 'x' })).toMatchObject({ code: 'not_found' })
    const compiled = compileInstallBody({ mocks: {}, sim: seed() }, { sleepFn: async () => {} })
    expect(await compiled.fns.write_file({ path: 'notes.md', content: 'local' })).toBe('__passthrough')
  })

  test('worlds without a workforce behave as before', () => {
    const w = new CompanyWorld({ ...seed(), workforce: undefined })
    expect(w.toolNames()).not.toContain('wait')
    expect(w.handle('work_item_create', { board: 'Billing', title: 'x', assignee_agent: 'anyone' })).toMatchObject({ ok: true })
    w.advance(10)
    expect(w.snapshot().workforce).toBeUndefined()
  })
})
