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
}

export const BOARD_SIM_TOOLS = [
  'board_list', 'board_summary', 'board_health',
  'work_item_list', 'work_item_get', 'work_item_create', 'work_item_update', 'work_item_move',
  'work_item_comment', 'work_item_bulk_update', 'work_item_history', 'work_item_link',
] as const
export const ADMIN_SIM_TOOLS = ['board_create', 'board_update', 'board_archive', 'column_create', 'column_update', 'column_delete'] as const
export const CHAT_SIM_TOOLS = ['team_chat_list', 'team_chat_read', 'team_chat_post', 'team_chat_search', 'team_chat_dm', 'team_directory'] as const

type Result = { ok: true; [k: string]: unknown } | { error: string; code?: string }

const CLOSED: Category[] = ['done', 'dismissed']
const HOUR = 3_600_000

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
  }

  /** Tool names this world answers, for the arm. */
  toolNames(): string[] {
    const board = this.arm === 'B' ? [] : [...BOARD_SIM_TOOLS, ...(this.admin ? ADMIN_SIM_TOOLS : [])]
    return [...board, ...CHAT_SIM_TOOLS, ...this.systemTools.map((t) => t.name)]
  }

  /** Board tools hidden from the agent in this arm. */
  hiddenTools(): string[] {
    return this.arm === 'B' ? [...BOARD_SIM_TOOLS] : []
  }

  advance(hours: number): void {
    this.now = new Date(this.now.getTime() + hours * HOUR)
  }

  snapshot(): WorldSnapshot {
    return structuredClone({
      arm: this.arm, me: this.me, now: this.now.toISOString(), boards: this.boards, items: this.items, messages: this.messages,
      channels: this.channels, agents: this.agents, triggers: this.triggers, systems: this.systems, log: this.log,
    })
  }

  handle(tool: string, raw: Record<string, unknown> | undefined): Result {
    const params = (raw ?? {}) as Record<string, any>
    let result: Result
    try {
      result = this.dispatch(tool, params)
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    }
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
      case 'team_directory': return { ok: true, people: this.people.map(({ id, name, email, role, title, timezone, away }) => ({ id, name, email, role, title, timezone, ...(away ? { status: 'away' } : {}) })) }
    }
    const sys = this.systemTools.find((t) => t.name === tool)
    if (sys) return this.systemCall(sys, p)
    return { error: `Unknown tool ${tool}`, code: 'not_found' }
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
    this.items.push(item)
    return { ok: true, item: this.compactItem(item) }
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
    return { ok: true, item: this.compactItem(i) }
  }

  private assign(i: SimItem, p: Record<string, any>) {
    if (p.assignee_user !== undefined) {
      if (p.assignee_user && !this.people.some((x) => x.id === p.assignee_user || x.email === p.assignee_user)) throw new Error(`No person "${p.assignee_user}" in the directory`)
      const person = this.people.find((x) => x.id === p.assignee_user || x.email === p.assignee_user)
      i.assigneeUser = person?.id ?? null
      if (p.assignee_agent === undefined && person) i.assigneeAgent = null
    }
    if (p.assignee_agent !== undefined) { i.assigneeAgent = p.assignee_agent; if (p.assignee_agent && p.assignee_user === undefined) i.assigneeUser = null }
    this.record(i, 'assigned', `assigned to ${this.assigneeName(i) ?? 'nobody'}`)
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
    return { ok: true, item: this.compactItem(i), warnings: [] }
  }

  private itemComment(p: Record<string, any>): Result {
    const i = this.findItem(p.item)
    if (!p.text) throw new Error('text is required')
    this.record(i, 'comment', String(p.text))
    return { ok: true, posted: true }
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

  private record(i: SimItem, kind: SimEvent['kind'], text: string, data?: Record<string, unknown>) {
    i.history.push({ at: this.now.toISOString(), author: this.me, kind, text, ...(data ? { data } : {}) })
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
    if (!p.text) throw new Error('text is required')
    const msg: SimMessage = { id: this.nextId('m'), channel: ch.name, author: this.me, text: String(p.text), at: this.now.toISOString(), ...(p.thread_id ? { threadId: String(p.thread_id) } : {}), ...(p.kind ? { kind: String(p.kind) } : {}) }
    this.messages.push(msg)
    this.linkMentions(msg, p.card)
    return { ok: true, message_id: msg.id }
  }

  private chatDm(p: Record<string, any>): Result {
    const person = this.people.find((x) => x.id === p.user || x.email === p.user || x.name.toLowerCase() === String(p.user).toLowerCase())
    if (!person) throw new Error(`No teammate "${p.user}"`)
    const msg: SimMessage = { id: this.nextId('m'), channel: `dm:${person.id}`, author: this.me, text: String(p.text ?? ''), at: this.now.toISOString() }
    this.messages.push(msg)
    this.linkMentions(msg)
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
