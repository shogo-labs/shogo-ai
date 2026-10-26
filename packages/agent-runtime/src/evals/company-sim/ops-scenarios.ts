// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Setup and management evals for the workspace agent: can it stand up
 * departments from a sentence or a template, change boards, channels,
 * triggers and agent capabilities, and leave existing setup alone?
 *
 * Runs on the company simulation with board admin on. Templates go through
 * the real `work_template_*` tools and `system_apply` applies the real
 * manifest (parsed and diffed with the production code) to the world, so
 * criteria grade the live workspace afterwards.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { AgentEval, EvalResult } from '../types'
import { BOARDS_GUIDE } from '../../board-tools'
import { parseSystemManifest } from '../../system-manifest'
import { COMPANIES, DEPARTMENTS, renderBundleYaml } from '../../work-templates'
import { card, SIM_NOW } from './scenario'
import { CompanyWorld, type SimBoard, type WorldSeed, type WorldSnapshot } from './world'

const ME = 'Workspace Agent'
const PEOPLE = [
  { id: 'alex', name: 'Alex Morgan', email: 'alex@northpeak.io', title: 'CEO' },
  { id: 'mia', name: 'Mia Chen', email: 'mia@northpeak.io', title: 'Support Lead' },
  { id: 'jo', name: 'Jo Park', email: 'jo@northpeak.io', title: 'Head of Sales' },
]

interface OpsScenario {
  id: string
  name: string
  level: 1 | 2 | 3 | 4 | 5
  input: string
  /** shogo-system.yaml already in the workspace and already applied. */
  existing?: string
  /** Extra live state on top of the applied manifest. */
  extra?: Partial<Pick<WorldSeed, 'channels' | 'boards' | 'items'>>
  criteria: Array<{ id: string; description: string; points: number; check: (s: WorldSnapshot, r: EvalResult) => boolean }>
}

const boardsIn = (s: WorldSnapshot, channel: string) => s.boards.filter((b) => b.channel === channel && !b.archived)
const channel = (s: WorldSnapshot, name: string) => s.channels.find((c) => c.name === name)
const isTicketBoard = (b: SimBoard) => b.itemType === 'ticket' || /ticket|support/i.test(b.name)
const isBugBoard = (b: SimBoard) => b.itemType === 'problem' || /bug|issue|problem/i.test(b.name)

function deptYaml(id: string, edit?: (m: Record<string, any>) => void): string {
  const m = parseYaml(renderBundleYaml('department', id)) as Record<string, any>
  edit?.(m)
  return stringifyYaml(m)
}

/** Live state after applying `yaml` to an empty workspace with #general. */
function applied(yaml: string | undefined, extra: OpsScenario['extra'] = {}): Pick<WorldSeed, 'channels' | 'boards' | 'items' | 'agents' | 'triggers'> {
  const w = new CompanyWorld({ now: SIM_NOW, arm: 'A', me: ME, admin: true, people: PEOPLE, channels: [{ name: 'general' }, ...(extra.channels ?? [])], boards: extra.boards ?? [], items: [] })
  if (yaml) {
    const parsed = parseSystemManifest(yaml)
    if (!parsed.ok || !parsed.manifest) throw new Error(`seed manifest invalid: ${parsed.errors.join('; ')}`)
    w.applyManifest(parsed.manifest, false)
  }
  const s = w.snapshot()
  return { channels: s.channels, boards: s.boards, items: extra.items ?? [], agents: s.agents, triggers: s.triggers }
}

const AGENCY = COMPANIES.find((c) => c.id === 'agency')!
const agencyDepts = DEPARTMENTS.filter((d) => AGENCY.departments.includes(d.id))

const MINIMAL_FINANCE = stringifyYaml({
  version: 1,
  name: 'Northpeak',
  projects: [{ key: 'ops-agent', name: 'Ops Agent', description: 'Runs workspace operations.' }],
  teamChannels: [{ name: 'finance', topic: 'Spend and invoices' }],
})

export const COMPANY_OPS_SCENARIOS: OpsScenario[] = [
  {
    id: 'setup-from-prose',
    name: 'Set up support and engineering from a sentence',
    level: 3,
    input: 'We are a 12-person B2B SaaS. Set up Support and Engineering so customer bug reports can flow from support to engineering. Go ahead and apply it.',
    criteria: [
      { id: 'support-channel', description: '#support exists', points: 1, check: (s) => !!channel(s, 'support') },
      { id: 'eng-channel', description: '#engineering exists', points: 1, check: (s) => !!channel(s, 'engineering') },
      { id: 'ticket-board', description: '#support has a ticket board', points: 2, check: (s) => boardsIn(s, 'support').some(isTicketBoard) },
      { id: 'bug-board', description: '#engineering has a bug board', points: 2, check: (s) => boardsIn(s, 'engineering').some(isBugBoard) },
      { id: 'agents', description: 'A support agent and an engineering agent exist', points: 2, check: (s) => s.agents.some((a) => /support/i.test(a.key)) && s.agents.some((a) => /eng/i.test(a.key)) },
      { id: 'scoped', description: 'Did not set up departments nobody asked for', points: 1, check: (s) => !['finance', 'people', 'legal', 'sales'].some((c) => channel(s, c)) },
    ],
  },
  {
    id: 'company-template',
    name: 'Apply the agency company template',
    level: 2,
    input: 'Set up our workspace from the agency template and apply it.',
    criteria: [
      { id: 'channels', description: 'Every agency department channel exists', points: 3, check: (s) => agencyDepts.every((d) => channel(s, d.channel.name)) },
      { id: 'boards', description: 'Every agency board exists', points: 3, check: (s) => agencyDepts.every((d) => boardsIn(s, d.channel.name).length >= d.boards.length) },
      { id: 'agents', description: 'Every department agent exists', points: 2, check: (s) => agencyDepts.every((d) => s.agents.some((a) => a.key === d.agent.key)) },
      { id: 'private', description: '#people and #finance are private', points: 2, check: (s) => !!channel(s, 'people')?.private && !!channel(s, 'finance')?.private },
    ],
  },
  {
    id: 'customize-pipeline',
    name: 'Add a stage with an SLA and require human review',
    level: 3,
    input: 'On the sales Pipeline board, add a "Security review" stage right after Proposal with a 48 hour SLA, and make the board require a person to close deals.',
    existing: deptYaml('sales'),
    criteria: [
      { id: 'column', description: 'Security review column exists', points: 3, check: (s) => !!pipeline(s)?.columns.some((c) => /security review/i.test(c.name)) },
      { id: 'position', description: 'It sits right after Proposal', points: 2, check: (s) => { const cols = pipeline(s)?.columns.map((c) => c.name.toLowerCase()) ?? []; return cols[cols.indexOf('proposal') + 1] === 'security review' } },
      { id: 'sla', description: 'It has a 48h SLA', points: 2, check: (s) => pipeline(s)?.columns.find((c) => /security review/i.test(c.name))?.slaHours === 48 },
      { id: 'review', description: 'Pipeline requires human review', points: 2, check: (s) => !!pipeline(s)?.requiresHumanReview },
      { id: 'intact', description: 'The other stages are still there', points: 1, check: (s) => ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'].every((n) => pipeline(s)?.columns.some((c) => c.name === n)) },
    ],
  },
  {
    id: 'intake-trigger',
    name: 'New members become onboarding cards',
    level: 3,
    input: 'When someone new joins the workspace, a card for them should show up on the People Onboarding board automatically. Set that up.',
    existing: deptYaml('people', (m) => { delete m.triggers }),
    criteria: [
      { id: 'trigger', description: 'A member.joined trigger exists', points: 3, check: (s) => s.triggers.some((t) => t.event === 'member.joined' && t.enabled) },
      { id: 'target', description: 'It creates a card', points: 2, check: (s) => s.triggers.some((t) => t.event === 'member.joined' && t.target === 'work_item') },
      { id: 'board', description: 'On the Onboarding board', points: 2, check: (s) => s.triggers.some((t) => t.event === 'member.joined' && /onboard/i.test(String(t.card?.board ?? ''))) },
      { id: 'title', description: 'Card title uses the new member\'s name', points: 1, check: (s) => s.triggers.some((t) => /member\.(name|email)/.test(String(t.card?.title ?? ''))) },
      { id: 'intact', description: 'People boards still there', points: 1, check: (s) => boardsIn(s, 'people').length >= 2 },
    ],
  },
  {
    id: 'channel-edit',
    name: 'Make a channel private and add a board to it',
    level: 2,
    input: 'Make #finance private and add a Collections board there for chasing overdue invoices.',
    existing: MINIMAL_FINANCE,
    criteria: [
      { id: 'private', description: '#finance is private', points: 3, check: (s) => !!channel(s, 'finance')?.private },
      { id: 'board', description: '#finance has a collections board', points: 3, check: (s) => boardsIn(s, 'finance').some((b) => /collect/i.test(b.name)) },
      { id: 'columns', description: 'Its columns fit collections (a paid / written-off end state)', points: 1, check: (s) => boardsIn(s, 'finance').some((b) => /collect/i.test(b.name) && b.columns.some((c) => /paid|collected|written/i.test(c.name))) },
    ],
  },
  {
    id: 'archive-and-move',
    name: 'Retire a board without losing its open cards',
    level: 3,
    input: 'Archive the old "Q2 launches" board in #marketing, but move its open cards to Campaigns first.',
    existing: deptYaml('marketing'),
    extra: {
      boards: [{ id: 'q2', name: 'Q2 launches', channel: 'marketing', itemType: 'task', keyPrefix: 'Q2', columns: [{ name: 'Backlog', category: 'backlog' }, { name: 'In progress', category: 'active' }, { name: 'Done', category: 'done' }] }],
      items: [
        card('Q2-1', 'q2', 'In progress', 'Partner webinar series', { createdHoursAgo: 900 }),
        card('Q2-2', 'q2', 'Backlog', 'Customer advisory board kickoff', { createdHoursAgo: 800 }),
        card('Q2-3', 'q2', 'Backlog', 'Pricing page refresh', { createdHoursAgo: 700 }),
        card('Q2-4', 'q2', 'Done', 'Spring launch email', { createdHoursAgo: 1000 }),
      ],
    },
    criteria: [
      { id: 'archived', description: 'Q2 launches is archived', points: 3, check: (s) => !!s.boards.find((b) => b.id === 'q2')?.archived },
      { id: 'moved', description: 'Its 3 open cards are on Campaigns', points: 3, check: (s) => ['Q2-1', 'Q2-2', 'Q2-3'].every((k) => onBoard(s, k, /campaign/i)) },
      { id: 'kept', description: 'No card was archived or lost', points: 1, check: (s) => s.items.filter((i) => i.key.startsWith('Q2-')).every((i) => !i.archived) },
    ],
  },
  {
    id: 'people-private',
    name: 'Hiring setup lands in a private channel',
    level: 2,
    input: 'Create a #people channel with a hiring board for our recruiting.',
    criteria: [
      { id: 'channel', description: '#people exists', points: 1, check: (s) => !!channel(s, 'people') },
      { id: 'private', description: '#people is private', points: 4, check: (s) => !!channel(s, 'people')?.private },
      { id: 'board', description: '#people has a candidate board', points: 2, check: (s) => boardsIn(s, 'people').some((b) => b.itemType === 'candidate' || /hir|candidate|recruit/i.test(b.name)) },
    ],
  },
  {
    id: 'idempotent',
    name: 'Asking again does not duplicate setup',
    level: 2,
    input: 'Set up a support department with a ticket board.',
    existing: deptYaml('support'),
    criteria: [
      { id: 'one-board', description: 'Still exactly one ticket board in #support', points: 4, check: (s) => boardsIn(s, 'support').filter(isTicketBoard).length === 1 },
      { id: 'one-agent', description: 'Still one support agent', points: 2, check: (s) => s.agents.filter((a) => /support/i.test(a.key)).length === 1 },
      { id: 'said-so', description: 'Says it was already set up', points: 1, check: (_s, r) => /already/i.test(r.responseText) },
    ],
  },
  {
    id: 'capabilities',
    name: 'Turn on board management for one agent',
    level: 3,
    input: 'Let the support agent create and edit boards itself, but keep the Problems feature off for it.',
    existing: deptYaml('support'),
    criteria: [
      { id: 'admin-on', description: 'support-agent has boardAdminEnabled', points: 4, check: (s) => s.agents.find((a) => a.key === 'support-agent')?.capabilities.boardAdminEnabled === true },
      { id: 'problems-off', description: 'problemsEnabled is not on', points: 2, check: (s) => s.agents.find((a) => a.key === 'support-agent')?.capabilities.problemsEnabled !== true },
      { id: 'boards-on', description: 'boardsEnabled still on', points: 1, check: (s) => s.agents.find((a) => a.key === 'support-agent')?.capabilities.boardsEnabled === true },
    ],
  },
]

function pipeline(s: WorldSnapshot): SimBoard | undefined {
  return boardsIn(s, 'sales').find((b) => b.name === 'Pipeline')
}

function onBoard(s: WorldSnapshot, key: string, name: RegExp): boolean {
  const item = s.items.find((i) => i.key === key)
  const board = item && s.boards.find((b) => b.id === item.board)
  return !!board && name.test(board.name)
}

export function workspaceAgentsMd(): string {
  return [
    `# ${ME}`,
    '',
    'You are the workspace agent for Northpeak. You set up and run the company\'s team channels, boards, department agents and triggers.',
    '',
    BOARDS_GUIDE,
    '',
    '- The workspace\'s system manifest is `shogo-system.yaml` at the root. Channels (including privacy), boards, agents (with capabilities) and triggers are declared there and created or changed by `system_apply`.',
    '- Act on requests directly; you do not need to ask for confirmation.',
    '',
  ].join('\n')
}

export function opsEvals(): AgentEval[] {
  return COMPANY_OPS_SCENARIOS.map((sc) => {
    const live = applied(sc.existing, sc.extra)
    return {
      id: `ops-${sc.id}`,
      name: `Company ops: ${sc.name}`,
      category: 'company-ops',
      level: sc.level,
      input: sc.input,
      maxScore: sc.criteria.reduce((n, c) => n + c.points, 0),
      tags: ['company-ops'],
      workspaceFiles: { 'AGENTS.md': workspaceAgentsMd(), ...(sc.existing ? { 'shogo-system.yaml': sc.existing } : {}) },
      sim: { now: SIM_NOW, arm: 'A', me: ME, admin: true, people: PEOPLE, ...live },
      validationCriteria: sc.criteria.map((c) => ({
        id: c.id,
        description: c.description,
        points: c.points,
        phase: 'execution',
        validate: (r: EvalResult) => !!r.sim && c.check(r.sim, r),
      })),
    }
  })
}
