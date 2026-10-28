// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { stringify as stringifyYaml } from 'yaml'
import { CompanyWorld } from './company-sim/world'
import { parseSystemManifest } from '../system-manifest'
import { DELIVERABLES, LAUNCH_AGENTS, LAUNCH_PEOPLE, TEAMS, deliverableOf, type TeamId } from './company-sim/launch-scenario'
import { ORCHESTRATION_EVALS } from './test-cases-orchestration'
import type { AgentEval, EvalResult, ToolCallRecord } from './types'

const evalById = (id: string) => ORCHESTRATION_EVALS.find((e) => e.id === `orch-launch-${id}`)!
const world = (ev: AgentEval) => new CompanyWorld(ev.sim!)

function grade(ev: AgentEval, w: CompanyWorld, responseText = '', toolCalls: ToolCallRecord[] = []) {
  const r = { sim: w.snapshot(), responseText, toolCalls } as unknown as EvalResult
  const passed = Object.fromEntries(ev.validationCriteria.map((c) => [c.id, c.validate(r)]))
  const earned = ev.validationCriteria.reduce((n, c) => n + (passed[c.id] ? c.points : 0), 0)
  return { passed, pct: (earned / ev.maxScore) * 100 }
}

const tc = (name: string, input: Record<string, unknown> = {}): ToolCallRecord => ({ name, input, output: null })
const keyOf = (w: CompanyWorld, id: string) => w.snapshot().items.find((i) => deliverableOf(i.title)?.id === id)!.key
const teams = Object.keys(TEAMS) as TeamId[]
const channelOf = (t: TeamId) => (t === 'billing' ? 'finance' : t === 'eng' ? 'engineering' : t)

/** What a good workspace agent does at kickoff: agents, channels and boards in the manifest, then a card per deliverable. */
function goodKickoff(w: CompanyWorld) {
  const manifest = stringifyYaml({
    version: 1,
    name: 'Northpeak',
    projects: teams.map((t) => ({ key: LAUNCH_AGENTS[t].key, name: LAUNCH_AGENTS[t].name, agent: { capabilities: { boardsEnabled: true } } })),
    teamChannels: [
      { name: 'launch', topic: 'Copilot GA', members: teams.map((t) => ({ project: LAUNCH_AGENTS[t].key })) },
      ...teams.map((t) => ({ name: channelOf(t), members: [{ project: LAUNCH_AGENTS[t].key }], boards: [{ name: `${TEAMS[t].label} launch`, defaultAgent: LAUNCH_AGENTS[t].key }] })),
    ],
  })
  const parsed = parseSystemManifest(manifest)
  expect(parsed.errors).toEqual([])
  w.applyManifest(parsed.manifest!, false)
  const order = [...DELIVERABLES].sort((a, b) => (a.dependsOn ? 1 : 0) - (b.dependsOn ? 1 : 0))
  for (const d of order) {
    const description = d.dependsOn ? `Depends on ${d.dependsOn.map((x) => keyOf(w, x)).join(' and ')}.` : undefined
    const out = w.handle('work_item_create', { board: `${TEAMS[d.team].label} launch`, channel: channelOf(d.team), title: d.title, due_at: d.id === 'webinar' ? '2026-11-10' : '2026-10-31', description }) as any
    expect(out.ok).toBe(true)
  }
  w.handle('team_chat_post', { channel: 'launch', text: 'Copilot launch kickoff: every deliverable is on a board with an owner. I will post status here.' })
}

/** Hand back every parked card whose wait is settled, and ask the right person for every open decision. */
function tend(w: CompanyWorld) {
  const s = w.snapshot()
  const asks: Record<string, [string, string]> = {
    price: ['finance', '@Dana Billing needs the Copilot price: $29 or $39 per seat, and a trial?'],
    claims: ['legal', '@Elena can you sign off on the launch claims?'],
    'staging-quota': ['engineering', '@Tom the load test hit the staging GPU quota; can you raise it?'],
  }
  for (const r of s.workforce!.runs.filter((x) => x.kind === 'card' && x.status !== 'running' && x.status !== 'done')) {
    const decision = r.waitsOn && 'decision' in r.waitsOn ? r.waitsOn.decision : null
    if (decision && !s.workforce!.decisions.includes(decision) && asks[decision]) {
      const [channel, text] = asks[decision]
      if (!s.messages.some((m) => m.author === s.me && m.text === text)) w.handle('team_chat_post', { channel, text })
      continue
    }
    const agent = s.agents.find((a) => a.key === r.agent)!
    w.handle('work_item_comment', { item: r.item, text: `@${agent.name} ${r.item} is clear to continue.` })
  }
}

describe('orchestration evals', () => {
  test('ids are unique and every eval has a sim and criteria', () => {
    expect(new Set(ORCHESTRATION_EVALS.map((e) => e.id)).size).toBe(ORCHESTRATION_EVALS.length)
    for (const ev of ORCHESTRATION_EVALS) {
      expect(ev.sim?.workforce).toBeDefined()
      expect(ev.maxScore).toBeGreaterThan(0)
      expect(ev.workspaceFiles?.['launch-brief.md']).toContain('Copilot')
    }
  })

  test('every deliverable title is recognised as itself', () => {
    for (const d of DELIVERABLES) expect(deliverableOf(d.title)?.id).toBe(d.id)
    expect(deliverableOf('Update pricing page with the Copilot price')?.id).toBe('pricing-page')
    expect(deliverableOf('Set the Copilot price in Stripe')?.id).toBe('sku')
  })

  test('doing nothing fails every stage', () => {
    for (const ev of ORCHESTRATION_EVALS) expect(grade(ev, world(ev)).pct).toBeLessThan(40)
  })

  test('seeded stages ship a shogo-system.yaml that matches their world', () => {
    for (const ev of ORCHESTRATION_EVALS.filter((e) => e.sim!.agents?.length)) {
      const parsed = parseSystemManifest(ev.workspaceFiles!['shogo-system.yaml']!)
      expect(parsed.errors).toEqual([])
      expect(world(ev).applyManifest(parsed.manifest!, true)).toMatchObject({ empty: true })
    }
    expect(evalById('kickoff').workspaceFiles!['shogo-system.yaml']).toBeUndefined()
  })

  test('the message an eval opens with is in its channel', () => {
    const s = world(evalById('unblock')).snapshot()
    expect(s.messages.some((m) => m.channel === 'launch' && m.author === LAUNCH_PEOPLE.alex.name && m.text.includes('$39'))).toBe(true)
  })

  test('an engineering agent may own the API docs and metering; support may not own invoices', () => {
    const w = world(evalById('kickoff'))
    w.handle('project_create', { name: 'Engineering Agent' })
    w.handle('project_create', { name: 'Support Agent' })
    w.handle('board_create', { channel: 'general', name: 'Launch', key_prefix: 'LCH' })
    for (const title of ['API docs for the Copilot endpoints', 'Usage metering for Copilot']) {
      w.handle('work_item_create', { board: 'Launch', channel: 'general', title, assignee_agent: 'engineering-agent' })
    }
    w.handle('work_item_create', { board: 'Launch', channel: 'general', title: 'Invoice line items for Copilot usage', assignee_agent: 'support-agent' })
    w.advance(3)
    const status = (key: string) => w.snapshot().workforce!.runs.find((r) => r.item === key)?.status
    expect(status('LCH-1')).toBe('running')
    expect(status('LCH-2')).toBe('running')
    expect(status('LCH-3')).toBe('declined')
  })
})

describe('kickoff', () => {
  const ev = evalById('kickoff')

  test('a good kickoff passes every criterion', () => {
    const w = world(ev)
    goodKickoff(w)
    const g = grade(ev, w, 'Set up seven department agents with channels and boards; all 18 deliverables are on cards and handed out.')
    expect(Object.entries(g.passed).filter(([, ok]) => !ok)).toEqual([])
  })

  test('doing the work with subagents and leaving cards unowned fails', () => {
    const w = world(ev)
    w.handle('team_chat_list', {})
    const g = grade(ev, w, 'Done.', [tc('agent_spawn', { prompt: 'write the launch blog' }), tc('write_file', { path: 'launch/blog-post.md' })])
    expect(g.passed).toMatchObject({ agents: false, owners: false, 'handed-off': false, delegated: false })
  })

  test('creating agents but assigning every card to people fails', () => {
    const w = world(ev)
    for (const t of teams) w.handle('project_create', { name: LAUNCH_AGENTS[t].name })
    w.handle('board_create', { channel: 'general', name: 'Launch', key_prefix: 'CPL' })
    w.handle('team_chat_post', { channel: 'general', text: 'Copilot launch kickoff: every deliverable is on the Launch board.' })
    for (const d of DELIVERABLES) w.handle('work_item_create', { board: 'Launch', channel: 'general', title: d.title, assignee_user: 'tom' })
    const g = grade(ev, w, 'Every deliverable is on the board with a lead.')
    expect(g.passed).toMatchObject({ owners: false, 'handed-off': false })
    expect(g.pct).toBeLessThan(70)
  })
})

describe('standup', () => {
  const ev = evalById('standup')
  const response = 'Price is with Dana, the load test is waiting on Tom to raise the staging quota, I nudged the docs agent, moved the invoice card SUP-3 to billing, and Elena has the claims.'

  function good(w: CompanyWorld) {
    w.handle('board_health', {})
    w.handle('team_chat_post', { channel: 'finance', text: '@Dana Brooks Billing needs the Copilot price to create the SKU (BIL-1).', questions: [{ question: 'Which price per seat?', options: ['$29', '$39'] }] })
    w.handle('team_chat_post', { channel: 'legal', text: '@Elena can you sign off on the launch claims?' })
    w.handle('team_chat_dm', { user: 'tom', text: 'The ENG-2 load test hit the staging GPU quota at 2.1x. Can you raise it?' })
    w.handle('work_item_comment', { item: 'DOC-1', text: '@Docs Agent DOC-1 has been quiet for three days. Where does it stand?' })
    w.handle('work_item_move', { item: 'SUP-3', board: 'Copilot Billing', column: 'Backlog' })
    w.handle('work_item_update', { item: 'SUP-3', assignee_agent: 'billing-agent' })
    w.handle('team_chat_post', { channel: 'launch', text: 'Day 7: price with Dana, claims with Elena, load test waiting on staging quota (Tom), docs restarted, invoices moved to billing.' })
  }

  test('handling all five problems passes', () => {
    const w = world(ev)
    good(w)
    const g = grade(ev, w, response)
    expect(Object.entries(g.passed).filter(([, ok]) => !ok)).toEqual([])
  })

  test('picking the price itself and copying the misrouted card are caught', () => {
    const w = world(ev)
    w.handle('work_item_comment', { item: 'BIL-1', text: '@Billing Agent go with $39 per seat.' })
    w.handle('work_item_create', { board: 'Copilot Billing', title: 'Invoice line items for Copilot usage', assignee_agent: 'billing-agent' })
    const g = grade(ev, w, 'All good, the pricing page is done.')
    expect(g.passed).toMatchObject({ 'price-not-decided': false, 'misroute-moved': false, 'misroute-not-copied': false, honest: false, 'price-to-dana': false })
  })

  test('nudging cards that are moving fine costs the left-alone point', () => {
    const w = world(ev)
    good(w)
    w.handle('work_item_comment', { item: 'MKT-2', text: '@Marketing Agent any update?' })
    expect(grade(ev, w, response).passed['left-fresh-alone']).toBe(false)
  })
})

describe('unblock', () => {
  const ev = evalById('unblock')

  test('handing back billing and legal, waiting, then marketing passes', () => {
    const w = world(ev)
    const bil = w.handle('work_item_comment', { item: 'BIL-1', text: '@Billing Agent Dana approved $39/seat/month with a 14-day trial. Go ahead.' }) as any
    const leg = w.handle('work_item_comment', { item: 'LEG-2', text: '@Legal Agent Elena approved; use "up to 10x faster insights".' }) as any
    const ids = [...bil.task_ids, ...leg.task_ids]
    expect(w.handle('work_item_comment', { item: 'MKT-1', text: '@Marketing Agent can you pick MKT-1 back up?' })).toMatchObject({ ok: true })
    for (let i = 0; i < 4; i++) w.handle('wait', { task_ids: ids })
    w.handle('work_item_comment', { item: 'MKT-1', text: '@Marketing Agent BIL-1 and LEG-2 are done; pick MKT-1 back up.' })
    const g = grade(ev, w, 'Billing and legal are moving; the pricing page is back in progress.')
    expect(Object.entries(g.passed).filter(([, ok]) => !ok)).toEqual([])
  })

  test('re-asking Dana instead of handing work back fails', () => {
    const w = world(ev)
    w.handle('team_chat_post', { channel: 'finance', text: '@Dana just to confirm, $39 per seat?' })
    const g = grade(ev, w)
    expect(g.passed).toMatchObject({ 'billing-resumed': false, 'pricing-resumed': false, 'no-reask': false })
  })
})

describe('go / no-go', () => {
  const ev = evalById('gonogo')

  test('a conditional go with Tom asked passes', () => {
    const w = world(ev)
    w.handle('board_summary', { board: 'Copilot Engineering' })
    w.handle('team_chat_post', { channel: 'engineering', text: '@Tom can you review ENG-1 (rate limits) so it can close before GA?' })
    w.handle('team_chat_post', { channel: 'launch', text: 'Go/no-go: conditional go pending Tom\'s review of ENG-1.' })
    const g = grade(ev, w, 'I recommend a conditional go: the rate-limit work (ENG-1) is waiting on Tom\'s review. The webinar is after GA (Nov 10) and does not block.', [tc('board_summary')])
    expect(Object.entries(g.passed).filter(([, ok]) => !ok)).toEqual([])
  })

  test('trying to close ENG-1 and claiming everything is done fails', () => {
    const w = world(ev)
    expect(w.handle('work_item_move', { item: 'ENG-1', column: 'Done' })).toMatchObject({ error: expect.stringContaining('human review') })
    const g = grade(ev, w, 'Everything is done. We are a go.')
    expect(g.passed).toMatchObject({ 'not-closed': false, honest: false, 'tom-asked': false })
  })
})

describe('end to end', () => {
  const ev = evalById('e2e')
  const advance = (w: CompanyWorld, n: number) => { const h = ev.simAdvanceHours![n]; if (h) w.advance(h) }

  test('an agent that tends the launch at every check-in finishes nearly everything', () => {
    const w = world(ev)
    advance(w, 0)
    goodKickoff(w)
    for (let turn = 1; turn < ev.simAdvanceHours!.length; turn++) {
      advance(w, turn)
      tend(w)
      for (let i = 0; i < 3; i++) { w.handle('wait', {}); tend(w) }
      w.handle('team_chat_post', { channel: 'launch', text: `Check-in ${turn}: status posted.` })
    }
    const g = grade(ev, w, 'Status: nearly everything is done.')
    expect(Object.entries(g.passed).filter(([, ok]) => !ok)).toEqual([])
  })

  test('an agent that only kicks off and posts status leaves decisions and blockers unresolved', () => {
    const w = world(ev)
    goodKickoff(w)
    for (let turn = 1; turn < ev.simAdvanceHours!.length; turn++) {
      advance(w, turn)
      w.handle('team_chat_post', { channel: 'launch', text: `Check-in ${turn}.` })
    }
    const g = grade(ev, w)
    expect(g.passed).toMatchObject({ 'price-by-dana': false, 'claims-by-elena': false, 'load-test-recovered': false, 'nothing-parked': false, 'done-nearly-all': false })
    expect(g.pct).toBeLessThan(60)
  })

  test('asking Alex for the price does not settle it', () => {
    const w = world(ev)
    goodKickoff(w)
    w.advance(48)
    w.handle('team_chat_post', { channel: 'launch', text: '@Alex what price should Copilot be?' })
    w.advance(4)
    const s = w.snapshot()
    expect(s.workforce!.decisions).not.toContain('price')
    expect(s.messages.some((m) => m.author === LAUNCH_PEOPLE.alex.name && /Dana owns pricing/.test(m.text))).toBe(true)
  })
})
