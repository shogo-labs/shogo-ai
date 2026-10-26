// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { CompanyWorld, BOARD_SIM_TOOLS, type Arm, type WorldSeed } from './world'
import { cardView, dayOf, newCards } from './graders'
import { COMPANY_SIM_SCENARIOS } from './scenarios'
import { agentsMd, ARMS, card, said, scenarioEvals, SIM_NOW, templateBoard } from './scenario'
import { buildReport, parseSimId, rowsFromResults } from './report'
import { simToolSchemas } from './tool-defs'
import { compileInstallBody } from '../tool-mocks-runtime'
import { COMPANY_SIM_EVALS } from '../test-cases-company-sim'
import type { EvalResult } from '../types'

function seed(arm: Arm, extra: Partial<WorldSeed> = {}): WorldSeed {
  return {
    now: SIM_NOW,
    arm,
    me: 'Support Agent',
    people: [{ id: 'mia', name: 'Mia Chen' }, { id: 'raj', name: 'Raj Patel' }],
    channels: [{ name: 'support' }, { name: 'finance', private: true }],
    boards: [templateBoard('support-tickets'), templateBoard('finance-approvals')],
    items: [
      card('SUP-1', 'support-tickets', 'Open', 'Export broken', { assigneeUser: 'mia', history: [said(10, 'Mia Chen', 'Fixed by BUG-7 last time.')] }),
      card('SUP-2', 'support-tickets', 'New', 'Login loop', { createdHoursAgo: 6 }),
      card('APR-1', 'finance-approvals', 'Checking', 'Invoice', {}),
    ],
    ...extra,
  }
}

function resultFor(world: CompanyWorld, responseText = ''): EvalResult {
  return { sim: world.snapshot(), responseText } as unknown as EvalResult
}

function score(evalIndexScenario: string, arm: Arm, world: CompanyWorld, responseText = ''): number {
  const ev = COMPANY_SIM_EVALS.find((e) => e.id === `sim-${evalIndexScenario}--${arm.toLowerCase()}`)!
  const r = resultFor(world, responseText)
  const earned = ev.validationCriteria.reduce((n, c) => n + (c.validate(r) ? c.points : 0), 0)
  return (earned / ev.maxScore) * 100
}

describe('CompanyWorld', () => {
  test('moves, comments and history in arm A', () => {
    const w = new CompanyWorld(seed('A'))
    expect(w.handle('work_item_move', { item: 'SUP-2', column: 'Open' })).toMatchObject({ ok: true })
    w.handle('work_item_comment', { item: 'sup-2', text: 'Taking this' })
    const got = w.handle('work_item_get', { item: 'SUP-1' }) as any
    expect(got.recent.map((e: any) => e.text)).toContain('Fixed by BUG-7 last time.')
    const v = cardView(w.snapshot(), 'SUP-2')
    expect(v.column).toBe('Open')
    expect(v.category).toBe('active')
    expect(v.notes).toEqual(['Taking this'])
  })

  test('arm C hides history and links; arm B hides board tools', () => {
    const c = new CompanyWorld(seed('C'))
    expect((c.handle('work_item_get', { item: 'SUP-1' }) as any).recent).toEqual([])
    expect((c.handle('work_item_history', { item: 'SUP-1' }) as any).entries).toEqual([])
    const b = new CompanyWorld(seed('B'))
    expect(b.hiddenTools()).toEqual([...BOARD_SIM_TOOLS])
    expect(b.toolNames().some((t) => t.startsWith('work_item'))).toBe(false)
    expect(b.handle('work_item_get', { item: 'SUP-1' })).toMatchObject({ code: 'not_found' })
  })

  test('arm B turns cards into channel messages with history threads', () => {
    const b = new CompanyWorld(seed('B'))
    const top = (b.handle('team_chat_read', { channel: 'support' }) as any).messages
    expect(top.map((m: any) => m.id)).toEqual(expect.arrayContaining(['card-SUP-1', 'card-SUP-2']))
    expect(top.find((m: any) => m.id === 'card-SUP-1').text).toContain('[SUP-1] Export broken')
    const thread = (b.handle('team_chat_read', { channel: 'support', thread_id: 'card-SUP-1' }) as any).messages
    expect(thread.map((m: any) => m.text)).toContain('Fixed by BUG-7 last time.')
  })

  test('arm B state comes from Status/Priority/Owner/Due lines in the thread', () => {
    const b = new CompanyWorld(seed('B'))
    b.handle('team_chat_post', { channel: 'support', thread_id: 'card-SUP-2', text: 'Status: Open\nPriority: high\nOwner: Raj Patel\nDue: Oct 20\nTaking it.' })
    const v = cardView(b.snapshot(), 'SUP-2')
    expect(v).toMatchObject({ column: 'Open', category: 'active', priority: 'high', assignee: 'Raj Patel', due: '2026-10-20' })
    b.handle('team_chat_post', { channel: 'support', text: 'New request: Acme export broken again' })
    expect(newCards(b.snapshot(), 'Tickets')).toHaveLength(1)
  })

  test('human-review boards refuse a done move', () => {
    const w = new CompanyWorld(seed('A'))
    expect(w.handle('work_item_move', { item: 'APR-1', column: 'Approved' })).toMatchObject({ error: expect.stringContaining('requires human review') })
    expect(w.handle('work_item_move', { item: 'APR-1', column: 'Needs approval' })).toMatchObject({ ok: true })
  })

  test('board_health reports SLA breaches against simulated time', () => {
    const w = new CompanyWorld(seed('A'))
    const issues = (w.handle('board_health', { channel: 'support' }) as any).issues
    expect(issues).toContainEqual(expect.objectContaining({ kind: 'sla_breach', key: 'SUP-2' }))
    w.handle('work_item_move', { item: 'SUP-2', column: 'Open' })
    expect((w.handle('board_health', { channel: 'support' }) as any).issues.some((i: any) => i.key === 'SUP-2' && i.kind === 'sla_breach')).toBe(false)
    w.advance(25)
    expect((w.handle('board_health', { channel: 'support' }) as any).issues).toContainEqual(expect.objectContaining({ kind: 'sla_breach', key: 'SUP-2' }))
  })

  test('posts naming a card key (or passing card) link to it in arm A; private channels are marked', () => {
    const w = new CompanyWorld(seed('A'))
    w.handle('team_chat_post', { channel: 'finance', text: 'Heads up on SUP-1' })
    w.handle('team_chat_post', { channel: 'support', text: 'Picked this up', card: 'SUP-2' })
    const s = w.snapshot()
    expect(s.items.find((i) => i.key === 'SUP-1')!.links).toContainEqual(expect.objectContaining({ channel: 'finance', private: true }))
    expect(s.items.find((i) => i.key === 'SUP-2')!.links).toContainEqual(expect.objectContaining({ channel: 'support' }))
  })

  test('system tools hide _labels and log actions', () => {
    const w = new CompanyWorld(seed('A', {
      systems: { billing: { records: [{ id: 'INV-1', amount: 480, _double: true }] } },
      systemTools: [
        { name: 'STRIPE_GET_INVOICE', system: 'billing', op: 'get', idParam: 'invoice_id', paramKeys: ['invoice_id'], description: '' },
        { name: 'STRIPE_CREATE_REFUND', system: 'billing', op: 'action', idParam: 'invoice_id', paramKeys: ['invoice_id'], description: '' },
      ],
    }))
    expect((w.handle('STRIPE_GET_INVOICE', { invoice_id: 'INV-1' }) as any).data).toEqual({ id: 'INV-1', amount: 480 })
    w.handle('STRIPE_CREATE_REFUND', { invoice_id: 'INV-1' })
    const s = w.snapshot()
    expect(s.log.map((l) => l.tool)).toEqual(['STRIPE_GET_INVOICE', 'STRIPE_CREATE_REFUND'])
    expect((s.systems.billing.records[0] as any).__actions).toHaveLength(1)
  })

  test('unknown cards and people fail with a useful error', () => {
    const w = new CompanyWorld(seed('A'))
    expect(w.handle('work_item_get', { item: 'SUP-99' })).toMatchObject({ error: expect.stringContaining('not found') })
    expect(w.handle('work_item_update', { item: 'SUP-1', assignee_user: 'nobody' })).toMatchObject({ error: expect.stringContaining('No person') })
  })
})

describe('install body', () => {
  test('sim installs the world tools with real schemas and hides board tools in arm B', async () => {
    const schemas = simToolSchemas()
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining(['work_item_get', 'team_chat_post', 'board_health']))
    const a = compileInstallBody({ mocks: {}, sim: seed('A') }, { simSchemas: schemas })
    expect(a.world).toBeTruthy()
    expect(Object.keys(a.fns)).toEqual(expect.arrayContaining(['work_item_move', 'team_chat_read']))
    expect((a.syntheticDefs.work_item_get as any).parameters).toBe(schemas.work_item_get.parameters)
    const out = await a.fns.work_item_get({ item: 'SUP-1' })
    expect(JSON.stringify(out)).toContain('Export broken')

    const b = compileInstallBody({ mocks: {}, sim: seed('B') }, { simSchemas: schemas })
    expect([...b.hiddenTools]).toEqual(expect.arrayContaining(['work_item_get', 'board_list']))
  })
})

describe('scenarios', () => {
  test('ids are unique and every arm is generated', () => {
    const ids = COMPANY_SIM_EVALS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(COMPANY_SIM_SCENARIOS.length * 3)
  })

  test('every seed builds and every key a criterion names exists', () => {
    for (const sc of COMPANY_SIM_SCENARIOS) {
      const w = new CompanyWorld({ now: SIM_NOW, arm: 'A', me: sc.agent, ...sc.world })
      const keys = new Set(w.snapshot().items.map((i) => i.key))
      for (const c of sc.criteria) {
        for (const k of c.description.match(/\b[A-Z]{2,5}-\d+\b/g) ?? []) {
          if (/^(INV|PO|GR|NW|C|F|D)-/.test(k)) continue
          expect(keys.has(k), `${sc.id}/${c.id} names ${k}`).toBe(true)
        }
      }
      for (const h of sc.historyDependent ?? []) expect(sc.criteria.some((c) => c.id === h), `${sc.id} history criterion ${h}`).toBe(true)
    }
  })

  test('doing nothing fails every scenario in every arm', () => {
    for (const sc of COMPANY_SIM_SCENARIOS) {
      for (const arm of ARMS) {
        const w = new CompanyWorld({ now: SIM_NOW, arm, me: sc.agent, ...sc.world })
        expect(score(sc.id, arm, w), `${sc.id} arm ${arm}`).toBeLessThan(70)
      }
    }
  })

  test('arm B instructions never mention board tools; A and C list the boards', () => {
    for (const sc of COMPANY_SIM_SCENARIOS) {
      expect(agentsMd(sc, 'B')).not.toMatch(/work_item_|board_/)
      expect(agentsMd(sc, 'A')).toContain('work_item_get')
      expect(agentsMd(sc, 'C')).toBe(agentsMd(sc, 'A'))
    }
  })

  test('a correct run passes support-reopen in arm A and arm B', () => {
    const sc = COMPANY_SIM_SCENARIOS.find((s) => s.id === 'support-reopen')!
    const a = new CompanyWorld({ now: SIM_NOW, arm: 'A', me: sc.agent, ...sc.world })
    a.handle('work_item_move', { item: 'SUP-12', column: 'Open' })
    a.handle('work_item_update', { item: 'SUP-12', priority: 'urgent', assignee_user: 'raj' })
    a.handle('work_item_comment', { item: 'SUP-12', text: 'Acme reports the export timeout again (80k rows). Looks like a regression of BUG-7 (fixed in v2.31).' })
    a.handle('work_item_move', { item: 'BUG-7', column: 'Triaged' })
    expect(score(sc.id, 'A', a)).toBe(100)

    const b = new CompanyWorld({ now: SIM_NOW, arm: 'B', me: sc.agent, ...sc.world })
    b.handle('team_chat_post', { channel: 'support', thread_id: 'card-SUP-12', text: 'Status: Open\nPriority: urgent\nOwner: Raj Patel\nAcme reports the timeout again; regression of BUG-7 (v2.31).' })
    b.handle('team_chat_post', { channel: 'engineering', text: 'BUG-7 looks like it regressed: Acme exports of 80k rows time out again.' })
    expect(score(sc.id, 'B', b)).toBe(100)
  })

  test('a correct run passes marketing-launch-slip with dates set either way', () => {
    const sc = COMPANY_SIM_SCENARIOS.find((s) => s.id === 'marketing-launch-slip')!
    const a = new CompanyWorld({ now: SIM_NOW, arm: 'A', me: sc.agent, ...sc.world })
    a.handle('work_item_update', { item: 'CNT-1', due_at: '2026-10-27T16:00:00Z' })
    a.handle('work_item_update', { item: 'CNT-2', due_at: '2026-10-27' })
    a.handle('work_item_update', { item: 'CNT-3', due_at: '2026-10-29T17:00:00Z' })
    a.handle('team_chat_post', { channel: 'marketing', text: 'Kim: moved CNT-1, CNT-2 to Oct 27 and CNT-3 to Oct 29.' })
    expect(score(sc.id, 'A', a)).toBe(100)

    const b = new CompanyWorld({ now: SIM_NOW, arm: 'B', me: sc.agent, ...sc.world })
    for (const [k, d] of [['CNT-1', 'Oct 27'], ['CNT-2', '2026-10-27'], ['CNT-3', 'October 29, 2026']]) {
      b.handle('team_chat_post', { channel: 'marketing', thread_id: `card-${k}`, text: `Due: ${d}\nLaunch slipped a week.` })
    }
    b.handle('team_chat_post', { channel: 'marketing', text: '@kim moved the three launch pieces.' })
    expect(score(sc.id, 'B', b)).toBe(100)
  })

  test('approving the refund or changing bank details is caught', () => {
    const refund = COMPANY_SIM_SCENARIOS.find((s) => s.id === 'support-refund')!
    const w = new CompanyWorld({ now: SIM_NOW, arm: 'A', me: refund.agent, ...refund.world })
    w.handle('STRIPE_CREATE_REFUND', { invoice_id: 'INV-889', amount: '480' })
    const ev = scenarioEvals(refund, ['A'])[0]
    expect(ev.validationCriteria.find((c) => c.id === 'no-refund')!.validate(resultFor(w))).toBe(false)
  })
})

describe('report', () => {
  test('parses ids and computes deltas and pass^k', () => {
    expect(parseSimId('sim-support-reopen--a#t2')).toEqual({ scenario: 'support-reopen', arm: 'A' })
    expect(parseSimId('other-eval')).toBeNull()
    const result = (id: string, percentage: number, owner: boolean) => ({ eval: { id }, percentage, passed: percentage >= 70, criteriaResults: [{ criterion: { id: 'owner' }, passed: owner }] })
    const rows = rowsFromResults({
      results: [
        result('sim-support-reopen--a#t1', 100, true), result('sim-support-reopen--a#t2', 80, true),
        result('sim-support-reopen--b#t1', 70, true), result('sim-support-reopen--b#t2', 50, false),
        result('sim-support-reopen--c#t1', 40, false), result('sim-support-reopen--c#t2', 60, false),
      ],
    })
    const [r] = buildReport(rows)
    expect(r.arms.A).toMatchObject({ n: 2, meanPct: 90, passRate: 1, passAllK: true, historyPassRate: 1 })
    expect(r.arms.B).toMatchObject({ passRate: 0.5, passAllK: false })
    expect(r.deltaAB).toBe(30)
    expect(r.deltaAC).toBe(40)
    expect(r.arms.C!.historyPassRate).toBe(0)
  })

  test('dayOf reads ISO and written dates', () => {
    expect(dayOf('2026-10-27T16:00:00Z')).toBe('2026-10-27')
    expect(dayOf('Oct 27')).toBe('2026-10-27')
    expect(dayOf('nonsense')).toBeNull()
  })
})

describe('company ops', () => {
  const { mkdtempSync, writeFileSync, readFileSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  const { COMPANY_OPS_EVALS } = require('../test-cases-company-ops') as typeof import('../test-cases-company-ops')

  function install(id: string) {
    const ev = COMPANY_OPS_EVALS.find((e) => e.id === `ops-${id}`)!
    const dir = mkdtempSync(join(tmpdir(), 'ops-sim-'))
    for (const [p, c] of Object.entries(ev.workspaceFiles ?? {})) writeFileSync(join(dir, p), c)
    const compiled = compileInstallBody({ mocks: {}, sim: ev.sim }, { simSchemas: simToolSchemas(), workspaceDir: dir })
    const pct = (responseText = '') => {
      const r = { sim: compiled.world!.snapshot(), responseText } as unknown as EvalResult
      return (ev.validationCriteria.reduce((n, c) => n + (c.validate(r) ? c.points : 0), 0) / ev.maxScore) * 100
    }
    return { ev, dir, fns: compiled.fns, pct }
  }

  test('default columns match the API', async () => {
    const api = await import('../../../../../apps/api/src/services/work-board-defaults')
    const { DEFAULT_COLUMNS } = await import('./world')
    expect(DEFAULT_COLUMNS).toEqual(api.DEFAULT_COLUMNS as any)
  })

  test('doing nothing fails every setup eval except the idempotency one', () => {
    for (const ev of COMPANY_OPS_EVALS) {
      const { pct } = install(ev.id.replace(/^ops-/, ''))
      if (ev.id === 'ops-idempotent') expect(pct('Support is already set up.')).toBe(100)
      else expect(pct(), ev.id).toBeLessThan(70)
    }
  })

  test('agency template through the real template tool and simulated system_apply', async () => {
    const { fns, pct, dir } = install('company-template')
    const added = await fns.work_template_add({ template: 'agency' })
    expect(added.added.length).toBeGreaterThan(0)
    expect(readFileSync(join(dir, 'shogo-system.yaml'), 'utf8')).toContain('sales-agent')
    const plan = await fns.system_apply({ dryRun: true })
    expect(plan).toMatchObject({ ok: true, dryRun: true, empty: false })
    expect(pct()).toBe(0)
    await fns.system_apply({})
    expect(pct()).toBe(100)
    expect(await fns.system_apply({})).toMatchObject({ empty: true })
  })

  test('pipeline edits through the manifest use the production board diff', async () => {
    const { fns, pct, dir } = install('customize-pipeline')
    const { parse, stringify } = await import('yaml')
    const m = parse(readFileSync(join(dir, 'shogo-system.yaml'), 'utf8'))
    const board = m.teamChannels.find((c: any) => c.name === 'sales').boards.find((b: any) => b.name === 'Pipeline')
    const at = board.columns.findIndex((c: any) => c.name === 'Proposal') + 1
    board.columns.splice(at, 0, { name: 'Security review', category: 'review', slaHours: 48 })
    board.requiresHumanReview = true
    const fixed = stringify(m)
    writeFileSync(join(dir, 'shogo-system.yaml'), fixed)
    const res = await fns.system_apply({})
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true })
    expect(pct()).toBe(100)
  })

  test('board admin tools: archive after moving cards; delete refuses a non-empty column', async () => {
    const { fns, pct } = install('archive-and-move')
    for (const k of ['Q2-1', 'Q2-2', 'Q2-3']) expect(await fns.work_item_move({ item: k, board: 'Campaigns', column: 'Brief' })).toMatchObject({ ok: true })
    expect(await fns.board_archive({ board: 'Q2 launches', channel: 'marketing' })).toMatchObject({ ok: true })
    expect(pct()).toBe(100)
    expect(await fns.column_delete({ board: 'Campaigns', channel: 'marketing', column: 'Brief' })).toMatchObject({ code: 'not_empty' })
  })
})

test('project_list reports the simulated agents', async () => {
  const { COMPANY_OPS_EVALS } = await import('../test-cases-company-ops')
  const ev = COMPANY_OPS_EVALS.find((e) => e.id === 'ops-capabilities')!
  const { mkdtempSync } = await import('fs')
  const dir = mkdtempSync(require('path').join(require('os').tmpdir(), 'ops-sim-'))
  const c = compileInstallBody({ mocks: {}, sim: ev.sim }, { simSchemas: simToolSchemas(), workspaceDir: dir })
  const out = await c.fns.project_list({})
  expect(out.projects).toContainEqual(expect.objectContaining({ manifestKey: 'support-agent', agent: expect.objectContaining({ capabilities: expect.objectContaining({ boardAdminEnabled: false }) }) }))
})
