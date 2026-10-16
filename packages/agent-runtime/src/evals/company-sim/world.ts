// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A stateful fake company for usefulness evals.
 *
 * The world holds the boards, cards, card history, team chat channels and
 * external systems (helpdesk, CRM, ledger, ...) of a configured workspace,
 * and answers the same tools the agent uses in production (`work_item_*`,
 * `board_*`, `team_chat_*`, plus Composio-shaped system tools). Every
 * mutation is logged with the simulated time, so graders score the final
 * state and the event log instead of which tools were called.
 *
 * Arms (see ablation in the plan):
 *   A — boards and card history (the full system)
 *   B — chat only: no board tools; each card is a channel message and its
 *       history is that message's thread
 *   C — boards without history: work_item_get/history return no thread,
 *       links or summary
 *
 * Pure: no I/O (system_apply and the template tools read the manifest file
 * in tool-mocks-runtime and hand the parsed manifest to `applyManifest`).
 * Serializable seed in, serializable snapshot out.
 */

import { boardTemplateArgs } from '../../work-templates'
import { diffBoards, type LiveBoard, type SystemManifest } from '../../system-manifest'
import { nextCronFire, parseCron } from './cron'
import { Workforce, WORKFORCE_SIM_TOOLS, type SimRun, type WorkforceSeed, type WorkforceSnapshot } from './workers'

export type Arm = 'A' | 'B' | 'C'
export type Category = 'backlog' | 'active' | 'waiting' | 'review' | 'done' | 'dismissed'

export interface SimPerson { id: string; name: string; email?: string; role?: string; title?: string; timezone?: string; away?: boolean }
export interface SimColumn { name: string; category: Category; slaHours?: number; wipLimit?: number; agent?: string }
export interface SimBoard {
  id: string
  name: string
  channel: string
  itemType: string
  keyPrefix: string
  columns: SimColumn[]
  requiresHumanReview?: boolean
  fields?: Array<{ key: string; type?: string; options?: string[] }>
  description?: string
  postToChannel?: string
  /** Manifest agent key (or `workspace`) new cards go to. */
  defaultAgent?: string
  archived?: boolean
}
export interface SimEvent { at: string; author: string; kind: 'comment' | 'moved' | 'assigned' | 'created' | 'updated' | 'linked' | 'agent_run'; text: string; data?: Record<string, unknown> }
export interface SimLink { kind: string; ref: string; snippet?: string; channel?: string; private?: boolean }
export interface SimItem {
  id: string
  key: string
  board: string
  column: string
  title: string
  description?: string
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  assigneeUser?: string | null
  assigneeAgent?: string | null
  fields: Record<string, unknown>
  createdAt: string
  lastActivityAt: string
  /** When the card entered its current column (for SLA). */
  enteredColumnAt: string
  dueAt?: string | null
  historySummary?: string | null
  externalRef?: string | null
  links: SimLink[]
  history: SimEvent[]
  archived?: boolean
}
export interface SimMessage { id: string; channel: string; author: string; text: string; at: string; threadId?: string; kind?: string }
export interface SimChannel { name: string; private?: boolean; topic?: string; members?: string[] }
export interface SimAgent { key: string; name: string; capabilities: Record<string, boolean>; heartbeatInterval?: number; files: string[] }
export interface SimTrigger { key: string; name: string; event: string; target: string; card?: Record<string, unknown>; enabled: boolean }

/** A record store behind Composio-shaped tools, e.g. a helpdesk's tickets. */
export interface SimSystem { records: Array<Record<string, unknown> & { id: string }> }
export interface SimSystemTool {
  name: string
  system: string
  op: 'list' | 'get' | 'update' | 'create' | 'action'
  description: string
  /** Param holding the record id, for get/update/action. */
  idParam?: string
  paramKeys: string[]
}

export interface WorldSeed {
  now: string
  arm: Arm
  /** Who the agent is, as it appears in history and posts. */
  me: string
  people: SimPerson[]
  channels: SimChannel[]
  boards: SimBoard[]
  items: Array<Omit<SimItem, 'id' | 'createdAt' | 'lastActivityAt' | 'enteredColumnAt' | 'fields' | 'links' | 'history' | 'priority'> & Partial<Pick<SimItem, 'createdAt' | 'lastActivityAt' | 'enteredColumnAt' | 'fields' | 'links' | 'history' | 'priority'>>>
  messages?: Array<Omit<SimMessage, 'id'> & { id?: string }>
  systems?: Record<string, SimSystem>
  systemTools?: SimSystemTool[]
  /** Answer the board admin tools (board_create, column_*, ...) and simulate system_apply. */
  admin?: boolean
  agents?: SimAgent[]
  triggers?: SimTrigger[]
  /** Scripted teammates: cards handed to agents get worked on as simulated time passes (see workers.ts). */
  workforce?: WorkforceSeed
  /**
   * Run the workspace agent as production does between turns: after each
   * turn the eval runner asks for the next wake (a [Task update], a schedule
   * or a heartbeat) and sends it as the next message. Adds the schedule and
   * heartbeat tools.
   */
  wakes?: WakeSeed
}

export interface WakeSeed {
  /**
   * `auto` (default): every card handed to an agent is watched, so its stop
   * wakes the workspace agent at once, as production does. `watched`: only
   * runs the agent waited on, project_calls and tags wake it; everything
   * else is found by its schedules and heartbeat.
   */
  policy?: 'auto' | 'watched'
  /** Simulated hours the loop may run, from the first wake request. */
  horizonHours: number
  /** Most wake turns the runner sends (default 12). */
  maxWakes?: number
  /** Heartbeat already on when the eval starts. */
  heartbeat?: { intervalSeconds: number }
  schedules?: Array<Omit<SimSchedule, 'id' | 'createdAt'>>
}

export interface SimSchedule { id: string; name: string; prompt: string; cron: string; enabled: boolean; createdAt: string }

export interface SimWake {
  at: string
  kind: 'task' | 'schedule' | 'heartbeat'
  /** Card runs this wake told the agent about. */
  runs: string[]
  text: string
}

export interface LogEntry { at: string; tool: string; params: Record<string, unknown>; ok: boolean; error?: string }

export interface WorldSnapshot {
  arm: Arm
  me: string
  now: string
  boards: SimBoard[]
  items: SimItem[]
  messages: SimMessage[]
  channels: SimChannel[]
  agents: SimAgent[]
  triggers: SimTrigger[]
  systems: Record<string, SimSystem>
  log: LogEntry[]
  workforce?: WorkforceSnapshot
  schedules?: SimSchedule[]
  heartbeat?: { enabled: boolean; intervalSeconds: number }
  wakes?: SimWake[]
}

export const BOARD_SIM_TOOLS = [
  'board_list', 'board_summary', 'board_health',
  'work_item_list', 'work_item_get', 'work_item_create', 'work_item_update', 'work_item_move',
  'work_item_comment', 'work_item_bulk_update', 'work_item_history', 'work_item_link',
] as const
export const ADMIN_SIM_TOOLS = ['board_create', 'board_update', 'board_archive', 'column_create', 'column_update', 'column_delete'] as const
export const CHAT_SIM_TOOLS = ['team_chat_list', 'team_chat_read', 'team_chat_post', 'team_chat_search', 'team_chat_dm', 'team_directory'] as const
/** File tools that can target another project (`project`); simulated agents' files live in the world. */
export const PROJECT_FILE_TOOLS = ['write_file', 'edit_file', 'read_file'] as const
/** Timers the agent can set when the eval runs its wakes. */
export const TIMER_SIM_TOOLS = ['schedule_create', 'schedule_update', 'schedule_list', 'schedule_delete', 'heartbeat_configure', 'heartbeat_status'] as const

type Result = { ok: true; [k: string]: unknown } | { error: string; code?: string }

const CLOSED: Category[] = ['done', 'dismissed']
const HOUR = 3_600_000

/** The real `wait`'s timeout (default 30s, at most 10 min), in simulated hours: it cannot block on hours of work. */
function waitCapHours(timeoutMs: unknown): number {
  const ms = typeof timeoutMs === 'number' && timeoutMs >= 0 ? Math.min(timeoutMs, 600_000) : 30_000
  return ms / HOUR
}

export class CompanyWorld {
  readonly arm: Arm
  readonly me: string
  private now: Date
  private people: SimPerson[]
  private channels: SimChannel[]
  private boards: SimBoard[]
  private items: SimItem[]
  private messages: SimMessage[]
  private systems: Record<string, SimSystem>
  private systemTools: SimSystemTool[]
  private admin: boolean
  private agents: SimAgent[]
  private triggers: SimTrigger[]
  private log: LogEntry[] = []
  private seq = 0
  private force: Workforce | null = null
  private agentFiles = new Map<string, Map<string, string>>()
  private wakeSeed: WakeSeed | null
  private autoWatch: boolean
  private schedules: SimSchedule[] = []
  private heartbeat = { enabled: false, intervalSeconds: 1800, lastAt: '' }
  private wakes: SimWake[] = []
  private horizon: Date | null = null

  constructor(seed: WorldSeed) {
    this.arm = seed.arm
    this.me = seed.me
    this.now = new Date(seed.now)
    this.people = seed.people
    this.channels = structuredClone(seed.channels)
    this.boards = structuredClone(seed.boards)
    this.admin = !!seed.admin
    this.agents = structuredClone(seed.agents ?? [])
    this.triggers = structuredClone(seed.triggers ?? [])
    this.systems = structuredClone(seed.systems ?? {})
    this.systemTools = seed.systemTools ?? []
    this.items = seed.items.map((i, n) => ({
      priority: 'none',
      fields: {},
      links: [],
      history: [],
      createdAt: seed.now,
      lastActivityAt: i.lastActivityAt ?? i.createdAt ?? seed.now,
      enteredColumnAt: i.enteredColumnAt ?? i.lastActivityAt ?? i.createdAt ?? seed.now,
      ...structuredClone(i),
      id: `item-${n + 1}`,
    }))
    this.messages = (seed.messages ?? []).map((m) => ({ ...m, id: m.id ?? this.nextId('m') }))
    if (this.arm === 'B') this.cardsToMessages()
    if (seed.workforce) this.force = new Workforce(seed.workforce, this.workforceHost())
    this.wakeSeed = seed.wakes ?? null
    this.autoWatch = seed.wakes?.policy !== 'watched'
    if (this.autoWatch) this.force?.watchRunning()
    if (seed.wakes?.heartbeat) this.heartbeat = { enabled: true, intervalSeconds: seed.wakes.heartbeat.intervalSeconds, lastAt: seed.now }
    for (const s of seed.wakes?.schedules ?? []) this.schedules.push({ ...s, id: this.nextId('sched'), createdAt: seed.now })
  }

  /** Tool names this world answers, for the arm. */
  toolNames(): string[] {
    const board = this.arm === 'B' ? [] : [...BOARD_SIM_TOOLS, ...(this.admin ? ADMIN_SIM_TOOLS : [])]
    return [
      ...board, ...CHAT_SIM_TOOLS, ...this.systemTools.map((t) => t.name),
      ...(this.force ? [...WORKFORCE_SIM_TOOLS, ...PROJECT_FILE_TOOLS] : []),
      ...(this.wakeSeed ? TIMER_SIM_TOOLS : []),
    ]
  }

  /** Board tools hidden from the agent in this arm. */
  hiddenTools(): string[] {
    return this.arm === 'B' ? [...BOARD_SIM_TOOLS] : []
  }

  /** Let simulated time pass; scripted teammates and people act on the way. */
  advance(hours: number): void {
    const target = new Date(this.now.getTime() + hours * HOUR)
    if (this.force) this.force.advanceTo(target)
    else this.now = target
  }

  snapshot(): WorldSnapshot {
    return structuredClone({
      arm: this.arm, me: this.me, now: this.now.toISOString(), boards: this.boards, items: this.items, messages: this.messages,
      channels: this.channels, agents: this.agents, triggers: this.triggers, systems: this.systems, log: this.log,
      ...(this.force ? { workforce: this.force.snapshot() } : {}),
      ...(this.wakeSeed ? { schedules: this.schedules, heartbeat: { enabled: this.heartbeat.enabled, intervalSeconds: this.heartbeat.intervalSeconds }, wakes: this.wakes } : {}),
    })
  }

  // ─── Wakes ───────────────────────────────────────────────────────────────

  /**
   * Let time pass until production would next wake the workspace agent and
   * return that wake's message, or null when nothing would (the horizon
   * passed, or the work is over and no timer would find more).
   *
   * A watched run that stops wakes it at once with a [Task update]. A
   * schedule or heartbeat firing first wakes it with its prompt, and the
   * stops it could find on the board count as seen then.
   */
  nextWake(): SimWake | null {
    if (!this.wakeSeed) return null
    this.horizon ??= new Date(this.now.getTime() + this.wakeSeed.horizonHours * HOUR)
    const f = this.force
    const heard = () => f?.stoppedUnseen().filter((r) => r.watched) ?? []
    const timer = this.nextTimer()
    const until = timer && timer.at <= this.horizon ? timer.at : this.horizon
    if (f && !heard().length) f.advanceTo(until, () => heard().length > 0)
    else if (!f) this.now = until
    const ready = heard()
    if (ready.length && f) {
      f.markSeen(ready)
      return this.pushWake('task', ready.map((r) => r.id), ready.map((r) => this.taskNote(r)).join('\n\n'))
    }
    if (!timer || timer.at > this.horizon) return null
    const openCards = this.items.some((i) => !i.archived && !this.isClosed(i))
    if (f && f.idle() && !f.stoppedUnseen().length && !openCards) return null
    this.now = timer.at
    const found = f?.stoppedUnseen() ?? []
    f?.markSeen(found)
    if (timer.kind === 'heartbeat') {
      this.heartbeat.lastAt = timer.at.toISOString()
      return this.pushWake('heartbeat', found.map((r) => r.id), '[Heartbeat] Run your HEARTBEAT.md checklist: check the boards and your handed-off work, act on anything that needs you, and reply HEARTBEAT_OK if nothing does.')
    }
    return this.pushWake('schedule', found.map((r) => r.id), `[Schedule: ${timer.schedule!.name}] ${timer.schedule!.prompt}`)
  }

  private nextTimer(): { at: Date; kind: 'schedule' | 'heartbeat'; schedule?: SimSchedule } | null {
    const limit = this.horizon ?? new Date(this.now.getTime() + 30 * 24 * HOUR)
    let best: { at: Date; kind: 'schedule' | 'heartbeat'; schedule?: SimSchedule } | null = null
    for (const s of this.schedules) {
      if (!s.enabled) continue
      const at = nextCronFire(s.cron, this.now, limit)
      if (at && (!best || at < best.at)) best = { at, kind: 'schedule', schedule: s }
    }
    if (this.heartbeat.enabled) {
      const last = Date.parse(this.heartbeat.lastAt || this.now.toISOString())
      const at = new Date(Math.max(last + this.heartbeat.intervalSeconds * 1000, this.now.getTime() + 60_000))
      if (!best || at < best.at) best = { at, kind: 'heartbeat' }
    }
    return best
  }

  /** A stopped run as the API's task note words it (formatTaskNote, with the card's event lines as output). */
  private taskNote(r: SimRun): string {
    const item = r.item ? this.items.find((i) => i.key === r.item) : undefined
    const col = item ? this.columnOf(item) : undefined
    const status = r.status === 'failed' ? 'failed' : 'completed'
    const lines = [`[Task update] ${r.title} (${r.id}) ${status}.`, 'Last output:']
    if (item && col) {
      lines.push(r.status === 'silent' ? `agent stopped with the card still in ${col.name}` : `moved to ${col.name} (${col.category})`)
    }
    if (r.lastText && r.status !== 'silent') lines.push(`${this.force!.agentName(r.agent)}: ${r.lastText}`)
    return lines.join('\n')
  }

  private pushWake(kind: SimWake['kind'], runs: string[], text: string): SimWake {
    const wake = { at: this.now.toISOString(), kind, runs, text }
    this.wakes.push(wake)
    return structuredClone(wake)
  }

  private timerCall(tool: string, p: Record<string, any>): Result {
    switch (tool) {
      case 'schedule_create': {
        if (!p.name || !p.prompt || !p.cron) return { error: 'name, prompt and cron are required', code: 'invalid' }
        if (!parseCron(String(p.cron))) return { error: `Invalid cron expression "${p.cron}"`, code: 'invalid' }
        const s: SimSchedule = { id: this.nextId('sched'), name: String(p.name), prompt: String(p.prompt), cron: String(p.cron), enabled: p.enabled !== false, createdAt: this.now.toISOString() }
        this.schedules.push(s)
        return { ok: true, schedule: { ...s, cronExpression: s.cron, nextRunAt: nextCronFire(s.cron, this.now, new Date(this.now.getTime() + 60 * 24 * HOUR))?.toISOString() ?? null } }
      }
      case 'schedule_list': return { ok: true, schedules: this.schedules.map((s) => ({ ...s, cronExpression: s.cron })) }
      case 'schedule_update': {
        const s = this.schedules.find((x) => x.id === p.scheduleId || x.name === p.scheduleId)
        if (!s) return { error: `Schedule "${p.scheduleId}" not found`, code: 'not_found' }
        if (p.cron !== undefined && !parseCron(String(p.cron))) return { error: `Invalid cron expression "${p.cron}"`, code: 'invalid' }
        if (p.name !== undefined) s.name = String(p.name)
        if (p.prompt !== undefined) s.prompt = String(p.prompt)
        if (p.cron !== undefined) s.cron = String(p.cron)
        if (p.enabled !== undefined) s.enabled = !!p.enabled
        return { ok: true, schedule: { ...s, cronExpression: s.cron } }
      }
      case 'schedule_delete': {
        const n = this.schedules.findIndex((x) => x.id === p.scheduleId || x.name === p.scheduleId)
        if (n < 0) return { error: `Schedule "${p.scheduleId}" not found`, code: 'not_found' }
        this.schedules.splice(n, 1)
        return { ok: true }
      }
      case 'heartbeat_configure': {
        if (p.interval !== undefined && Number(p.interval) < 60) return { error: 'Interval must be at least 60 seconds' }
        if (p.enabled !== undefined) this.heartbeat.enabled = !!p.enabled
        if (p.interval !== undefined) { this.heartbeat.intervalSeconds = Number(p.interval); this.heartbeat.lastAt = this.now.toISOString() }
        return { ok: true, enabled: this.heartbeat.enabled, interval: this.heartbeat.intervalSeconds }
      }
      case 'heartbeat_status': return { ok: true, enabled: this.heartbeat.enabled, interval: this.heartbeat.intervalSeconds }
    }
    return { error: `Unknown tool ${tool}`, code: 'not_found' }
  }

  private workforceHost() {
    return {
      me: this.me,
      now: () => this.now,
      setNow: (at: Date) => { this.now = at },
      agents: () => this.agents,
      addAgent: (a: SimAgent) => { this.agents.push(a) },
      people: () => this.people,
      items: () => this.items,
      boardOf: (i: SimItem) => this.boardOf(i),
      categoryOf: (i: SimItem) => this.columnOf(i).category,
      moveTo: (i: SimItem, category: Category, author: string, prefer?: RegExp) => {
        const cols = this.boardOf(i).columns.filter((c) => c.category === category)
        const col = (prefer && cols.find((c) => prefer.test(c.name))) || cols[0]
        if (!col || col.name === i.column) return
        const from = i.column
        i.column = col.name
        i.enteredColumnAt = this.now.toISOString()
        this.record(i, 'moved', `moved from ${from} to ${col.name}`, undefined, author)
      },
      comment: (i: SimItem, author: string, text: string) => this.record(i, 'comment', text, undefined, author),
      post: (m: Omit<SimMessage, 'id' | 'at'>) => {
        const msg: SimMessage = { ...m, id: this.nextId('m'), at: this.now.toISOString() }
        this.messages.push(msg)
        return msg
      },
    }
  }

  /** Answer a handoff with the card's run, the way production returns a task per card. */
  private withTask(i: SimItem, base: { ok: true; [k: string]: unknown }): Result {
    const run = this.force?.runFor(i)
    return run ? { ...base, task_id: run.id, ...(run.watched && run.status === 'running' ? { watching: true } : {}) } : base
  }

  /** Hand a card to its agent, if it has one the workforce knows. Board handoffs are watched when the platform watches them. */
  private handOff(i: SimItem, agentRef: unknown, watched = this.autoWatch): SimRun | null {
    if (!this.force || !agentRef || this.force.isWorkspaceRef(agentRef)) return null
    const run = this.force.handOff(i, agentRef)
    if (run && watched) run.watched = true
    return run
  }

  /** Cards named by key in a text (and the explicit `card` param). */
  private cardsIn(text: string, card?: unknown): SimItem[] {
    const keys = new Set([...text.matchAll(/\b([A-Z][A-Z0-9]{1,5})-(\d{1,6})\b/g)].map((m) => `${m[1]}-${m[2]}`))
    if (card) keys.add(String(card).toUpperCase())
    return [...keys].map((k) => this.items.find((i) => i.key === k)).filter((i): i is SimItem => !!i)
  }

  /**
   * A message the workspace agent wrote: wake tagged agents and schedule
   * answers from tagged people. A tag hands an agent the cards it names that
   * are unassigned or already its own; naming another agent's card in a post
   * does not take it away. Tagging an agent in a card's own thread (a
   * comment) hands it that card.
   */
  private routeMessage(msg: SimMessage, opts: { card?: unknown; onlyCard?: SimItem } = {}): SimRun[] {
    if (!this.force) return []
    const f = this.force
    const where = { channel: msg.channel, threadId: msg.threadId || msg.id || undefined }
    for (const person of f.taggedPeople(msg.text)) f.addressed(person, msg.text, where)
    const runs: SimRun[] = []
    const thread = msg.threadId ? this.messages.find((m) => m.id === msg.threadId) : undefined
    const cards = opts.onlyCard ? [opts.onlyCard] : this.cardsIn(`${msg.text}\n${thread?.text ?? ''}`, opts.card)
    for (const agent of f.taggedAgents(msg.text)) {
      const mine = cards
        .filter((c) => opts.onlyCard || !c.assigneeAgent || c.assigneeAgent === agent.key || f.isWorkspaceRef(c.assigneeAgent))
        .map((c) => {
          if (c.assigneeAgent !== agent.key) { c.assigneeAgent = agent.key; c.assigneeUser = null; this.record(c, 'assigned', `assigned to ${agent.name}`) }
          return this.handOff(c, agent.key, true)
        })
        .filter((r): r is SimRun => !!r)
      runs.push(...(mine.length ? mine : [f.wake(agent.key, where)].filter((r): r is SimRun => !!r)))
    }
    return runs
  }

  handle(tool: string, raw: Record<string, unknown> | undefined): Result {
    const params = (raw ?? {}) as Record<string, any>
    let result: Result
    try {
      result = this.dispatch(tool, params)
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    }
    if ((result as { passthrough?: boolean }).passthrough) return result
    this.log.push({ at: this.now.toISOString(), tool, params, ok: !('error' in result), ...('error' in result ? { error: String(result.error) } : {}) })
    return result
  }

  // ─── Dispatch ────────────────────────────────────────────────────────────

  private dispatch(tool: string, p: Record<string, any>): Result {
    if ((BOARD_SIM_TOOLS as readonly string[]).includes(tool) && this.arm === 'B') {
      return { error: `Unknown tool ${tool}`, code: 'not_found' }
    }
    switch (tool) {
      case 'board_list': return { ok: true, boards: this.boards.filter((b) => (!p.channel || sameChannel(b.channel, p.channel)) && (p.include_archived || !b.archived)).map((b) => this.compactBoard(b)) }
      case 'board_create': return this.boardCreate(p)
      case 'board_update': return this.boardUpdate(p)
      case 'board_archive': return this.boardArchive(p)
      case 'column_create': return this.columnCreate(p)
      case 'column_update': return this.columnUpdate(p)
      case 'column_delete': return this.columnDelete(p)
      case 'board_summary': return this.boardSummary(p)
      case 'board_health': return this.boardHealth(p)
      case 'work_item_list': return this.itemList(p)
      case 'work_item_get': return this.itemGet(p)
      case 'work_item_create': return this.itemCreate(p)
      case 'work_item_update': return this.itemUpdate(p)
      case 'work_item_move': return this.itemMove(p)
      case 'work_item_comment': return this.itemComment(p)
      case 'work_item_bulk_update': return this.itemBulk(p)
      case 'work_item_history': return this.itemHistory(p)
      case 'work_item_link': return this.itemLink(p)
      case 'team_chat_list': return { ok: true, channels: this.channels.map((c) => ({ name: c.name, private: !!c.private, topic: c.topic ?? null })) }
      case 'team_chat_read': return this.chatRead(p)
      case 'team_chat_post': return this.chatPost(p)
      case 'team_chat_search': return this.chatSearch(p)
      case 'team_chat_dm': return this.chatDm(p)
      case 'team_directory': return {
        ok: true,
        people: this.people.map(({ id, name, email, role, title, timezone, away }) => ({ id, name, email, role, title, timezone, ...(away ? { status: 'away' } : {}) })),
        ...(this.force ? { agents: this.agents.map((a) => ({ key: a.key, name: a.name, tag: `@${a.name}` })) } : {}),
      }
    }
    if (this.force && (WORKFORCE_SIM_TOOLS as readonly string[]).includes(tool)) return this.workforceCall(tool, p)
    if (this.force && (PROJECT_FILE_TOOLS as readonly string[]).includes(tool)) return this.projectFileCall(tool, p)
    if (this.wakeSeed && (TIMER_SIM_TOOLS as readonly string[]).includes(tool)) return this.timerCall(tool, p)
    const sys = this.systemTools.find((t) => t.name === tool)
    if (sys) return this.systemCall(sys, p)
    return { error: `Unknown tool ${tool}`, code: 'not_found' }
  }

  /** wait / task_list fall through to the real tools (`passthrough`) when no simulated agent is running. */
  private workforceCall(tool: string, p: Record<string, any>): Result {
    const f = this.force!
    switch (tool) {
      case 'wait': {
        const out = this.wakeSeed ? f.wait(p, waitCapHours(p.timeout_ms)) : f.wait(p)
        return out ? { ok: true, ...out } : { ok: true, passthrough: true }
      }
      case 'task_list': return f.hasRuns() ? { ok: true, ...f.taskList() } : { ok: true, passthrough: true }
      case 'project_create': return asResult(f.projectCreate(p))
      case 'project_call': {
        const out = f.projectCall(p, (text) => this.cardsIn(text))
        if ('error' in out || p.wait === false) return asResult(out)
        const ids = out.task_ids as string[]
        f.wait({ task_ids: ids })
        return { ok: true, ...out, status: 'completed', tasks: (f.taskList().tasks as Array<{ task_id: string }>).filter((t) => ids.includes(t.task_id)) }
      }
    }
    return { error: `Unknown tool ${tool}`, code: 'not_found' }
  }

  /**
   * File tools with `project` set run in that project's runtime; for a
   * simulated agent the world keeps its files. Without `project` they are
   * the real tools (`passthrough`).
   */
  private projectFileCall(tool: string, p: Record<string, any>): Result {
    if (p.project === undefined || p.project === null) return { ok: true, passthrough: true }
    const ref = String(p.project)
    const agent = this.agents.find((a) => [a.key, a.name, `proj-${a.key}`].some((n) => n.toLowerCase() === ref.toLowerCase()))
    if (!agent) return { error: `No project "${ref}" in this workspace. Projects: ${this.agents.map((a) => a.key).join(', ') || 'none'}`, code: 'not_found' }
    const path = String(p.path ?? p.file_path ?? '').replace(/^\.?\//, '')
    if (!path) return { error: 'path is required', code: 'invalid' }
    const files = this.agentFiles.get(agent.key) ?? new Map<string, string>()
    this.agentFiles.set(agent.key, files)
    const current = files.get(path)
    if (tool === 'read_file') {
      return current === undefined ? { error: `File not found: ${path}`, code: 'not_found' } : { ok: true, content: current, bytes: current.length }
    }
    let next: string
    if (tool === 'write_file') next = String(p.content ?? '')
    else {
      if (current === undefined) return { error: `File not found: ${path}`, code: 'not_found' }
      const old = String(p.old_string ?? '')
      if (!old || !current.includes(old)) return { error: 'old_string not found in file', code: 'not_found' }
      next = p.replace_all ? current.split(old).join(String(p.new_string ?? '')) : current.replace(old, String(p.new_string ?? ''))
    }
    files.set(path, next)
    if (!agent.files.includes(path)) agent.files.push(path)
    return { ok: true, path, bytes: next.length, project: agent.key }
  }

  // ─── Boards ──────────────────────────────────────────────────────────────

  private compactBoard(b: SimBoard) {
    return {
      id: b.id, name: b.name, channel: b.channel, item_type: b.itemType, key_prefix: b.keyPrefix,
      requires_human_review: !!b.requiresHumanReview, ...(b.archived ? { archived: true } : {}),
      cards: this.items.filter((i) => i.board === b.id && !i.archived && !this.isClosed(i)).length,
      columns: b.columns.map((c) => ({ name: c.name, category: c.category, ...(c.slaHours ? { sla_hours: c.slaHours } : {}), ...(c.wipLimit ? { wip_limit: c.wipLimit } : {}), ...(c.agent ? { agent: c.agent } : {}) })),
      ...(b.fields?.length ? { fields: b.fields } : {}),
    }
  }

  private findBoard(ref: unknown, channel?: unknown): SimBoard {
    const r = String(ref ?? '').replace(/^#/, '').toLowerCase()
    const matches = this.boards.filter((b) => !b.archived && (b.id.toLowerCase() === r || b.name.toLowerCase() === r || slug(b.name) === r) && (!channel || sameChannel(b.channel, channel)))
    if (!matches.length) throw new Error(`Board "${ref}" not found`)
    if (matches.length > 1) throw new Error(`Board "${ref}" is ambiguous; pass channel`)
    return matches[0]
  }

  private boardOf(item: SimItem): SimBoard {
    return this.boards.find((b) => b.id === item.board)!
  }

  private columnOf(item: SimItem): SimColumn {
    return this.boardOf(item).columns.find((c) => c.name === item.column)!
  }

  private isClosed(item: SimItem): boolean {
    return CLOSED.includes(this.columnOf(item).category)
  }

  private findColumn(board: SimBoard, ref: unknown): SimColumn {
    const r = String(ref ?? '').toLowerCase()
    const col = board.columns.find((c) => c.name.toLowerCase() === r) ?? board.columns.find((c) => c.category === r)
    if (!col) throw new Error(`Column "${ref}" is not on ${board.name}. Columns: ${board.columns.map((c) => c.name).join(', ')}`)
    return col
  }

  private findItem(ref: unknown): SimItem {
    const r = String(ref ?? '').trim()
    const item = this.items.find((i) => i.id === r || i.key.toLowerCase() === r.toLowerCase())
    if (!item) throw new Error(`Card "${ref}" not found`)
    return item
  }

  private boardSummary(p: Record<string, any>): Result {
    const board = this.findBoard(p.board, p.channel)
    const days = Number(p.days) || 7
    const since = this.now.getTime() - days * 24 * HOUR
    const items = this.items.filter((i) => i.board === board.id && !i.archived)
    const perColumn = Object.fromEntries(board.columns.map((c) => [c.name, items.filter((i) => i.column === c.name).length]))
    const byAssignee: Record<string, number> = {}
    for (const i of items) {
      if (this.isClosed(i)) continue
      const who = this.assigneeName(i) ?? 'unassigned'
      byAssignee[who] = (byAssignee[who] ?? 0) + 1
    }
    const created = items.filter((i) => Date.parse(i.createdAt) >= since).length
    const finished = items.filter((i) => this.isClosed(i) && Date.parse(i.enteredColumnAt) >= since).length
    return { ok: true, board: board.name, days, columns: perColumn, open_by_assignee: byAssignee, created, finished }
  }

  private boardHealth(p: Record<string, any>): Result {
    const staleHours = Number(p.stale_hours) || 72
    const boards = this.boards.filter((b) => (!p.channel || sameChannel(b.channel, p.channel)) && (!p.board || b.name.toLowerCase() === String(p.board).toLowerCase() || b.id === p.board))
    const issues: Array<{ kind: string; key: string; title: string; board: string; column: string; assignee: string | null; detail: string }> = []
    for (const b of boards) {
      for (const i of this.items.filter((x) => x.board === b.id && !x.archived && !this.isClosed(x))) {
        const col = this.columnOf(i)
        const base = { key: i.key, title: i.title, board: b.name, column: i.column, assignee: this.assigneeName(i) }
        const inColumn = (this.now.getTime() - Date.parse(i.enteredColumnAt)) / HOUR
        const idle = (this.now.getTime() - Date.parse(i.lastActivityAt)) / HOUR
        if (col.slaHours && inColumn > col.slaHours) issues.push({ kind: 'sla_breach', ...base, detail: `${Math.round(inColumn)}h in ${col.name} (SLA ${col.slaHours}h)` })
        else if (col.slaHours && inColumn > col.slaHours * 0.8) issues.push({ kind: 'sla_at_risk', ...base, detail: `${Math.round(col.slaHours - inColumn)}h left of ${col.slaHours}h SLA` })
        if (idle > staleHours) issues.push({ kind: 'stale', ...base, detail: `no activity for ${Math.round(idle)}h` })
        if (!i.assigneeUser && !i.assigneeAgent && col.category === 'active') issues.push({ kind: 'unassigned', ...base, detail: 'active with no owner' })
        if (i.dueAt && Date.parse(i.dueAt) < this.now.getTime()) issues.push({ kind: 'overdue', ...base, detail: `due ${i.dueAt}` })
        if (i.column.toLowerCase() === 'needs attention') issues.push({ kind: 'needs_attention', ...base, detail: 'an agent run failed on it' })
      }
      for (const c of b.columns) {
        const n = this.items.filter((x) => x.board === b.id && x.column === c.name && !x.archived).length
        if (c.wipLimit && n > c.wipLimit) issues.push({ kind: 'wip_exceeded', key: '', title: '', board: b.name, column: c.name, assignee: null, detail: `${n} cards, limit ${c.wipLimit}` })
      }
    }
    return { ok: true, issues, checked_boards: boards.map((b) => `#${b.channel} ${b.name}`) }
  }

  private compactItem(i: SimItem) {
    const col = this.columnOf(i)
    return {
      key: i.key, id: i.id, title: i.title, board: this.boardOf(i).name, channel: this.boardOf(i).channel,
      column: i.column, category: col.category, priority: i.priority,
      assignee_user: i.assigneeUser ?? null, assignee_agent: i.assigneeAgent ?? null,
      due_at: i.dueAt ?? null, ...(Object.keys(i.fields).length ? { fields: i.fields } : {}),
      last_activity_at: i.lastActivityAt,
    }
  }

  private itemList(p: Record<string, any>): Result {
    let list = this.items.filter((i) => !i.archived)
    if (p.channel) list = list.filter((i) => sameChannel(this.boardOf(i).channel, p.channel))
    if (p.board) { const b = this.findBoard(p.board, p.channel); list = list.filter((i) => i.board === b.id) }
    if (!p.include_closed) list = list.filter((i) => !this.isClosed(i))
    if (p.assignee) {
      const a = String(p.assignee)
      list = list.filter((i) => a === 'none' ? !i.assigneeUser && !i.assigneeAgent : a === 'me' ? i.assigneeAgent === this.me : i.assigneeUser === a || i.assigneeAgent === a || this.assigneeName(i)?.toLowerCase() === a.toLowerCase())
    }
    const cats = asList(p.category)
    if (cats.length) list = list.filter((i) => cats.includes(this.columnOf(i).category))
    const pris = asList(p.priority)
    if (pris.length) list = list.filter((i) => pris.includes(i.priority))
    if (p.q) { const q = String(p.q).toLowerCase(); list = list.filter((i) => i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q)) }
    const rank = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }
    list.sort((a, b) => rank[a.priority] - rank[b.priority] || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    return { ok: true, items: list.slice(0, Number(p.limit) || 50).map((i) => this.compactItem(i)) }
  }

  private itemGet(p: Record<string, any>): Result {
    const i = this.findItem(p.item)
    const base = { ...this.compactItem(i), description: i.description ?? '', external_ref: i.externalRef ?? null, columns: this.boardOf(i).columns.map((c) => c.name) }
    if (this.arm === 'C') return { ok: true, item: base, history_summary: null, recent: [], links: [] }
    return {
      ok: true,
      item: base,
      history_summary: i.historySummary ?? null,
      recent: i.history.slice(-15).map((e) => ({ at: e.at, author: e.author, kind: e.kind, text: e.text })),
      links: i.links.map((l) => ({ kind: l.kind, ref: l.ref, ...(l.snippet ? { snippet: l.snippet } : {}), ...(l.channel ? { channel: l.channel } : {}) })),
    }
  }

  private itemHistory(p: Record<string, any>): Result {
    const i = this.findItem(p.item)
    if (this.arm === 'C') return { ok: true, entries: [] }
    const filter = String(p.filter ?? 'all')
    const kinds: Record<string, SimEvent['kind'][]> = { comments: ['comment'], status: ['moved', 'assigned', 'created', 'updated'], agent: ['agent_run'], links: ['linked'] }
    const entries = i.history.filter((e) => filter === 'all' || kinds[filter]?.includes(e.kind)).slice().reverse().slice(0, Number(p.limit) || 50)
    return { ok: true, entries }
  }

  private itemCreate(p: Record<string, any>): Result {
    const board = this.findBoard(p.board, p.channel)
    if (!p.title) throw new Error('title is required')
    const col = p.column ? this.findColumn(board, p.column) : board.columns.find((c) => c.category === 'backlog') ?? board.columns[0]
    const n = this.items.filter((i) => i.key.startsWith(`${board.keyPrefix}-`)).reduce((m, i) => Math.max(m, Number(i.key.split('-')[1]) || 0), 0) + 1
    const at = this.now.toISOString()
    const item: SimItem = {
      id: this.nextId('item'), key: `${board.keyPrefix}-${n}`, board: board.id, column: col.name, title: String(p.title),
      description: p.description, priority: p.priority ?? 'none', assigneeUser: p.assignee_user ?? null, assigneeAgent: p.assignee_agent ?? null,
      fields: (p.fields && typeof p.fields === 'object') ? p.fields : {}, createdAt: at, lastActivityAt: at, enteredColumnAt: at,
      dueAt: p.due_at ?? null, externalRef: p.external_ref ?? null, links: [], history: [{ at, author: this.me, kind: 'created', text: `created in ${col.name}` }],
    }
    if (p.from_message) {
      const m = this.messages.find((x) => x.id === p.from_message)
      if (m) item.links.push({ kind: 'message', ref: m.id, snippet: m.text.slice(0, 120), channel: m.channel })
    }
    if (this.force) {
      item.assigneeAgent = this.agentKey(p.assignee_agent) ?? null
      if (!item.assigneeAgent && !item.assigneeUser && board.defaultAgent && !this.force.isWorkspaceRef(board.defaultAgent)) item.assigneeAgent = this.agentKey(board.defaultAgent) ?? null
    }
    this.items.push(item)
    this.handOff(item, item.assigneeAgent)
    return this.withTask(item, { ok: true, item: this.compactItem(item) })
  }

  /** With a workforce, an agent ref must name an agent in the workspace; returns its key. */
  private agentKey(ref: unknown): string | null | undefined {
    if (ref === undefined || ref === null || ref === '') return ref as null | undefined
    if (!this.force || this.force.isWorkspaceRef(ref)) return String(ref)
    const agent = this.force.findAgent(ref)
    if (!agent) throw new Error(`No agent "${ref}" in this workspace. Agents: ${this.agents.map((a) => a.key).join(', ') || 'none yet'}`)
    return agent.key
  }

  private itemUpdate(p: Record<string, any>): Result {
    const i = this.findItem(p.item)
    const changes: string[] = []
    for (const k of ['title', 'description', 'priority'] as const) {
      if (p[k] !== undefined && p[k] !== i[k]) { (i as any)[k] = p[k]; changes.push(k) }
    }
    if (p.due_at !== undefined) { i.dueAt = p.due_at; changes.push('due date') }
    if (p.external_ref !== undefined) i.externalRef = p.external_ref
    if (p.fields && typeof p.fields === 'object') {
      for (const [k, v] of Object.entries(p.fields)) { if (v === null) delete i.fields[k]; else i.fields[k] = v }
      changes.push(`fields ${Object.keys(p.fields).join(', ')}`)
    }
    if (p.assignee_user !== undefined || p.assignee_agent !== undefined) this.assign(i, p)
    if (p.history_summary !== undefined) i.historySummary = p.history_summary
    if (changes.length) this.record(i, 'updated', `changed ${changes.join(', ')}`)
    else this.touch(i)
    return this.withTask(i, { ok: true, item: this.compactItem(i) })
  }

  private assign(i: SimItem, p: Record<string, any>) {
    if (p.assignee_user !== undefined) {
      if (p.assignee_user && !this.people.some((x) => x.id === p.assignee_user || x.email === p.assignee_user)) throw new Error(`No person "${p.assignee_user}" in the directory`)
      const person = this.people.find((x) => x.id === p.assignee_user || x.email === p.assignee_user)
      i.assigneeUser = person?.id ?? null
      if (p.assignee_agent === undefined && person) i.assigneeAgent = null
    }
    if (p.assignee_agent !== undefined) { i.assigneeAgent = this.agentKey(p.assignee_agent) ?? null; if (p.assignee_agent && p.assignee_user === undefined) i.assigneeUser = null }
    this.record(i, 'assigned', `assigned to ${this.assigneeName(i) ?? 'nobody'}`)
    if (p.assignee_agent) this.handOff(i, i.assigneeAgent)
  }

  private itemMove(p: Record<string, any>): Result {
    const i = this.findItem(p.item)
    const board = p.board ? this.findBoard(p.board) : this.boardOf(i)
    const col = this.findColumn(board, p.column)
    if (board.requiresHumanReview && col.category === 'done') {
      throw new Error(`${board.name} requires human review: move the card to a review column and a person will close it`)
    }
    const from = `${this.boardOf(i).name}/${i.column}`
    const crossBoard = board.id !== i.board
    i.board = board.id
    i.column = col.name
    i.enteredColumnAt = this.now.toISOString()
    this.record(i, 'moved', `moved from ${from} to ${board.name}/${col.name}`, { from, to: `${board.name}/${col.name}`, crossBoard })
    if (col.agent && this.force && !this.force.isWorkspaceRef(col.agent)) {
      i.assigneeAgent = this.agentKey(col.agent) ?? null
      i.assigneeUser = null
      this.handOff(i, i.assigneeAgent)
    }
    return this.withTask(i, { ok: true, item: this.compactItem(i), warnings: [] })
  }

  private itemComment(p: Record<string, any>): Result {
    const i = this.findItem(p.item)
    if (!p.text) throw new Error('text is required')
    this.record(i, 'comment', String(p.text))
    const runs = this.force ? this.routeMessage({ id: '', channel: this.boardOf(i).channel, author: this.me, text: String(p.text), at: this.now.toISOString() }, { onlyCard: i }) : []
    return { ok: true, posted: true, ...taskFields(runs) }
  }

  private itemBulk(p: Record<string, any>): Result {
    const ids = asList(p.items)
    const failed: Array<{ item: string; error: string }> = []
    let updated = 0
    for (const ref of ids) {
      try {
        const i = this.findItem(ref)
        if (p.column) this.itemMove({ item: ref, column: p.column })
        if (p.priority) { i.priority = p.priority; this.record(i, 'updated', `priority ${p.priority}`) }
        if (p.assignee_user !== undefined || p.assignee_agent !== undefined) this.assign(i, p)
        if (p.archived !== undefined) { i.archived = !!p.archived; this.record(i, 'updated', p.archived ? 'archived' : 'restored') }
        updated++
      } catch (err) {
        failed.push({ item: ref, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { ok: true, updated, failed }
  }

  private itemLink(p: Record<string, any>): Result {
    const i = this.findItem(p.item)
    i.links.push({ kind: String(p.kind), ref: String(p.ref_id), snippet: p.snippet })
    this.record(i, 'linked', `linked ${p.kind} ${p.ref_id}`)
    return { ok: true }
  }

  // ─── Board admin ─────────────────────────────────────────────────────────

  private boardCreate(p: Record<string, any>): Result {
    let args: Record<string, any> = p
    if (p.template) {
      try { args = { ...boardTemplateArgs(String(p.template)), ...definedOnly(p) } } catch { return { error: `Unknown template "${p.template}"`, code: 'unknown_template' } }
    }
    if (!args.channel || !args.name) return { error: 'channel and name are required', code: 'invalid' }
    const ch = this.findChannel(args.channel)
    if (this.boards.some((b) => !b.archived && b.channel === ch.name && b.name.toLowerCase() === String(args.name).toLowerCase())) {
      return { error: `#${ch.name} already has a board named "${args.name}"`, code: 'conflict' }
    }
    const itemType = String(args.item_type ?? 'task')
    const columns = Array.isArray(args.columns) && args.columns.length
      ? args.columns.map((c: any) => ({ name: String(c.name), category: (c.category ?? 'active') as Category, ...(c.sla_hours ? { slaHours: Number(c.sla_hours) } : {}), ...(c.wip_limit ? { wipLimit: Number(c.wip_limit) } : {}), ...(c.agent ? { agent: String(c.agent) } : {}) }))
      : (DEFAULT_COLUMNS[itemType] ?? DEFAULT_COLUMNS.task).map((c) => ({ ...c }))
    const board: SimBoard = {
      id: `${ch.name}-${slug(String(args.name))}`,
      name: String(args.name),
      channel: ch.name,
      itemType,
      keyPrefix: normalizePrefix(args.key_prefix) ?? keyPrefixFor(String(args.name)),
      columns,
      ...(args.requires_human_review ? { requiresHumanReview: true } : {}),
      ...(Array.isArray(args.fields) && args.fields.length ? { fields: args.fields } : {}),
      ...(args.description ? { description: String(args.description) } : {}),
      ...(args.post_to_channel ? { postToChannel: String(args.post_to_channel) } : {}),
      ...(args.default_agent ? { defaultAgent: String(args.default_agent) } : {}),
    }
    this.boards.push(board)
    return { ok: true, board: this.compactBoard(board) }
  }

  private boardUpdate(p: Record<string, any>): Result {
    const b = this.findBoard(p.board, p.channel)
    if (p.name !== undefined) b.name = String(p.name)
    if (p.description !== undefined) b.description = String(p.description)
    if (p.requires_human_review !== undefined) b.requiresHumanReview = !!p.requires_human_review
    if (p.key_prefix !== undefined) b.keyPrefix = normalizePrefix(p.key_prefix) ?? b.keyPrefix
    if (Array.isArray(p.fields)) b.fields = p.fields
    if (p.post_to_channel !== undefined) b.postToChannel = String(p.post_to_channel)
    if (p.default_agent !== undefined) b.defaultAgent = p.default_agent ? String(p.default_agent) : undefined
    if (p.move_to_channel) b.channel = this.findChannel(p.move_to_channel).name
    return { ok: true, board: this.compactBoard(b) }
  }

  private boardArchive(p: Record<string, any>): Result {
    const r = String(p.board ?? '').toLowerCase()
    const b = this.boards.find((x) => (x.id.toLowerCase() === r || x.name.toLowerCase() === r) && (!p.channel || sameChannel(x.channel, p.channel)))
    if (!b) throw new Error(`Board "${p.board}" not found`)
    b.archived = !p.restore
    return { ok: true, board: this.compactBoard(b) }
  }

  private columnCreate(p: Record<string, any>): Result {
    const b = this.findBoard(p.board, p.channel)
    if (!p.name) return { error: 'name is required', code: 'invalid' }
    if (b.columns.some((c) => c.name.toLowerCase() === String(p.name).toLowerCase())) return { error: `${b.name} already has a column "${p.name}"`, code: 'conflict' }
    const col: SimColumn = { name: String(p.name), category: (p.category ?? 'active') as Category, ...(p.sla_hours ? { slaHours: Number(p.sla_hours) } : {}), ...(p.wip_limit ? { wipLimit: Number(p.wip_limit) } : {}), ...(p.agent ? { agent: String(p.agent) } : {}) }
    b.columns.splice(this.insertIndex(b, p.after, p.before), 0, col)
    return { ok: true, board: this.compactBoard(b) }
  }

  private columnUpdate(p: Record<string, any>): Result {
    const b = this.findBoard(p.board, p.channel)
    const col = this.findColumn(b, p.column)
    if (p.name && p.name !== col.name) {
      for (const i of this.items.filter((x) => x.board === b.id && x.column === col.name)) i.column = String(p.name)
      col.name = String(p.name)
    }
    if (p.category) col.category = p.category
    if (p.sla_hours !== undefined) { if (p.sla_hours) col.slaHours = Number(p.sla_hours); else delete col.slaHours }
    if (p.wip_limit !== undefined) { if (p.wip_limit) col.wipLimit = Number(p.wip_limit); else delete col.wipLimit }
    if (p.agent !== undefined) { if (p.agent) col.agent = String(p.agent); else delete col.agent }
    if (p.after !== undefined) {
      b.columns.splice(b.columns.indexOf(col), 1)
      b.columns.splice(this.insertIndex(b, p.after), 0, col)
    }
    return { ok: true, board: this.compactBoard(b) }
  }

  private columnDelete(p: Record<string, any>): Result {
    const b = this.findBoard(p.board, p.channel)
    const col = this.findColumn(b, p.column)
    const cards = this.items.filter((x) => x.board === b.id && x.column === col.name && !x.archived)
    if (cards.length && !p.move_to) return { error: `${col.name} has ${cards.length} cards; pass move_to with the column they should go to`, code: 'not_empty' }
    if (b.columns.length === 1) return { error: 'A board needs at least one column', code: 'invalid' }
    const to = p.move_to ? this.findColumn(b, p.move_to) : null
    for (const i of cards) { i.column = to!.name; this.record(i, 'moved', `moved to ${to!.name} (column ${col.name} deleted)`) }
    b.columns.splice(b.columns.indexOf(col), 1)
    return { ok: true, board: this.compactBoard(b), moved: cards.length }
  }

  private liveBoards(): LiveBoard[] {
    return this.boards.map((b) => ({
      id: b.id, name: b.name, channelName: b.channel, itemType: b.itemType, keyPrefix: b.keyPrefix, description: b.description ?? null,
      fieldsSchema: b.fields ?? [], postToChannel: b.postToChannel ?? 'all', requiresHumanReview: !!b.requiresHumanReview, defaultAssigneeAgentRef: agentRef(b.defaultAgent),
      archivedAt: b.archived ? this.now.toISOString() : null,
      columns: b.columns.map((c, i) => ({ id: `${b.id}-${i}`, name: c.name, position: i, category: c.category, wipLimit: c.wipLimit ?? null, agentRef: agentRef(c.agent), slaHours: c.slaHours ?? null })),
    }))
  }

  private insertIndex(b: SimBoard, after?: unknown, before?: unknown): number {
    if (after) return b.columns.indexOf(this.findColumn(b, after)) + 1
    if (before) return b.columns.indexOf(this.findColumn(b, before))
    const firstClosed = b.columns.findIndex((c) => CLOSED.includes(c.category))
    return firstClosed === -1 ? b.columns.length : firstClosed
  }

  /**
   * What system_apply would do with a parsed manifest: create missing
   * channels, boards and agents, update channel settings and agent
   * capabilities, and replace triggers. Applies unless `dryRun`.
   */
  applyManifest(m: SystemManifest, dryRun: boolean): Record<string, unknown> {
    const plan = { channels: [] as string[], boards: [] as string[], agents: [] as string[], triggers: [] as string[], unchanged: [] as string[] }
    for (const ch of m.teamChannels) {
      const live = this.channels.find((c) => c.name === ch.name)
      if (!live) {
        plan.channels.push(`create #${ch.name}${ch.private ? ' (private)' : ''}`)
        if (!dryRun) this.channels.push({ name: ch.name, private: ch.private, ...(ch.topic ? { topic: ch.topic } : {}), members: ch.members.map(memberRef) })
      } else {
        const changes: string[] = []
        if (!!live.private !== ch.private) changes.push(ch.private ? 'make private' : 'make public')
        if (ch.topic !== undefined && live.topic !== ch.topic) changes.push('topic')
        const add = ch.members.map(memberRef).filter((r) => !(live.members ?? []).includes(r))
        if (add.length) changes.push(`add ${add.join(', ')}`)
        if (changes.length) {
          plan.channels.push(`update #${ch.name}: ${changes.join(', ')}`)
          if (!dryRun) { live.private = ch.private; if (ch.topic !== undefined) live.topic = ch.topic; live.members = [...(live.members ?? []), ...add] }
        } else plan.unchanged.push(`#${ch.name}`)
      }
    }
    const bindings = Object.fromEntries([...this.agents.map((a) => a.key), ...m.projects.map((pr) => pr.key)].map((k) => [k, k]))
    for (const op of diffBoards(m, this.liveBoards(), [], bindings)) {
      plan.boards.push(`${op.action} #${op.channel} ${op.name}${op.changes.length ? `: ${op.changes.join(', ')}` : ''}`)
      if (dryRun) continue
      if (!this.channels.some((c) => c.name === op.channel)) this.channels.push({ name: op.channel })
      if (op.action === 'create') {
        this.boardCreate({ channel: op.channel, name: op.name, ...op.values })
        continue
      }
      const b = this.boards.find((x) => x.id === op.boardId)!
      b.archived = false
      this.boardUpdate({ board: b.id, ...op.values })
      for (const c of op.columns) {
        if (c.action === 'create') this.columnCreate({ board: b.id, name: c.column, ...c.values, ...(c.after ? { after: c.after } : {}) })
        else this.columnUpdate({ board: b.id, column: c.column, ...c.values, ...(c.after ? { after: c.after } : {}) })
      }
    }
    for (const pr of m.projects) {
      const live = this.agents.find((a) => a.key === pr.key)
      const caps = pr.agent?.capabilities ?? {}
      if (!live) {
        plan.agents.push(`create ${pr.key}`)
        if (!dryRun) this.agents.push({ key: pr.key, name: pr.name, capabilities: { ...caps }, ...(pr.agent?.heartbeat?.interval ? { heartbeatInterval: pr.agent.heartbeat.interval } : {}), files: Object.keys(pr.files) })
      } else {
        const changed = Object.entries(caps).filter(([k, v]) => live.capabilities[k] !== v)
        if (changed.length) {
          plan.agents.push(`configure ${pr.key}: ${changed.map(([k, v]) => `${k}=${v}`).join(', ')}`)
          if (!dryRun) Object.assign(live.capabilities, caps)
        } else plan.unchanged.push(pr.key)
      }
    }
    const declared = new Set(m.triggers.map((t) => t.key))
    for (const t of m.triggers) {
      const live = this.triggers.find((x) => x.key === t.key)
      if (live && JSON.stringify({ e: live.event, c: live.card }) === JSON.stringify({ e: t.event, c: t.card })) { plan.unchanged.push(`trigger ${t.key}`); continue }
      plan.triggers.push(`${live ? 'update' : 'create'} trigger ${t.key} (${t.event} -> ${t.target})`)
      if (!dryRun) {
        this.triggers = this.triggers.filter((x) => x.key !== t.key)
        this.triggers.push({ key: t.key, name: t.name, event: t.event, target: t.target, ...(t.card ? { card: t.card as Record<string, unknown> } : {}), enabled: t.enabled })
      }
    }
    for (const t of this.triggers.filter((x) => !declared.has(x.key))) {
      plan.triggers.push(`delete trigger ${t.key}`)
    }
    if (!dryRun) this.triggers = this.triggers.filter((x) => declared.has(x.key))
    const empty = !plan.channels.length && !plan.boards.length && !plan.agents.length && !plan.triggers.length
    this.log.push({ at: this.now.toISOString(), tool: 'system_apply', params: { dryRun }, ok: true })
    return { ok: true, dryRun, plan, empty }
  }

  private record(i: SimItem, kind: SimEvent['kind'], text: string, data?: Record<string, unknown>, author = this.me) {
    i.history.push({ at: this.now.toISOString(), author, kind, text, ...(data ? { data } : {}) })
    this.touch(i)
  }

  private touch(i: SimItem) {
    i.lastActivityAt = this.now.toISOString()
  }

  private assigneeName(i: SimItem): string | null {
    if (i.assigneeUser) return this.people.find((p) => p.id === i.assigneeUser)?.name ?? i.assigneeUser
    return i.assigneeAgent ?? null
  }

  // ─── Team chat ───────────────────────────────────────────────────────────

  private chatRead(p: Record<string, any>): Result {
    const ch = this.findChannel(p.channel)
    const limit = Math.min(Number(p.limit) || 30, 100)
    const msgs = this.messages.filter((m) => m.channel === ch.name && (p.thread_id ? m.id === p.thread_id || m.threadId === p.thread_id : !m.threadId))
    return {
      ok: true,
      channel: ch.name,
      messages: msgs.slice(-limit).map((m) => ({ id: m.id, author: m.author, text: m.text, at: m.at, ...(p.thread_id ? {} : { replies: this.messages.filter((r) => r.threadId === m.id).length }) })),
    }
  }

  private chatPost(p: Record<string, any>): Result {
    const ch = this.findChannel(p.channel)
    const statusCard = p.card && typeof p.card === 'object' ? p.card as Record<string, unknown> : null
    if (!p.text && !statusCard) throw new Error('text or card is required')
    const cardText = statusCard && [statusCard.title, statusCard.summary, ...(Array.isArray(statusCard.steps) ? statusCard.steps.map((s: any) => s?.label ?? s) : [])].filter(Boolean).join('\n')
    const questions = Array.isArray(p.questions) ? p.questions.map((q: any) => [q?.question ?? q?.prompt, ...(Array.isArray(q?.options) ? q.options.map((o: any) => o?.label ?? o) : [])].filter(Boolean).join(' ')).join('\n') : ''
    const text = [p.text, cardText, questions].filter(Boolean).join('\n')
    const msg: SimMessage = { id: this.nextId('m'), channel: ch.name, author: this.me, text, at: this.now.toISOString(), ...(p.thread_id ? { threadId: String(p.thread_id) } : {}), ...(p.kind ? { kind: String(p.kind) } : {}) }
    this.messages.push(msg)
    this.linkMentions(msg, p.card)
    if (!this.force) return { ok: true, message_id: msg.id }
    const runs = this.routeMessage(msg, { card: typeof p.card === 'string' ? p.card : undefined })
    return { ok: true, message_id: msg.id, thread_id: msg.threadId ?? msg.id, ...taskFields(runs) }
  }

  private chatDm(p: Record<string, any>): Result {
    const person = this.people.find((x) => x.id === p.user || x.email === p.user || x.name.toLowerCase() === String(p.user).toLowerCase())
    if (!person) throw new Error(`No teammate "${p.user}"`)
    const msg: SimMessage = { id: this.nextId('m'), channel: `dm:${person.id}`, author: this.me, text: String(p.text ?? ''), at: this.now.toISOString() }
    this.messages.push(msg)
    this.linkMentions(msg)
    this.force?.addressed(person, msg.text, { channel: msg.channel })
    return { ok: true, message_id: msg.id }
  }

  private chatSearch(p: Record<string, any>): Result {
    const q = String(p.query ?? '').toLowerCase()
    const words = q.split(/\s+/).filter(Boolean)
    const hits = this.messages.filter((m) => !m.channel.startsWith('dm:') && words.every((w) => m.text.toLowerCase().includes(w)))
    return { ok: true, results: hits.slice(-(Number(p.limit) || 20)).map((m) => ({ id: m.id, channel: m.channel, author: m.author, text: m.text, at: m.at, ...(m.threadId ? { thread_id: m.threadId } : {}) })) }
  }

  /** Card keys mentioned in a post (or its `card` param) link the post to the card, like the API does. */
  private linkMentions(msg: SimMessage, card?: unknown) {
    if (this.arm !== 'A') return
    const keys = new Set([...msg.text.matchAll(/\b([A-Z][A-Z0-9]{1,5})-(\d{1,6})\b/g)].map((m) => `${m[1]}-${m[2]}`))
    if (card) keys.add(String(card).toUpperCase())
    for (const key of keys) {
      const item = this.items.find((i) => i.key === key || i.id === key.toLowerCase())
      if (!item) continue
      const priv = msg.channel.startsWith('dm:') || !!this.channels.find((c) => c.name === msg.channel)?.private
      item.links.push({ kind: 'message', ref: msg.id, channel: msg.channel, snippet: msg.text.slice(0, 120), ...(priv ? { private: true } : {}) })
    }
  }

  private findChannel(ref: unknown): SimChannel {
    const r = String(ref ?? '').replace(/^#/, '').toLowerCase()
    const ch = this.channels.find((c) => c.name.toLowerCase() === r)
    if (!ch) throw new Error(`Channel "${ref}" not found`)
    return ch
  }

  /** Arm B: every card is a top-level message and its comments are thread replies. */
  private cardsToMessages() {
    for (const i of this.items) {
      const b = this.boardOf(i)
      const fields = Object.entries(i.fields).map(([k, v]) => `${k}: ${v}`).join(', ')
      const root: SimMessage = {
        id: `card-${i.key}`,
        channel: b.channel,
        author: i.history.find((e) => e.kind === 'created')?.author ?? 'Intake',
        text: `[${i.key}] ${i.title}${i.description ? `\n${i.description}` : ''}${fields ? `\n(${fields})` : ''}${i.externalRef ? `\nRef: ${i.externalRef}` : ''}\nStatus: ${i.column}${i.priority !== 'none' ? `, priority ${i.priority}` : ''}${this.assigneeName(i) ? `, owner ${this.assigneeName(i)}` : ''}${i.dueAt ? `, due ${i.dueAt.slice(0, 10)}` : ''}`,
        at: i.createdAt,
      }
      this.messages.push(root)
      for (const e of i.history.filter((x) => x.kind === 'comment' || x.kind === 'agent_run')) {
        this.messages.push({ id: this.nextId('m'), channel: b.channel, author: e.author, text: e.text, at: e.at, threadId: root.id })
      }
    }
    this.messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  }

  // ─── External systems ────────────────────────────────────────────────────

  private systemCall(t: SimSystemTool, p: Record<string, any>): Result {
    const sys = this.systems[t.system]
    if (!sys) throw new Error(`${t.system} is not connected`)
    const id = t.idParam ? String(p[t.idParam] ?? p.id ?? '') : ''
    const rec = id ? sys.records.find((r) => String(r.id) === id) : undefined
    switch (t.op) {
      case 'list': {
        const filters = Object.entries(p).filter(([k, v]) => k !== 'input' && k !== 'limit' && v !== undefined && v !== '')
        const rows = sys.records.filter((r) => filters.every(([k, v]) => String(r[k] ?? '').toLowerCase() === String(v).toLowerCase()))
        return { ok: true, data: rows.map(publicRecord) }
      }
      case 'get':
        if (!rec) throw new Error(`${t.system} record ${id} not found`)
        return { ok: true, data: publicRecord(rec) }
      case 'update': {
        if (!rec) throw new Error(`${t.system} record ${id} not found`)
        for (const [k, v] of Object.entries(p)) if (k !== t.idParam && k !== 'input' && v !== undefined) rec[k] = v
        return { ok: true, data: publicRecord(rec) }
      }
      case 'create': {
        const created = { id: this.nextId(t.system), ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'input')) }
        sys.records.push(created)
        return { ok: true, data: created }
      }
      case 'action': {
        if (t.idParam && !rec) throw new Error(`${t.system} record ${id} not found`)
        const target = rec ?? sys.records[0]
        const actions = ((target as any).__actions ??= []) as Array<Record<string, unknown>>
        actions.push({ tool: t.name, at: this.now.toISOString(), ...p })
        return { ok: true, done: t.name }
      }
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-sim-${++this.seq}`
  }
}

/** The `tasks` / `task_ids` a post or comment returns for the agents it handed work to. */
function taskFields(runs: SimRun[]): Record<string, unknown> {
  if (!runs.length) return {}
  return {
    tasks: runs.map((r) => ({ task_id: r.id, title: r.title, status: r.status === 'running' ? 'running' : 'completed' })),
    task_ids: runs.map((r) => r.id),
    hint: 'Each tagged agent works on it in the background. Call wait({ task_ids }) to block on them, or end your turn and you will get a [Task update] when they reply.',
  }
}

function asResult(out: Record<string, unknown>): Result {
  return 'error' in out ? { error: String(out.error), ...(out.code ? { code: String(out.code) } : {}) } : { ok: true, ...out }
}

/** Fields starting with `_` are ground-truth labels: kept for graders, never shown to the agent. */
function publicRecord(r: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')))
}

/** Columns a board gets when none are given; mirrors apps/api work-board-defaults.ts (a test keeps them equal). */
export const DEFAULT_COLUMNS: Record<string, SimColumn[]> = {
  task: [{ name: 'Backlog', category: 'backlog' }, { name: 'In progress', category: 'active' }, { name: 'Review', category: 'review' }, { name: 'Done', category: 'done' }],
  problem: [{ name: 'Detected', category: 'backlog' }, { name: 'Investigating', category: 'active' }, { name: 'In recovery', category: 'active' }, { name: 'Needs attention', category: 'waiting' }, { name: 'Resolved', category: 'done' }, { name: 'Dismissed', category: 'dismissed' }],
  ticket: [{ name: 'New', category: 'backlog' }, { name: 'Open', category: 'active' }, { name: 'Waiting on customer', category: 'waiting' }, { name: 'Solved', category: 'done' }],
  deal: [{ name: 'Lead', category: 'backlog' }, { name: 'Qualified', category: 'active' }, { name: 'Proposal', category: 'active' }, { name: 'Negotiation', category: 'review' }, { name: 'Won', category: 'done' }, { name: 'Lost', category: 'dismissed' }],
  candidate: [{ name: 'Applied', category: 'backlog' }, { name: 'Screen', category: 'active' }, { name: 'Interview', category: 'active' }, { name: 'Offer', category: 'review' }, { name: 'Hired', category: 'done' }, { name: 'Rejected', category: 'dismissed' }],
  approval: [{ name: 'Requested', category: 'backlog' }, { name: 'In review', category: 'review' }, { name: 'Approved', category: 'done' }, { name: 'Rejected', category: 'dismissed' }],
  content: [{ name: 'Ideas', category: 'backlog' }, { name: 'Drafting', category: 'active' }, { name: 'Review', category: 'review' }, { name: 'Scheduled', category: 'waiting' }, { name: 'Published', category: 'done' }],
  custom: [{ name: 'To do', category: 'backlog' }, { name: 'Doing', category: 'active' }, { name: 'Done', category: 'done' }],
}

/** "Support Tickets" -> "ST", "Sales" -> "SAL" (as the API does). */
function keyPrefixFor(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length) return 'CARD'
  if (words.length === 1) return words[0].slice(0, 3)
  return words.slice(0, 4).map((w) => w[0]).join('')
}

function normalizePrefix(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  return /^[A-Z][A-Z0-9]*$/.test(c) ? c : undefined
}

function definedOnly(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).filter(([k, v]) => k !== 'template' && v !== undefined && v !== null && v !== ''))
}

/** Manifest agent key as the API stores it. */
function agentRef(key: string | undefined): string | null {
  if (!key) return null
  return key === 'workspace' ? 'workspace' : `project:${key}`
}

function memberRef(m: { project?: string; group?: string; user?: string } | Record<string, unknown>): string {
  const r = m as { project?: string; group?: string; user?: string }
  return r.project ? `agent:${r.project}` : r.group ? `group:${r.group}` : `user:${r.user}`
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function sameChannel(a: string, b: unknown): boolean {
  return a.toLowerCase() === String(b ?? '').replace(/^#/, '').toLowerCase()
}
