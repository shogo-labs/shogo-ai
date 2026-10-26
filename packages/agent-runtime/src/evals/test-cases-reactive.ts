// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reactive management: does the workspace agent run work in motion the way
 * Cursor or Claude Code do (hand it off, end the turn, act the moment a
 * [Task update] says a piece finished), instead of setting hourly schedules
 * or a short heartbeat to check in?
 *
 * The runner plays production between turns (company-sim `wakes`): after
 * each turn, simulated time passes until the next wake (a watched card
 * stopping, a schedule firing, or the heartbeat) and that wake is the next
 * message. Criteria grade the board, the timers the agent set, and how long
 * finished work sat before the agent acted on it, in simulated hours.
 *
 * `react-monitor-phase` is the platform as shipped (handoffs are watched).
 * `react-monitor-phase-unwatched` turns that off, so only the agent's own
 * choices (wait on the task, or a timer) decide how fast it reacts.
 *
 *   bun run src/evals/run-eval.ts --track reactive --model claude-haiku-5-5
 */
import type { AgentEval, EvalResult } from './types'
import type { SimItem, WakeSeed, WorldSeed, WorldSnapshot } from './company-sim/world'
import type { SimRun, SimRunSeed, SimWorkerScript } from './company-sim/workers'
import { firesPerDay, parseCron } from './company-sim/cron'
import { myMessages } from './company-sim/graders'

type Check = (s: WorldSnapshot, r: EvalResult) => boolean
interface Criterion { id: string; description: string; points: number; check: Check }

const NOW = '2026-10-14T15:00:00.000Z'
const HOUR = 3_600_000
const ENGINEER = { key: 'samsara-engineer', name: 'Samsara Engineer' }
const CHANNEL = 'samsara'
const BOARD = 'Samsara Phase 0'

const COLUMNS = [
  { name: 'Backlog', category: 'backlog' as const },
  { name: 'In progress', category: 'active' as const },
  { name: 'Blocked', category: 'waiting' as const },
  { name: 'Review', category: 'review' as const },
  { name: 'Done', category: 'done' as const },
]

export const PHASE0 = [
  { key: 'P0-1', title: 'Repo scaffold and build', id: 'scaffold' },
  { key: 'P0-2', title: 'Simulation kernel', id: 'kernel' },
  { key: 'P0-3', title: 'Asset pipeline', id: 'assets' },
  { key: 'P0-4', title: 'CI and test harness', id: 'ci' },
  { key: 'P0-5', title: 'Phase 0 demo build', id: 'demo' },
] as const

/** Each card takes the engineer about 7 simulated hours and lands in Review. */
function script(id: string, title: string, beats?: SimWorkerScript['beats']): SimWorkerScript {
  return {
    id, match: `^${title}$`, team: 'samsara|engineer', teamLabel: 'Samsara',
    beats: beats ?? [
      { afterHours: 1, action: 'start', text: 'Picked up {key}.' },
      { afterHours: 3, action: 'comment', text: 'Most of {key} is in; running the checks.' },
      { afterHours: 3, action: 'finish', to: 'review', text: 'Finished {key}: {title}. Checks pass; ready for review.' },
    ],
  }
}

const STALLS: SimWorkerScript['beats'] = [
  { afterHours: 1, action: 'start', text: 'Picked up {key}.' },
  { afterHours: 2, action: 'silent', text: '' },
  { afterHours: 4, action: 'finish', to: 'review', text: 'Finished {key}: {title}. Checks pass; ready for review.' },
]

const AGENTS_MD = `# Samsara

You run the Samsara project for Russell. The engineering work is done by the **${ENGINEER.name}** agent (project \`${ENGINEER.key}\`).

- Phase 0 is on the **${BOARD}** board in #${CHANNEL}: ${PHASE0.map((c) => `${c.key} ${c.title}`).join(', ')}.
- Cards go in order, one at a time: hand the next card to ${ENGINEER.name} only after the previous one is closed.
- When the engineer moves a card to Review, check its comments and close it (move it to Done) if the checks pass.
- Russell does not review Phase 0 cards himself.
`

interface Stage { column: (key: string) => string; assigned?: string[] }

/** What the engineer left on a card it already worked: the same lines its script writes. */
function finishedHistory(key: string, title: string, column: string): SimItem['history'] {
  const at = (h: number) => new Date(Date.parse(NOW) - h * HOUR).toISOString()
  const started = column === 'In progress' ? 1 : 8
  const events: SimItem['history'] = [
    { at: at(started), author: ENGINEER.name, kind: 'moved', text: 'moved from Backlog to In progress' },
    { at: at(started), author: ENGINEER.name, kind: 'comment', text: `Picked up ${key}.` },
  ]
  if (column === 'In progress') return events
  return [
    ...events,
    { at: at(1), author: ENGINEER.name, kind: 'moved', text: 'moved from In progress to Review' },
    { at: at(1), author: ENGINEER.name, kind: 'comment', text: `Finished ${key}: ${title}. Checks pass; ready for review.` },
    ...(column === 'Done' ? [{ at: at(0.5), author: 'Workspace Agent', kind: 'moved' as const, text: 'moved from Review to Done' }] : []),
  ]
}

function seed(stage: Stage, opts: { wakes?: WakeSeed; runs?: SimRunSeed[]; scripts?: Record<string, SimWorkerScript['beats']> } = {}): WorldSeed {
  return {
    now: NOW,
    arm: 'A',
    me: 'Workspace Agent',
    people: [{ id: 'russell', name: 'Russell', role: 'owner' }],
    channels: [{ name: CHANNEL, members: [`agent:${ENGINEER.key}`] }],
    boards: [{ id: 'p0', name: BOARD, channel: CHANNEL, itemType: 'task', keyPrefix: 'P0', columns: COLUMNS }],
    items: PHASE0.map((c, n) => ({
      key: c.key, board: 'p0', column: stage.column(c.key), title: c.title,
      description: `Phase 0, step ${n + 1} of ${PHASE0.length}.`,
      assigneeAgent: stage.assigned?.includes(c.key) ? ENGINEER.key : null,
      createdAt: new Date(Date.parse(NOW) - 30 * HOUR).toISOString(),
      ...(stage.column(c.key) === 'Backlog' ? {} : (() => {
        const history = finishedHistory(c.key, c.title, stage.column(c.key))
        const last = history[history.length - 1].at
        return { history, lastActivityAt: last, enteredColumnAt: history.filter((e) => e.kind === 'moved').pop()!.at }
      })()),
    })),
    agents: [{ key: ENGINEER.key, name: ENGINEER.name, capabilities: {}, files: [] }],
    workforce: {
      workers: PHASE0.map((c) => script(c.id, c.title, opts.scripts?.[c.key])),
      runs: opts.runs,
    },
    ...(opts.wakes ? { wakes: opts.wakes } : {}),
  }
}

const P01_FINISHED: Stage = { column: (k) => (k === 'P0-1' ? 'Review' : 'Backlog'), assigned: ['P0-1'] }
const P01_DONE_RUN: SimRunSeed = { item: 'P0-1', agent: ENGINEER.key, script: 'scaffold', status: 'done', next: 3, hoursAgo: 1 }
const HISTORY = [
  { role: 'user' as const, content: 'Set up Phase 0 of Samsara on a board and get the engineer going on it.' },
  { role: 'assistant' as const, content: `Phase 0 is on the ${BOARD} board in #${CHANNEL} (${PHASE0.map((c) => c.key).join(' to ')}). I handed P0-1 ${PHASE0[0].title} to ${ENGINEER.name}; it is in progress.` },
]

// ─── Graders ────────────────────────────────────────────────────────────────

const categoryOf = (s: WorldSnapshot, i: SimItem) => s.boards.find((b) => b.id === i.board)?.columns.find((c) => c.name === i.column)?.category
const item = (s: WorldSnapshot, key: string) => s.items.find((i) => i.key === key)
const runOf = (s: WorldSnapshot, key: string): SimRun | undefined => s.workforce?.runs.find((r) => r.kind === 'card' && r.item === key)
const closed = (s: WorldSnapshot, key: string) => { const i = item(s, key); return !!i && categoryOf(s, i) === 'done' }

/** A cadence of 6 hours or less: polling, not a sweep. */
const SHORT_FIRES_PER_DAY = 4
const SHORT_HEARTBEAT_SECONDS = 6 * 3600

/** Timers the agent set to poll work in motion: a schedule firing at least 4 times a day, or a heartbeat shorter than 6h. */
export function pollingTimers(s: WorldSnapshot): string[] {
  const out: string[] = []
  for (const e of s.log) {
    if (!e.ok) continue
    const cron = typeof e.params.cron === 'string' ? e.params.cron : null
    if ((e.tool === 'schedule_create' || e.tool === 'schedule_update') && cron && firesPerDay(cron) >= SHORT_FIRES_PER_DAY) out.push(`${e.tool} ${cron}`)
    if (e.tool === 'heartbeat_configure' && e.params.enabled !== false && Number(e.params.interval) > 0 && Number(e.params.interval) < SHORT_HEARTBEAT_SECONDS) out.push(`heartbeat ${e.params.interval}s`)
  }
  return out
}

/** Hours between each card landing in Review and the next card going to the engineer. */
export function handoffLags(s: WorldSnapshot, from = 1): number[] {
  const lags: number[] = []
  for (let n = from; n < PHASE0.length - 1; n++) {
    const prev = runOf(s, PHASE0[n].key), next = runOf(s, PHASE0[n + 1].key)
    if (!prev?.settledAt || !next) continue
    lags.push((Date.parse(next.startedAt) - Date.parse(prev.settledAt)) / HOUR)
  }
  return lags
}

/** Hours each finished card sat before the agent heard about it (a [Task update], a timer, or wait). */
export function reactionHours(s: WorldSnapshot): number[] {
  return (s.workforce?.runs ?? [])
    .filter((r) => r.kind === 'card' && r.settledAt && Date.parse(r.settledAt) >= Date.parse(NOW))
    .map((r) => (r.seenAt ? (Date.parse(r.seenAt) - Date.parse(r.settledAt!)) / HOUR : Infinity))
}

const REACTIVE_PROMISE = /as soon as|the moment|right away|immediately|as (each( card)?|it|they) (arrive|finish|land|reach|come|move)|when each|each time|whenever (a|each|the)|once (it|each|the)/i
const POLLING_PROMISE = /every (\d+\s*)?(hour|hr|min)|hourly|check (back )?in (an|1|one) hour/i

function build(id: string, name: string, level: AgentEval['level'], input: string, sim: WorldSeed, criteria: Criterion[], extra: Partial<AgentEval> = {}): AgentEval {
  return {
    id: `react-${id}`,
    name: `Reactive: ${name}`,
    category: 'reactive',
    level,
    input,
    conversationHistory: HISTORY,
    maxScore: criteria.reduce((n, c) => n + c.points, 0),
    tags: ['reactive', 'orchestration', `react-${id}`],
    workspaceFiles: { 'AGENTS.md': AGENTS_MD },
    sim,
    validationCriteria: criteria.map((c) => ({ id: c.id, description: c.description, points: c.points, phase: 'execution', validate: (r: EvalResult) => !!r.sim && c.check(r.sim, r) })),
    ...extra,
  }
}

// ─── Run a phase through the engineer ───────────────────────────────────────

/** The user's words from the production session this suite came from. */
export const MONITOR_PROMPT = 'P0-1 is finished, continue with the rest and put yourself on a loop to watch and check back at each phase'

const PHASE_WAKES: WakeSeed = { horizonHours: 72, maxWakes: 16, heartbeat: { intervalSeconds: 4 * 3600 } }

export const MONITOR_CRITERIA: Criterion[] = [
  { id: 'closed-p0-1', description: 'Closed P0-1 (Review to Done)', points: 2, check: (s) => closed(s, 'P0-1') },
  { id: 'handed-p0-2', description: 'Handed P0-2 to the engineer in the same turn', points: 2, check: (s) => runOf(s, 'P0-2')?.startedAt === NOW },
  { id: 'no-polling-timer', description: 'Set no schedule or heartbeat that fires every 6h or more often', points: 3, check: (s) => pollingTimers(s).length === 0 },
  { id: 'said-reactive', description: 'Told the user it will act as each card finishes, not on a timer', points: 1, check: (_s, r) => REACTIVE_PROMISE.test(r.responseText) && !POLLING_PROMISE.test(r.responseText) },
  { id: 'reacted-fast', description: 'Each next card went to the engineer within 30 simulated minutes of the previous one landing in Review', points: 3, check: (s) => { const lags = handoffLags(s); return lags.length >= 2 && lags.every((h) => h <= 0.5) } },
  { id: 'phase-done', description: 'All of Phase 0 closed within the wakes', points: 3, check: (s) => PHASE0.every((c) => closed(s, c.key)) },
  { id: 'in-order', description: 'Never had two Phase 0 cards with the engineer at once', points: 1, check: (s) => {
    const spans = (s.workforce?.runs ?? []).filter((r) => r.kind === 'card').map((r) => [Date.parse(r.startedAt), Date.parse(r.settledAt ?? '9999-01-01')] as const)
    return spans.every(([a, b], n) => spans.every(([c, d], m) => m === n || b <= c || d <= a))
  } },
]

const monitor = (policy: WakeSeed['policy']) => seed(P01_FINISHED, { runs: [P01_DONE_RUN], wakes: { ...PHASE_WAKES, policy } })

// ─── A worker that goes quiet ───────────────────────────────────────────────

export const STALL_CRITERIA: Criterion[] = [
  { id: 'no-polling-timer', description: 'Set no schedule or heartbeat that fires every 6h or more often', points: 3, check: (s) => pollingTimers(s).length === 0 },
  { id: 'heard-stall', description: 'Restarted P0-2 from its task reporting the stop (a [Task update] or wait), not a heartbeat or schedule', points: 1, check: (s) => {
    const run = runOf(s, 'P0-2')
    return !!run && run.resumed >= 1 && !(s.wakes ?? []).some((w) => w.kind !== 'task' && w.runs.includes(run.id))
  } },
  { id: 'restarted', description: 'Got the engineer going on P0-2 again', points: 3, check: (s) => (runOf(s, 'P0-2')?.resumed ?? 0) >= 1 },
  { id: 'p0-2-closed', description: 'P0-2 was finished and closed', points: 2, check: (s) => closed(s, 'P0-2') },
  { id: 'kept-going', description: 'Handed P0-3 on after closing P0-2', points: 1, check: (s) => !!runOf(s, 'P0-3') },
]

// ─── Requests that are about the clock ──────────────────────────────────────

const P02_RUNNING: Stage = { column: (k) => (k === 'P0-1' ? 'Done' : k === 'P0-2' ? 'In progress' : 'Backlog'), assigned: ['P0-1', 'P0-2'] }
const P02_RUN: SimRunSeed = { item: 'P0-2', agent: ENGINEER.key, script: 'kernel', status: 'running', next: 1, hoursAgo: 1 }

function mondayNineDigest(s: WorldSnapshot): boolean {
  return s.log.some((e) => {
    if (!e.ok || e.tool !== 'schedule_create' || typeof e.params.cron !== 'string') return false
    const cron = parseCron(e.params.cron)
    if (!cron || firesPerDay(e.params.cron, new Date('2026-10-19T00:00:00Z')) !== 1) return false
    for (let t = Date.parse('2026-10-18T00:00:00Z'); t < Date.parse('2026-10-25T00:00:00Z'); t += 60_000) {
      const at = new Date(t)
      if (cron.matches(at)) return at.getUTCDay() === 1 && at.getUTCHours() === 9
    }
    return false
  })
}

export const REACTIVE_EVALS: AgentEval[] = [
  build('monitor-phase', 'Run Phase 0 card by card when asked to "loop"', 3, MONITOR_PROMPT, monitor('auto'), MONITOR_CRITERIA),
  build('monitor-phase-unwatched', 'Run Phase 0 when the platform does not watch handoffs', 4, MONITOR_PROMPT, monitor('watched'), MONITOR_CRITERIA),
  build(
    'worker-stalls',
    'Restart a worker that stops without finishing',
    3,
    'P0-1 is finished. Keep Phase 0 moving until it is done.',
    seed(P01_FINISHED, { runs: [P01_DONE_RUN], scripts: { 'P0-2': STALLS }, wakes: { horizonHours: 48, maxWakes: 10, heartbeat: { intervalSeconds: 4 * 3600 } } }),
    STALL_CRITERIA,
  ),
  build(
    'explicit-cron',
    'A digest tied to the clock is still a schedule',
    2,
    `Every Monday at 9am UTC, post a short Phase 0 status digest in #${CHANNEL}.`,
    seed(P02_RUNNING, { runs: [P02_RUN], wakes: { horizonHours: 1, maxWakes: 0 } }),
    [
      { id: 'weekly-schedule', description: 'Created a schedule that fires Mondays at 9:00', points: 3, check: mondayNineDigest },
      { id: 'no-heartbeat', description: 'Did not turn the heartbeat into the digest', points: 1, check: (s) => !s.log.some((e) => e.tool === 'heartbeat_configure' && e.ok) },
    ],
  ),
  build(
    'asks-hourly',
    'Asked for an hourly check-in on running work',
    3,
    'Can you set up an hourly check on the engineer so P0-2 doesn\'t stall?',
    seed(P02_RUNNING, { runs: [P02_RUN], wakes: { horizonHours: 1, maxWakes: 0 } }),
    [
      { id: 'explains-reactive', description: 'Explains it hears the moment P0-2 finishes or stops', points: 3, check: (_s, r) => REACTIVE_PROMISE.test(r.responseText) && /stop|stall|finish|done|review/i.test(r.responseText) },
      { id: 'kept-card', description: 'P0-2 is still with the engineer', points: 1, check: (s) => item(s, 'P0-2')?.assigneeAgent === ENGINEER.key && runOf(s, 'P0-2')?.status === 'running' },
      { id: 'no-noise', description: 'Did not post check-in noise in the channel', points: 1, check: (s) => myMessages(s, CHANNEL).length <= 1 },
    ],
  ),
]
