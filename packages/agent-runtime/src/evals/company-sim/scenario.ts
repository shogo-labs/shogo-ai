// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Build arm A/B/C evals from one department scenario.
 *
 * A scenario is a seeded company state, the department agent's role and
 * policies, a prompt (usually a heartbeat), and criteria over the final
 * state. Every arm gets the same world, policies and criteria; only the
 * tools and the "how work is tracked" section of AGENTS.md differ.
 */
import type { AgentEval, EvalResult } from '../types'
import { BOARD_TEMPLATES } from '../../work-templates'
import type { Arm, SimBoard, SimEvent, SimItem, WorldSeed, WorldSnapshot } from './world'

export const SIM_NOW = '2026-10-13T09:00:00.000Z'

/** ISO time `hours` before SIM_NOW. */
export function ago(hours: number): string {
  return new Date(Date.parse(SIM_NOW) - hours * 3_600_000).toISOString()
}

/** A board from a production template, as the world models it. */
export function templateBoard(templateId: string, overrides: Partial<SimBoard> = {}): SimBoard {
  const t = BOARD_TEMPLATES.find((b) => b.id === templateId)
  if (!t) throw new Error(`Unknown board template ${templateId}`)
  return {
    id: templateId,
    name: t.board.name,
    channel: t.channel,
    itemType: t.board.itemType,
    keyPrefix: t.board.keyPrefix ?? 'ITEM',
    columns: (t.board.columns ?? []).map((c) => ({ ...c })),
    ...(t.board.requiresHumanReview ? { requiresHumanReview: true } : {}),
    ...(t.board.fields?.length ? { fields: t.board.fields.map((f) => ({ key: f.key, type: f.type, options: f.options })) } : {}),
    ...overrides,
  }
}

/** A card-history comment `hoursAgo` before now. */
export function said(hoursAgo: number, author: string, text: string, kind: SimEvent['kind'] = 'comment'): SimEvent {
  return { at: ago(hoursAgo), author, kind, text }
}

type SeedItem = WorldSeed['items'][number]

/** A seeded card; createdAt and lastActivityAt default from its history. */
export function card(key: string, board: string, column: string, title: string, opts: Partial<Omit<SimItem, 'key' | 'board' | 'column' | 'title'>> & { createdHoursAgo?: number } = {}): SeedItem {
  const { createdHoursAgo, ...rest } = opts
  const history = rest.history ?? []
  const created = createdHoursAgo !== undefined ? ago(createdHoursAgo) : history[0]?.at ?? ago(24)
  const last = history.length ? history[history.length - 1].at : created
  return {
    key, board, column, title,
    createdAt: created,
    lastActivityAt: last,
    enteredColumnAt: rest.enteredColumnAt ?? last,
    ...rest,
    history: [{ at: created, author: 'Intake', kind: 'created', text: `created in ${column}` }, ...history],
  }
}

export interface ScenarioCriterion {
  id: string
  description: string
  points: number
  check: (s: WorldSnapshot, r: EvalResult) => boolean
}

export interface Scenario {
  id: string
  name: string
  department: string
  level: 1 | 2 | 3 | 4 | 5
  /** The agent's name; also how it appears as an author in the world. */
  agent: string
  /** One paragraph: who the agent is and what it is for. */
  role: string
  duties: string[]
  policies: string[]
  world: Omit<WorldSeed, 'arm' | 'me' | 'now'> & { now?: string }
  input: string
  criteria: ScenarioCriterion[]
  /** Criteria whose outcome depends on reading card history (for the ablation report). */
  historyDependent?: string[]
}

export const ARMS: Arm[] = ['A', 'B', 'C']

export function scenarioEvals(sc: Scenario, arms: Arm[] = ARMS): AgentEval[] {
  return arms.map((arm) => ({
    id: `sim-${sc.id}--${arm.toLowerCase()}`,
    name: `Company sim (${arm}): ${sc.name}`,
    category: 'company-sim',
    level: sc.level,
    input: sc.input,
    maxScore: sc.criteria.reduce((n, c) => n + c.points, 0),
    tags: ['company-sim', `arm-${arm.toLowerCase()}`, `dept-${sc.department}`, `scenario-${sc.id}`],
    workspaceFiles: { 'AGENTS.md': agentsMd(sc, arm) },
    sim: { now: sc.world.now ?? SIM_NOW, arm, me: sc.agent, ...sc.world },
    validationCriteria: sc.criteria.map((c) => ({
      id: c.id,
      description: c.description,
      points: c.points,
      phase: 'execution',
      validate: (r: EvalResult) => !!r.sim && c.check(r.sim, r),
    })),
  }))
}

export function agentsMd(sc: Scenario, arm: Arm): string {
  const boards = sc.world.boards
  const tracking = arm === 'B'
    ? [
        'There are no boards. Each piece of work is a top-level message in its channel that starts with its key in brackets, e.g. `[SUP-12] Title`. Its thread is its full history.',
        '- Find work with `team_chat_read` on the channel, and read a request\'s thread (`team_chat_read` with `thread_id`) before acting on it. `team_chat_search` finds older requests.',
        '- Record every change as a reply in the request\'s thread, one line each: `Status: <status>`, `Priority: <urgent|high|medium|low>`, `Owner: <name>`, `Due: <YYYY-MM-DD>`, followed by your note.',
        '- To open a new request, post a top-level message in the channel starting with `New request:`.',
        '- Statuses by channel:',
        ...boards.map((b) => `  - #${b.channel} (${b.name}): ${b.columns.map((c) => c.name).join(', ')}`),
      ]
    : [
        'Work is tracked on boards in your channels (`board_list`). Each card has a key like `SUP-12`, an owner, a column and a full history.',
        '- Find work with `board_health` and `work_item_list`. Before acting on a card, read its record with `work_item_get` (and `work_item_history` for older entries).',
        '- Change cards with `work_item_move`, `work_item_update` and `work_item_comment`. Leave a comment on the card for anything a teammate should know later.',
        '- If a message is about an existing card, update that card instead of opening a new one. Use the card key when you post in chat.',
        '- Boards:',
        ...boards.map((b) => `  - #${b.channel} ${b.name}: ${b.columns.map((c) => c.name).join(', ')}${b.requiresHumanReview ? ' (a person closes cards)' : ''}`),
      ]
  return [
    `# ${sc.agent}`,
    '',
    sc.role,
    '',
    '## How work is tracked',
    '',
    ...tracking,
    '',
    '## Duties',
    '',
    ...sc.duties.map((d) => `- ${d}`),
    '',
    '## Policies',
    '',
    ...sc.policies.map((p) => `- ${p}`),
    '',
    'Act on what you find with your tools, then reply with a short summary of what you changed.',
    '',
  ].join('\n')
}
